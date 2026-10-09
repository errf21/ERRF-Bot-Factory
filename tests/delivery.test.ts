import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, reset, seed, IDs, update, telegramResponse } from "./helpers";
import { enqueue, deliver } from "../src/delivery";
import { processUpdates } from "../src/inbox";
import { notifyExpiration } from "../src/expiration";
import { order } from "../src/sales";
import { one, rows, run } from "../src/core";
import { seal, open } from "../src/crypto";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
beforeEach(async () => {
  vi.unstubAllGlobals();
  await reset(f.env);
  await seed(f.env);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await f.mf.dispose();
});
it("outbox deduplicates repeated enqueue and erases sent payload", async () => {
  await enqueue(f.env, "key", IDs.b1, 300, { text: "hello" });
  await enqueue(f.env, "key", IDs.b1, 300, { text: "hello" });
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM outbox"))!.n,
  ).toBe(1);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => telegramResponse()),
  );
  await deliver(f.env);
  expect(
    await one<{ state: string; payload_enc: string }>(
      f.env,
      "SELECT state,payload_enc FROM outbox",
    ),
  ).toEqual({ state: "SENT", payload_enc: "" });
});
it("delivery network failure is bounded and does not expose secrets", async () => {
  await enqueue(f.env, "key", IDs.b1, 300, { text: "hello" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("TEST-PRIVATE-TOKEN");
    }),
  );
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await deliver(f.env);
  expect(
    await one<{ state: string; error_code: string }>(
      f.env,
      "SELECT state,error_code FROM outbox",
    ),
  ).toEqual({ state: "PENDING", error_code: "TELEGRAM_NETWORK_ERROR" });
  expect(JSON.stringify(log.mock.calls)).not.toContain("TEST-PRIVATE-TOKEN");
  log.mockRestore();
});
it("splits long replies without breaking astral Unicode", async () => {
  await enqueue(f.env, "key", IDs.b1, 300, { text: "😀".repeat(4000) });
  const jobs = await rows<{ id: string; payload_enc: string }>(
    f.env,
    "SELECT id,payload_enc FROM outbox ORDER BY id",
  );
  const messages = await Promise.all(
    jobs.map(
      async (j) =>
        JSON.parse(await open(f.env, j.payload_enc, `outbox:${j.id}`)).text,
    ),
  );
  expect(messages.join("")).toBe("😀".repeat(4000));
  expect(messages.every((x) => x.length <= 3500)).toBe(true);
});
it("processes encrypted inbox and records durable reply", async () => {
  const key = `${IDs.b1}:1`;
  await run(
    f.env,
    "INSERT INTO webhook_updates(route,update_id,bot_id,payload_enc) VALUES(?,?,?,?)",
    IDs.b1,
    1,
    IDs.b1,
    await seal(f.env, JSON.stringify(update(300, "/start")), `update:${key}`),
  );
  await processUpdates(f.env);
  expect(
    await one<{ state: string; payload_enc: string }>(
      f.env,
      "SELECT state,payload_enc FROM webhook_updates",
    ),
  ).toEqual({ state: "DONE", payload_enc: "" });
  expect(await one(f.env, "SELECT id FROM outbox")).not.toBe(null);
});
it("recovers a stale inbox lease", async () => {
  const key = `${IDs.b1}:1`;
  await run(
    f.env,
    "INSERT INTO webhook_updates(route,update_id,bot_id,payload_enc,state,lease_until) VALUES(?,?,?,?,'PROCESSING',1)",
    IDs.b1,
    1,
    IDs.b1,
    await seal(f.env, JSON.stringify(update(300, "/start")), `update:${key}`),
  );
  await processUpdates(f.env);
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM webhook_updates"))!
      .state,
  ).toBe("DONE");
});
it("deduplicates expiration notifications against recorded expiry", async () => {
  await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "expired");
  await run(f.env, "UPDATE services SET state='ACTIVE',expires_at=1");
  await notifyExpiration(f.env);
  await notifyExpiration(f.env);
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM outbox"))!.n,
  ).toBe(1);
});
it("honors disabled customer notifications", async () => {
  await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "expired");
  await run(f.env, "UPDATE services SET state='ACTIVE',expires_at=1");
  await run(
    f.env,
    "UPDATE bot_configs SET config=? WHERE bot_id=?",
    JSON.stringify({ notifications_enabled: false }),
    IDs.b1,
  );
  await notifyExpiration(f.env);
  expect(await one(f.env, "SELECT id FROM outbox")).toBe(null);
});
it("deduplicates separate clicks while an order is pending", async () => {
  const a = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "click1");
  const b = await order(f.env, IDs.b1, 300, IDs.p1, IDs.plan1, "click2");
  expect(a.id).toBe(b.id);
});

it("customer delivery does not depend on the factory bot token", async () => {
  await enqueue(f.env, "independent", IDs.b1, 300, { text: "customer reply" });
  const mock = vi.fn(async () => telegramResponse());
  vi.stubGlobal("fetch", mock);
  await deliver({ ...f.env, FACTORY_BOT_TOKEN: "" });
  expect(mock.mock.calls.length).toBe(1);
  expect(String(mock.mock.calls[0]?.[0])).toContain("/bot100001:");
  expect(
    (await one<{ state: string }>(f.env, "SELECT state FROM outbox"))!.state,
  ).toBe("SENT");
});
