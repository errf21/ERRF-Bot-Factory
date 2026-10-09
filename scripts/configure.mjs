import { readFileSync, writeFileSync } from "node:fs";
export function configure(env = process.env) {
  const need = (name) => {
    if (!env[name]) throw new Error(`Missing ${name}`);
    return env[name];
  };
  const account = need("CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/.test(account))
    throw new Error("Invalid CLOUDFLARE_ACCOUNT_ID");
  const db = need("D1_DATABASE_ID");
  if (
    !/^[a-f0-9-]{36}$/.test(db) ||
    db === "00000000-0000-0000-0000-000000000000"
  )
    throw new Error("Invalid D1_DATABASE_ID");
  const url = new URL(need("PUBLIC_BASE_URL"));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.endsWith(".invalid")
  )
    throw new Error("PUBLIC_BASE_URL must be an HTTPS origin");
  const conf = JSON.parse(readFileSync("wrangler.json", "utf8"));
  conf.account_id = account;
  conf.name = env.WORKER_NAME || "errf-bot-factory";
  if (!/^[a-z0-9-]{1,63}$/.test(conf.name))
    throw new Error("Invalid WORKER_NAME");
  conf.d1_databases[0].database_id = db;
  conf.vars.PUBLIC_BASE_URL = url.origin;
  conf.vars.PANEL_ALLOWED_HOSTS = env.PANEL_ALLOWED_HOSTS || "";
  conf.vars.KEY_VERSION = env.KEY_VERSION || "v1";
  conf.vars.FACTORY_OPEN_REGISTRATION =
    env.FACTORY_OPEN_REGISTRATION === "true" ? "true" : "false";
  conf.vars.BUILD_VERSION = env.GITHUB_SHA || env.BUILD_VERSION || "manual";
  writeFileSync(
    "wrangler.production.json",
    JSON.stringify(conf, null, 2) + "\n",
    { mode: 0o600 },
  );
  return conf;
}
if (process.argv[1]?.endsWith("/configure.mjs")) {
  try {
    configure();
    console.log("Production configuration generated.");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
