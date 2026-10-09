import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { fixture, reset, seed, IDs, getBot, telegramResponse } from "./helpers";
import { register, lifecycle } from "../src/factory";
import { one } from "../src/core";
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
const token = `123456:${"a".repeat(35)}`;
function mock(identity = 123456) {
  return vi.fn(async (input: string | URL | Request) =>
    telegramResponse(
      String(input).endsWith("/getMe")
        ? { id: identity, is_bot: true, username: "newbot" }
        : true,
    ),
  );
}
it("registers, encrypts token, initializes commands and secure webhook", async () => {
  const fetch = mock();
  vi.stubGlobal("fetch", fetch);
  const b = await register(f.env, 100, token);
  expect(b.state).toBe("ACTIVE");
  expect(b.token_enc).not.toContain(token);
  const calls = fetch.mock.calls.map((c) => String(c[0]));
  expect(calls.some((x) => x.endsWith("setWebhook"))).toBe(true);
  expect(calls.some((x) => x.endsWith("setMyCommands"))).toBe(true);
});
it("rejects invalid syntax without contacting Telegram", async () => {
  const fetch = mock();
  vi.stubGlobal("fetch", fetch);
  await expect(register(f.env, 100, "not-token")).rejects.toThrow(
    "INVALID_BOT_TOKEN",
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects a Telegram-invalid token", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 401 }), {
          status: 401,
        }),
    ),
  );
  await expect(register(f.env, 100, token)).rejects.toThrow(
    "TELEGRAM_TOKEN_INVALID",
  );
  expect(await one(f.env, "SELECT id FROM bots WHERE telegram_id=123456")).toBe(
    null,
  );
});
it("rejects another owner even with token possession", async () => {
  vi.stubGlobal("fetch", mock(100001));
  await expect(
    register({ ...f.env, FACTORY_OPEN_REGISTRATION: "true" }, 200, token),
  ).rejects.toThrow("BOT_ALREADY_OWNED");
});
it("duplicate registration recovers the same bot without another tenant", async () => {
  vi.stubGlobal("fetch", mock());
  const a = await register(f.env, 100, token);
  const b = await register(f.env, 100, token);
  expect(a.id).toBe(b.id);
  expect(
    (await one<{ n: number }>(f.env, "SELECT count(*) AS n FROM tenants"))!.n,
  ).toBe(3);
});
it("registration closed for unauthorized users", async () => {
  vi.stubGlobal("fetch", mock());
  await expect(register(f.env, 300, token)).rejects.toThrow(
    "REGISTRATION_CLOSED",
  );
});
it("cannot register the factory bot", async () => {
  await expect(register(f.env, 100, f.env.FACTORY_BOT_TOKEN)).rejects.toThrow(
    "FACTORY_TOKEN_NOT_ALLOWED",
  );
});
it("persists recoverable ERROR on webhook failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input.endsWith("/setWebhook")
        ? new Response(JSON.stringify({ ok: false, error_code: 400 }), {
            status: 400,
          })
        : telegramResponse(
            input.endsWith("/getMe")
              ? { id: 123456, is_bot: true, username: "newbot" }
              : true,
          ),
    ),
  );
  await expect(register(f.env, 100, token)).rejects.toThrow();
  expect(
    (await one<{ state: string }>(
      f.env,
      "SELECT state FROM bots WHERE telegram_id=123456",
    ))!.state,
  ).toBe("ERROR");
});
it("deactivates and reactivates only the selected bot", async () => {
  vi.stubGlobal("fetch", mock());
  await lifecycle(f.env, 100, IDs.b1, "deactivate");
  expect((await getBot(f.env)).state).toBe("INACTIVE");
  expect((await getBot(f.env, IDs.b2)).state).toBe("ACTIVE");
  await lifecycle(f.env, 100, IDs.b1, "activate");
  expect((await getBot(f.env)).state).toBe("ACTIVE");
});
it("delete keeps history but erases bot credentials", async () => {
  vi.stubGlobal("fetch", mock());
  await lifecycle(f.env, 100, IDs.b1, "delete");
  const b = await getBot(f.env);
  expect(b.state).toBe("DELETED");
  expect(b.token_enc).toBe("");
});
it("delete refuses another owner", async () => {
  await expect(lifecycle(f.env, 200, IDs.b1, "delete")).rejects.toThrow(
    "FORBIDDEN",
  );
});
