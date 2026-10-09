import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { fixture, reset, seed, IDs } from "./helpers";
import { one, run } from "../src/core";
let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
beforeEach(async () => {
  await reset(f.env);
  await seed(f.env);
});
afterAll(async () => {
  await f.mf.dispose();
});
const webhook = (
  path = IDs.b1,
  secret = `secret-${IDs.b1}`,
  body: unknown = { update_id: 1 },
) =>
  f.mf.dispatchFetch(`https://factory.example/telegram/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify(body),
  });
it("health checks actual D1 and returns build version", async () => {
  const r = await f.mf.dispatchFetch("https://factory.example/healthz");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: "ok", version: "test" });
});
it("readiness checks key and public URL configuration", async () => {
  expect(
    (await f.mf.dispatchFetch("https://factory.example/readyz")).status,
  ).toBe(200);
});
it("rejects webhook with missing or incorrect secret", async () => {
  expect((await webhook(IDs.b1, "wrong")).status).toBe(401);
  expect((await webhook(IDs.b1, "")).status).toBe(401);
});
it("secret for one bot cannot authenticate another", async () => {
  expect((await webhook(IDs.b2, `secret-${IDs.b1}`)).status).toBe(401);
});
it("unknown route returns 404", async () => {
  expect((await webhook("33333333-3333-4333-8333-333333333333")).status).toBe(
    404,
  );
});
it("accepts, durably stores, and deduplicates update", async () => {
  expect((await webhook()).status).toBe(200);
  expect((await webhook()).status).toBe(200);
  expect(
    (await one<{ n: number }>(
      f.env,
      "SELECT count(*) AS n FROM webhook_updates",
    ))!.n,
  ).toBe(1);
});
it("rejects invalid update identifier", async () => {
  expect(
    (await webhook(IDs.b1, `secret-${IDs.b1}`, { update_id: -1 })).status,
  ).toBe(400);
});
it("rejects oversized payload", async () => {
  expect(
    (
      await webhook(IDs.b1, `secret-${IDs.b1}`, {
        update_id: 1,
        padding: "x".repeat(70000),
      })
    ).status,
  ).toBe(400);
});
it("disabled bot acknowledges but does not queue", async () => {
  await run(f.env, "UPDATE bots SET state='INACTIVE' WHERE id=?", IDs.b1);
  expect((await webhook()).status).toBe(200);
  expect(await one(f.env, "SELECT route FROM webhook_updates")).toBe(null);
});
it("deletion denies subsequent webhook requests", async () => {
  await run(f.env, "UPDATE bots SET state='DELETED' WHERE id=?", IDs.b1);
  expect((await webhook()).status).toBe(404);
});
it("exposes no payment confirmation endpoint", async () => {
  expect(
    (
      await f.mf.dispatchFetch("https://factory.example/payments/callback", {
        method: "POST",
      })
    ).status,
  ).toBe(404);
});
