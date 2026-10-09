import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fixture, reset, seed, IDs, update } from "./helpers";
import { open, seal } from "../src/crypto";
import { owner, limit, secureEqual, one } from "../src/core";
import { actor, handle } from "../src/commands";
import { order } from "../src/sales";
import { validatePanelURL } from "../src/adapters/panel";
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
  await f.mf.dispose();
});
describe("credential security", () => {
  it("round trips AES-256-GCM with AAD", async () => {
    const c = await seal(f.env, "secret", "tenant-a");
    expect(c).not.toContain("secret");
    expect(await open(f.env, c, "tenant-a")).toBe("secret");
  });
  it("rejects cross-tenant decryption", async () => {
    await expect(
      open(f.env, await seal(f.env, "secret", "tenant-a"), "tenant-b"),
    ).rejects.toThrow("CREDENTIAL_DECRYPT_FAILED");
  });
  it("rejects modified ciphertext", async () => {
    const c = JSON.parse(await seal(f.env, "secret", "a"));
    c.ct = "AAAA" + c.ct.slice(4);
    await expect(open(f.env, JSON.stringify(c), "a")).rejects.toThrow();
  });
  it("supports a retained old key after rotation", async () => {
    const c = await seal(f.env, "s", "a");
    const env = { ...f.env, KEY_VERSION: "v2" };
    expect(await open(env, c, "a")).toBe("s");
    expect(JSON.parse(await seal(env, "s", "a")).v).toBe("v2");
  });
  it("fails closed without old key", async () => {
    const c = await seal(f.env, "s", "a");
    await expect(
      open({ ...f.env, MASTER_KEYS: "{}" }, c, "a"),
    ).rejects.toThrow();
  });
  it("constant-work comparison rejects different values and lengths", async () => {
    expect(await secureEqual("x", "x")).toBe(true);
    expect(await secureEqual("x", "xx")).toBe(false);
    expect(await secureEqual("a", "b")).toBe(false);
  });
});
describe("tenant authorization", () => {
  it("authorizes the explicit owner", async () => {
    expect(await owner(f.env, IDs.b1, 100)).toBe("t1");
  });
  it("rejects other tenant owner", async () => {
    await expect(owner(f.env, IDs.b1, 200)).rejects.toThrow("FORBIDDEN");
  });
  it.each([
    `/panels`,
    `/report`,
    `/panel_default ${IDs.p1}`,
    `/panel_toggle ${IDs.p1} off`,
    `/panel_delete ${IDs.p1} CONFIRM`,
    `/plan_edit {"id":"${IDs.plan1}","enabled":false}`,
    `/config {"welcome":"hacked"}`,
    `/admin_add 999`,
    `/retry unknown`,
  ])("rejects unauthorized command %s", async (cmd) => {
    await expect(handle(f.env, IDs.b1, update(200, cmd))).rejects.toThrow(
      "FORBIDDEN",
    );
  });
  it("does not reveal another user services", async () => {
    await order(f.env, IDs.b1, 100, IDs.p1, IDs.plan1, "k");
    const s = await one<{ id: string }>(
      f.env,
      "SELECT id FROM services WHERE bot_id=?",
      IDs.b1,
    );
    await expect(
      handle(f.env, IDs.b1, update(300, `/service ${s!.id}`)),
    ).rejects.toThrow("SERVICE_NOT_FOUND");
  });
  it("cannot select another bot panel", async () => {
    await expect(
      handle(f.env, IDs.b1, update(100, `/choose ${IDs.p2}`)),
    ).rejects.toThrow("PANEL_NOT_AVAILABLE");
  });
  it("cannot order a foreign plan", async () => {
    await expect(
      order(f.env, IDs.b1, 100, IDs.p2, IDs.plan2, "k"),
    ).rejects.toThrow("PLAN_NOT_AVAILABLE");
  });
  it("foreign keys reject cross-bot plans", async () => {
    await expect(
      f.env.DB.prepare(
        "INSERT INTO plans(id,bot_id,panel_id,name,inbound_id,bytes,days,price_minor,currency) VALUES('foreign',?,?,'bad',1,100,30,0,'IRR')",
      )
        .bind(IDs.b1, IDs.p2)
        .run(),
    ).rejects.toThrow();
  });
  it("ignores group and forged-user messages", () => {
    const u = update(100, "/start");
    u.message.chat.type = "group";
    expect(actor(u, "factory")).toBe(null);
    u.message.chat.type = "private";
    u.message.from.id = 200;
    expect(actor(u, "factory")).toBe(null);
  });
  it("admin cannot grant other admins; owner can", async () => {
    await f.env.DB.prepare(
      "INSERT INTO tenant_admins VALUES('t1',300,'ADMIN')",
    ).run();
    await expect(
      handle(f.env, IDs.b1, update(300, "/admin_add 400")),
    ).rejects.toThrow("FORBIDDEN");
    await handle(f.env, IDs.b1, update(100, "/admin_add 400"));
    expect(await owner(f.env, IDs.b1, 400)).toBe("t1");
  });
  it("owner cannot remove ownership role", async () => {
    await handle(f.env, IDs.b1, update(100, "/admin_remove 100"));
    expect(await owner(f.env, IDs.b1, 100)).toBe("t1");
  });
  it("enforces bounded atomic rate limits", async () => {
    await limit(f.env, "scope", 2);
    await limit(f.env, "scope", 2);
    await expect(limit(f.env, "scope", 2)).rejects.toThrow("RATE_LIMITED");
  });
});
describe("SSRF protection", () => {
  it("accepts exact administrator-allowlisted HTTPS domain", () => {
    expect(validatePanelURL(f.env, "https://panel.example/path").href).toBe(
      "https://panel.example/path/",
    );
  });
  it.each([
    "http://panel.example",
    "https://localhost",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://evil.example",
    "https://panel.example.evil.test",
    "https://a:secret@panel.example",
    "https://panel.example?secret=x",
    "https://panel.example:8443",
    "https://panel.example/#x",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => validatePanelURL(f.env, url)).toThrow();
  });
});
