import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, reset, seed, IDs, update, telegramResponse } from "./helpers";
import { handle } from "../src/commands";
import { importConfig, publishPlan, parseConnection } from "../src/management";
import { seal } from "../src/crypto";
import { run, one } from "../src/core";
import type { Service } from "../src/types";
let f: Awaited<ReturnType<typeof fixture>>;
let mutations: number;
const cid = "55555555-5555-4555-8555-555555555555";
beforeAll(async () => {
  f = await fixture();
});
beforeEach(async () => {
  await reset(f.env);
  await seed(f.env);
  mutations = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (raw: string | URL, init?: RequestInit) => {
      const input = String(raw);
      if (input.includes("api.telegram.org")) return telegramResponse();
      if (input.endsWith("/login"))
        return new Response('{"success":true,"obj":null}', {
          headers: { "set-cookie": "s=x" },
        });
      if (input.endsWith("/list"))
        return new Response(
          JSON.stringify({
            success: true,
            obj: [
              {
                id: 1,
                enable: true,
                protocol: "vless",
                remark: "Managed",
                port: 443,
                streamSettings: '{"network":"tcp","security":"tls"}',
                settings: JSON.stringify({
                  clients: [
                    {
                      id: cid,
                      email: "existing-client",
                      totalGB: 1000000000,
                      expiryTime: 1800000000000,
                      enable: true,
                    },
                  ],
                }),
              },
            ],
          }),
        );
      mutations++;
      return new Response('{"success":true,"obj":null}');
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await f.mf.dispose();
});
it("new plans are drafts and publishing verifies target inbound plus connection configuration", async () => {
  await handle(
    f.env,
    IDs.b1,
    update(
      100,
      `/plan_add {"name":"Draft","panel_id":"${IDs.p1}","inbound_id":1,"bytes":1000,"days":30,"price_minor":100,"currency":"IRR"}`,
    ),
  );
  const p = (await one<{ id: string; enabled: number }>(
    f.env,
    "SELECT id,enabled FROM plans WHERE name=?",
    "Draft",
  ))!;
  expect(p.enabled).toBe(0);
  await expect(publishPlan(f.env, IDs.b1, 100, p.id)).rejects.toThrow(
    "CONNECTION_HOST_UNCONFIGURED",
  );
  await run(
    f.env,
    "UPDATE panels SET credentials_enc=? WHERE id=?",
    await seal(
      f.env,
      JSON.stringify({
        username: "admin",
        password: "TEST-ONLY",
        connection_host: "edge.example",
      }),
      `panel:${IDs.b1}:${IDs.p1}:credentials`,
    ),
    IDs.p1,
  );
  await publishPlan(f.env, IDs.b1, 100, p.id);
  expect(
    (await one<{ enabled: number }>(
      f.env,
      "SELECT enabled FROM plans WHERE id=?",
      p.id,
    ))!.enabled,
  ).toBe(1);
});
it("imports only a verified existing remote client and remains idempotent", async () => {
  const input = {
    panel_id: IDs.p1,
    inbound_id: 1,
    customer_id: 300,
    uri: `vless://${cid}@edge.example:443?security=tls`,
  };
  await importConfig(f.env, IDs.b1, 100, input, "import-key");
  await importConfig(f.env, IDs.b1, 100, input, "import-key");
  expect(mutations).toBe(0);
  const s = (await one<Service>(f.env, "SELECT * FROM services"))!;
  expect(s.client_id).toBe(cid);
  expect(s.customer_id).toBe(300);
  expect(s.panel_id).toBe(IDs.p1);
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM services"))!.n,
  ).toBe(1);
});
it("does not import a forged or missing remote identity", async () => {
  await expect(
    importConfig(
      f.env,
      IDs.b1,
      100,
      {
        panel_id: IDs.p1,
        inbound_id: 1,
        customer_id: 300,
        uri: "vless://66666666-6666-4666-8666-666666666666@edge.example:443",
      },
      "missing",
    ),
  ).rejects.toThrow("SERVICE_MISSING_REMOTE");
  expect(await one(f.env, "SELECT id FROM services")).toBe(null);
});
it("cross-tenant import is denied before any upstream request", async () => {
  await expect(
    importConfig(
      f.env,
      IDs.b1,
      200,
      {
        panel_id: IDs.p1,
        inbound_id: 1,
        customer_id: 300,
        uri: `vless://${cid}@edge.example:443`,
      },
      "x",
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(mutations).toBe(0);
});
it("connection importer rejects unsupported URL protocols and invalid IDs", () => {
  expect(() => parseConnection("https://evil.example")).toThrow(
    "CONNECTION_IMPORT_UNSUPPORTED",
  );
  expect(() => parseConnection("vless://invalid@host:443")).toThrow(
    "INVALID_CLIENT_ID",
  );
});
it("disabled route is explicit and never selects another panel", async () => {
  await handle(
    f.env,
    IDs.b1,
    update(100, `/route_add {"customer_id":300,"panel_id":"${IDs.p1}"}`),
  );
  await run(f.env, "UPDATE panels SET enabled=0 WHERE id=?", IDs.p1);
  await expect(handle(f.env, IDs.b1, update(300, "/buy"))).rejects.toThrow(
    "ROUTED_PANEL_UNAVAILABLE",
  );
});

it("central delegation is explicit, authenticated, tenant-scoped and audited", async () => {
  await expect(handle(f.env, IDs.b2, update(100, "/admin"))).rejects.toThrow(
    "FORBIDDEN",
  );
  await expect(
    handle(f.env, "factory", update(200, `/central_grant ${IDs.b2} 100`)),
  ).rejects.toThrow("FORBIDDEN");
  await handle(f.env, "factory", update(100, `/central_grant ${IDs.b2} 100`));
  const menu = await handle(f.env, IDs.b2, update(100, "/admin"));
  expect(menu!.text).toContain("مدیریت");
  expect(
    await one(
      f.env,
      "SELECT id FROM audit_logs WHERE action='CENTRAL_TENANT_ADMIN_GRANT' AND bot_id=?",
      IDs.b2,
    ),
  ).not.toBe(null);
});
it("panel and plan management screens use actionable scoped buttons", async () => {
  const panels = await handle(f.env, IDs.b1, update(100, "/panels"));
  expect(JSON.stringify(panels!.reply_markup)).toContain(
    `/panel_view ${IDs.p1}`,
  );
  expect(JSON.stringify(panels!.reply_markup)).not.toContain(IDs.p2);
  const plans = await handle(f.env, IDs.b1, update(100, "/plans"));
  expect(JSON.stringify(plans!.reply_markup)).toContain(
    `/plan_manage ${IDs.plan1}`,
  );
});
it("exhausted crashed provisioning lease becomes visible UNKNOWN rather than stuck PROCESSING", async () => {
  const { createOrder } = await import("../src/commerce");
  const { recoverExhaustedClaims } = await import("../src/recovery");
  await createOrder(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "lease");
  await run(
    f.env,
    "UPDATE operations SET state='PROCESSING',attempts=5,lease_until=1",
  );
  await recoverExhaustedClaims(f.env);
  expect(
    await one<{ state: string; error_code: string }>(
      f.env,
      "SELECT state,error_code FROM operations",
    ),
  ).toEqual({ state: "UNKNOWN", error_code: "LEASE_EXHAUSTED" });
});
it("Telegram redirects are rejected without forwarding the bot credential", async () => {
  const { telegram } = await import("../src/telegram");
  const network = vi.fn(
    async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
  );
  vi.stubGlobal("fetch", network);
  await expect(telegram("FAKE-TEST-TOKEN", "getMe", {}, true)).rejects.toThrow(
    "TELEGRAM_REDIRECT_DENIED",
  );
  expect(network).toHaveBeenCalledTimes(1);
  expect((network.mock.calls[0] as any)[1].redirect).toBe("manual");
});
