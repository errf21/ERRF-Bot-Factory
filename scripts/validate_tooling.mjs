import { spawnSync } from "node:child_process";
for (const args of [
  ["secret", "list", "--format", "json"],
  ["secret", "bulk"],
  ["d1", "migrations", "apply", "DB", "--remote"],
  ["deploy"],
]) {
  const r = spawnSync(
    "./node_modules/.bin/wrangler",
    [...args, "--config", "wrangler.json", "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  if (r.status !== 0)
    throw new Error(`Wrangler flags unsupported for ${args.join(" ")}`);
}
console.log(
  "Installed Wrangler supports all deployment command flags (no remote operations performed).",
);
