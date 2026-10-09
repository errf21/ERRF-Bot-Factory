import { spawnSync } from "node:child_process";
import { configure } from "./configure.mjs";
if (process.env.ERRF_ALLOW_REMOTE_DEPLOYMENT !== "true") {
  console.error(
    "Remote operations disabled. Explicitly authorize with ERRF_ALLOW_REMOTE_DEPLOYMENT=true only after review.",
  );
  process.exit(1);
}
const config = configure();
const names = [
  "MASTER_KEYS",
  "FACTORY_BOT_TOKEN",
  "FACTORY_WEBHOOK_SECRET",
  "CENTRAL_ADMIN_IDS",
];
for (const name of names)
  if (!process.env[name])
    throw new Error(
      `Missing ${name}. Supply through your local secure shell or secret manager, not source control.`,
    );
let keys;
try {
  keys = JSON.parse(process.env.MASTER_KEYS);
} catch {
  throw new Error("Invalid MASTER_KEYS JSON (redacted)");
}
if (Buffer.from(keys[config.vars.KEY_VERSION] || "", "base64").length !== 32)
  throw new Error("MASTER_KEYS must contain current 32-byte base64 AES key");
if (!/^[A-Za-z0-9_-]{32,256}$/.test(process.env.FACTORY_WEBHOOK_SECRET))
  throw new Error("Invalid factory webhook secret");
if (!/^\d+(,\d+)*$/.test(process.env.CENTRAL_ADMIN_IDS))
  throw new Error("Invalid numeric admin IDs");
function wrangler(args, input) {
  const p = spawnSync(
    "./node_modules/.bin/wrangler",
    [...args, "--config", "wrangler.production.json"],
    {
      input,
      stdio: input ? ["pipe", "inherit", "inherit"] : "inherit",
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (p.status !== 0)
    throw new Error(
      `Bootstrap step ${args[0]} failed. No data reset attempted.`,
    );
}
wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
wrangler(["deploy"]); // Inert until secret bindings are installed; readiness fails closed.
wrangler(
  ["secret", "bulk"],
  JSON.stringify(Object.fromEntries(names.map((n) => [n, process.env[n]]))),
);
const r = await fetch(`${config.vars.PUBLIC_BASE_URL}/readyz`, {
  signal: AbortSignal.timeout(8000),
});
if (!r.ok) throw new Error("Bootstrap readiness check failed");
const token = process.env.FACTORY_BOT_TOKEN;
async function telegram(method, data) {
  let r;
  try {
    r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000),
      redirect: "manual",
    });
  } catch {
    throw new Error(`Telegram ${method} network failure (credential redacted)`);
  }
  let body;
  try {
    body = await r.json();
  } catch {
    throw new Error(`Telegram ${method} invalid response`);
  }
  if (!body.ok)
    throw new Error(`Telegram ${method} failed (credential redacted)`);
  return body.result;
}
await telegram("getMe", {});
await telegram("setMyCommands", {
  commands: [
    { command: "start", description: "ERRF کارخانه ربات" },
    { command: "register", description: "ثبت ربات" },
    { command: "mybots", description: "ربات‌های من" },
    { command: "admin", description: "مدیریت مرکزی" },
  ],
});
const url = `${config.vars.PUBLIC_BASE_URL}/telegram/factory`;
await telegram("setWebhook", {
  url,
  secret_token: process.env.FACTORY_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query"],
  max_connections: 4,
  drop_pending_updates: false,
});
const webhook = await telegram("getWebhookInfo", {});
if (webhook.url !== url) throw new Error("Factory webhook verification failed");
console.log("Bootstrap and factory webhook registration verified.");
