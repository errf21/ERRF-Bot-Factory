import { spawnSync } from "node:child_process";
import { configure } from "./configure.mjs";
if (process.env.ERRF_ALLOW_REMOTE_DEPLOYMENT !== "true") {
  console.error(
    "Remote operations disabled. Explicitly authorize with ERRF_ALLOW_REMOTE_DEPLOYMENT=true only after review.",
  );
  process.exit(1);
}
const config = configure();
function wrangler(args, { capture = false } = {}) {
  const r = spawnSync(
    "./node_modules/.bin/wrangler",
    [...args, "--config", "wrangler.production.json"],
    {
      encoding: "utf8",
      stdio: capture ? "pipe" : "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (r.status !== 0)
    throw new Error(
      `Wrangler ${args.slice(0, 2).join(" ")} failed; no reset or rollback attempted.`,
    );
  return r.stdout;
}
try {
  if (!process.env.CLOUDFLARE_API_TOKEN)
    throw new Error("Missing CLOUDFLARE_API_TOKEN");
  const listed = JSON.parse(
    wrangler(["secret", "list", "--format", "json"], { capture: true }),
  );
  const names = new Set(listed.map((x) => x.name));
  for (const key of [
    "MASTER_KEYS",
    "FACTORY_BOT_TOKEN",
    "FACTORY_WEBHOOK_SECRET",
    "CENTRAL_ADMIN_IDS",
  ])
    if (!names.has(key))
      throw new Error(
        `Runtime secret ${key} absent. Complete one-time bootstrap first.`,
      );
  wrangler(["d1", "migrations", "apply", "DB", "--remote"]);
  wrangler(["deploy"]);
  let healthy = false;
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(`${config.vars.PUBLIC_BASE_URL}/readyz`, {
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      const data = await r.json();
      if (
        r.ok &&
        data.status === "ok" &&
        data.version === config.vars.BUILD_VERSION
      ) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!healthy)
    throw new Error(
      "Post-deploy readiness/version verification failed. Consult docs/OPERATIONS.md; rollback is manual.",
    );
  // An unauthenticated webhook probe must be rejected, never accidentally processed.
  const probe = await fetch(`${config.vars.PUBLIC_BASE_URL}/telegram/factory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"update_id":0}',
    signal: AbortSignal.timeout(5000),
  });
  if (probe.status !== 401)
    throw new Error(`Webhook authentication check failed (${probe.status}).`);
  console.log(
    `Deployment and readiness/authentication checks passed for ${config.vars.BUILD_VERSION}`,
  );
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
