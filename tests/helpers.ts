import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import type { Env, Bot, Panel } from "../src/types";
import { seal } from "../src/crypto";
export const IDs = {
  b1: "11111111-1111-4111-8111-111111111111",
  b2: "22222222-2222-4222-8222-222222222222",
  p1: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  p2: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  plan1: "cccccccccccccccccccccccccccccccc",
  plan2: "dddddddddddddddddddddddddddddddd",
};
export async function fixture(options: Record<string, unknown> = {}) {
  const bundled = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
    platform: "neutral",
    target: "es2022",
  });
  const bindings = {
    PUBLIC_BASE_URL: "https://factory.example",
    MASTER_KEYS: JSON.stringify({
      v1: btoa("k".repeat(32)),
      v2: btoa("z".repeat(32)),
    }),
    KEY_VERSION: "v1",
    FACTORY_BOT_TOKEN: `900000:${"f".repeat(35)}`,
    FACTORY_WEBHOOK_SECRET: "factory-secret",
    CENTRAL_ADMIN_IDS: "100",
    PANEL_ALLOWED_HOSTS: "panel.example,second.example",
    FACTORY_OPEN_REGISTRATION: "false",
    BUILD_VERSION: "test",
  };
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0]!.text,
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
      bindings,
      ...options,
    }),
  );
  const db = await mf.getD1Database("DB");
  const env = { ...bindings, DB: db } as unknown as Env;
  for (const migration of (await readdir("migrations"))
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const sql = (await readFile(`migrations/${migration}`, "utf8")).replace(
      /^\s*--.*$/gm,
      "",
    );
    for (const part of sql
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean))
      await db.prepare(part).run();
  }
  return { mf, env, db };
}
export async function reset(env: Env) {
  for (const table of [
    "review_sessions",
    "receipt_sessions",
    "purchase_intents",
    "bank_settings",
    "routing_rules",
    "service_notifications",
    "payments",
    "manual_reviews",
    "order_snapshots",
    "operations",
    "services",
    "orders",
    "plans",
    "panels",
    "customers",
    "bot_configs",
    "tenant_admins",
    "audit_logs",
    "webhook_updates",
    "outbox",
    "bots",
    "tenants",
    "global_admins",
    "global_settings",
    "rate_limits",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
}
export async function seed(env: Env) {
  for (const [t, b, uid, tgid] of [
    ["t1", IDs.b1, 100, 100001],
    ["t2", IDs.b2, 200, 100002],
  ] as const) {
    await env.DB.prepare("INSERT INTO tenants(id,owner_id) VALUES(?,?)")
      .bind(t, uid)
      .run();
    await env.DB.prepare(
      "INSERT INTO bots(id,tenant_id,telegram_id,username,token_enc,webhook_secret_enc,state) VALUES(?,?,?,?,?,?,'ACTIVE')",
    )
      .bind(
        b,
        t,
        tgid,
        `bot${tgid}`,
        await seal(env, `${tgid}:${"t".repeat(35)}`, `bot:${t}:${b}:token`),
        await seal(env, `secret-${b}`, `bot:${t}:${b}:webhook`),
      )
      .run();
    await env.DB.prepare("INSERT INTO tenant_admins VALUES(?,?,'OWNER')")
      .bind(t, uid)
      .run();
    await env.DB.prepare(
      "INSERT INTO bot_configs(bot_id,tenant_id) VALUES(?,?)",
    )
      .bind(b, t)
      .run();
  }
  for (const [bot, panel, plan, host] of [
    [IDs.b1, IDs.p1, IDs.plan1, "panel.example"],
    [IDs.b2, IDs.p2, IDs.plan2, "second.example"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO panels(id,bot_id,name,adapter,url_enc,credentials_enc) VALUES(?,?,?,'sanaei-2.8',?,?)",
    )
      .bind(
        panel,
        bot,
        host,
        await seal(env, `https://${host}/path/`, `panel:${bot}:${panel}:url`),
        await seal(
          env,
          JSON.stringify({
            username: "admin",
            password: "example-test-password",
          }),
          `panel:${bot}:${panel}:credentials`,
        ),
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO plans(id,bot_id,panel_id,name,inbound_id,bytes,days,price_minor,currency) VALUES(?,?,?,'1GB',1,1073741824,30,0,'IRR')",
    )
      .bind(plan, bot, panel)
      .run();
  }
}
export function update(user: number, text: string, updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: 10,
      chat: { id: user, type: "private" },
      from: { id: user, is_bot: false },
      text,
    },
  };
}
export function telegramResponse(result: unknown = true) {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { "content-type": "application/json" },
  });
}
export async function getBot(env: Env, bot = IDs.b1) {
  return (await env.DB.prepare("SELECT * FROM bots WHERE id=?")
    .bind(bot)
    .first<Bot>())!;
}
export async function getPanel(env: Env, panel = IDs.p1) {
  return (await env.DB.prepare("SELECT * FROM panels WHERE id=?")
    .bind(panel)
    .first<Panel>())!;
}
