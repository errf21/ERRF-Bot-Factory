import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, reset, seed, IDs } from "./helpers";
import { order, recordVerifiedPayment, serviceOperation } from "../src/sales";
import { processOperations } from "../src/operations";
import { one, run } from "../src/core";
import type { Service } from "../src/types";
import type { Client } from "../src/adapters/panel";
import { UnconfiguredPayment } from "../src/adapters/payment";
let f: Awaited<ReturnType<typeof fixture>>;
let clients: Client[];
let creates: number;
let uncertain: boolean;
let hostCalls: string[];
beforeAll(async () => {
  f = await fixture();
});
beforeEach(async () => {
  await reset(f.env);
  await seed(f.env);
  clients = [];
  creates = 0;
  uncertain = false;
  hostCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      hostCalls.push(url.hostname);
      const path = url.pathname;
      let obj: unknown = null;
      if (path.endsWith("/login"))
        return new Response(JSON.stringify({ success: true, obj: null }), {
          headers: { "set-cookie": "session=test; Secure; HttpOnly" },
        });
      if (path.endsWith("/list"))
        obj = [
          {
            id: 1,
            enable: true,
            protocol: "vless",
            remark: "Main",
            settings: JSON.stringify({ clients }),
          },
        ];
      if (path.endsWith("/addClient")) {
        creates++;
        const data = new URLSearchParams(String(init?.body));
        clients.push(...JSON.parse(data.get("settings")!).clients);
        if (uncertain) throw new Error("network disconnected after commit");
      }
      if (path.includes("/updateClient/")) {
        const data = new URLSearchParams(String(init?.body));
        clients = JSON.parse(data.get("settings")!).clients;
      }
      if (path.includes("/delClient/")) clients = [];
      return new Response(JSON.stringify({ success: true, obj }));
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await f.mf.dispose();
});
async function create() {
  await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "initial");
  return (await one<Service>(
    f.env,
    "SELECT * FROM services WHERE bot_id=?",
    IDs.b1,
  ))!;
}
it("free order persists service and operation atomically", async () => {
  const result = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "x");
  expect(result.state).toBe("PROVISIONING");
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM operations"))!
      .state,
  ).toBe("PENDING");
});
it("deduplicates retried order request", async () => {
  const a = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "x");
  const b = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "x");
  expect(a.id).toBe(b.id);
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM services"))!.n,
  ).toBe(1);
});
it("prevents reuse of request key by another customer", async () => {
  await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "x");
  await expect(
    order(f.env, IDs.b1, 301, IDs.p1, IDs.plan1, "x"),
  ).rejects.toThrow("FORBIDDEN");
});
it("paid plans remain unconfigured and never create services", async () => {
  await run(f.env, "UPDATE plans SET price_minor=1000 WHERE id=?", IDs.plan1);
  const result = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "paid");
  expect(result.state).toBe("UNCONFIGURED");
  expect(await one(f.env, "SELECT id FROM services")).toBe(null);
});
it("unconfigured payment adapter fails closed", async () => {
  await expect(new UnconfiguredPayment().checkout()).rejects.toThrow(
    "PAYMENT_UNCONFIGURED",
  );
  await expect(new UnconfiguredPayment().verify()).rejects.toThrow(
    "PAYMENT_UNCONFIGURED",
  );
});
it("external payment recording is disabled even with matching invoice data", async () => {
  const o = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "x");
  await expect(
    recordVerifiedPayment(f.env, {
      provider: "test",
      eventId: "evt",
      orderId: o.id,
      amountMinor: 1,
      currency: "IRR",
    }),
  ).rejects.toThrow("ONLINE_PAYMENTS_DISABLED");
  await expect(
    recordVerifiedPayment(f.env, {
      provider: "test",
      eventId: "evt",
      orderId: o.id,
      amountMinor: 0,
      currency: "IRR",
    }),
  ).rejects.toThrow("ONLINE_PAYMENTS_DISABLED");
});
it("legacy external confirmation cannot bypass manual administrator review", async () => {
  await run(f.env, "UPDATE plans SET price_minor=500 WHERE id=?", IDs.plan1);
  const o = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "x");
  await run(
    f.env,
    "UPDATE orders SET state='AWAITING_PAYMENT' WHERE id=?",
    o.id,
  );
  const p = {
    provider: "test",
    eventId: "evt",
    orderId: o.id,
    amountMinor: 500,
    currency: "IRR",
  };
  await expect(recordVerifiedPayment(f.env, p)).rejects.toThrow(
    "ONLINE_PAYMENTS_DISABLED",
  );
  await expect(recordVerifiedPayment(f.env, p)).rejects.toThrow(
    "ONLINE_PAYMENTS_DISABLED",
  );
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM payments"))!.n,
  ).toBe(0);
});
it("provisions on selected panel and confirms remote result", async () => {
  const s = await create();
  await processOperations(f.env);
  expect(creates).toBe(1);
  expect(hostCalls.every((h) => h === "panel.example")).toBe(true);
  expect(
    (await one<Service>(f.env, "SELECT * FROM services WHERE id=?", s.id))!
      .state,
  ).toBe("ACTIVE");
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM orders"))!.state,
  ).toBe("FULFILLED");
});
it("reconciles uncertain creation without duplicate service", async () => {
  const s = await create();
  uncertain = true;
  await processOperations(f.env);
  expect(creates).toBe(1);
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM operations"))!
      .state,
  ).toBe("UNKNOWN");
  uncertain = false;
  await run(f.env, "UPDATE operations SET next_at=0");
  await processOperations(f.env);
  expect(creates).toBe(1);
  expect(
    (await one<Service>(f.env, "SELECT * FROM services WHERE id=?", s.id))!
      .state,
  ).toBe("ACTIVE");
});
it("does not fallback to another panel on timeout", async () => {
  await create();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      hostCalls.push(new URL(input).hostname);
      throw new Error("timeout");
    }),
  );
  await processOperations(f.env);
  expect(hostCalls).toEqual(["panel.example"]);
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM operations"))!
      .state,
  ).toBe("UNKNOWN");
});
it("recovers expired processing leases", async () => {
  await create();
  await run(f.env, "UPDATE operations SET state='PROCESSING',lease_until=1");
  await processOperations(f.env);
  expect(creates).toBe(1);
});
it("never processes disabled bots", async () => {
  await create();
  await run(f.env, "UPDATE bots SET state='INACTIVE' WHERE id=?", IDs.b1);
  await processOperations(f.env);
  expect(creates).toBe(0);
});
it("rejects conflicting remote client identity", async () => {
  const s = await create();
  clients = [
    {
      id: "wrong",
      email: s.email,
      enable: true,
      totalGB: s.bytes,
      expiryTime: s.expires_at * 1000,
    },
  ];
  await processOperations(f.env);
  expect(creates).toBe(0);
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM operations"))!
      .state,
  ).toBe("FAILED");
});
it("renews with absolute values and preserves original panel", async () => {
  const s = await create();
  await processOperations(f.env);
  await serviceOperation(
    f.env,
    IDs.b1,
    s.id,
    "UPDATE",
    { expires_at: s.expires_at + 86400 },
    "renew",
  );
  await processOperations(f.env);
  expect(clients[0]!.expiryTime).toBe((s.expires_at + 86400) * 1000);
  expect(hostCalls.every((h) => h === "panel.example")).toBe(true);
});
it("revokes and verifies absence on original panel", async () => {
  const s = await create();
  await processOperations(f.env);
  await serviceOperation(f.env, IDs.b1, s.id, "REVOKE", {}, "revoke");
  await processOperations(f.env);
  expect(clients).toHaveLength(0);
  expect(
    (await one<Service>(f.env, "SELECT * FROM services WHERE id=?", s.id))!
      .state,
  ).toBe("REVOKED");
});
it("rejects overlapping service mutations", async () => {
  const s = await create();
  await processOperations(f.env);
  await serviceOperation(f.env, IDs.b1, s.id, "UPDATE", { bytes: 200 }, "one");
  await expect(
    serviceOperation(f.env, IDs.b1, s.id, "REVOKE", {}, "two"),
  ).rejects.toThrow("SERVICE_BUSY");
});
