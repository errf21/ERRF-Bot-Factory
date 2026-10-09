import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
it("deployment wrapper uses the verified config-only CLI flags", () => {
  const source = readFileSync("scripts/deploy.mjs", "utf8");
  expect(source).not.toContain("--log-level");
  expect(source).toContain('[...args, "--config", "wrangler.production.json"]');
  const r = spawnSync(
    "./node_modules/.bin/wrangler",
    [
      "secret",
      "list",
      "--format",
      "json",
      "--config",
      "wrangler.json",
      "--help",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
  expect(r.status).toBe(0);
});
it("remote deployment and bootstrap require explicit opt-in before configuration", () => {
  for (const script of ["scripts/deploy.mjs", "scripts/bootstrap.mjs"]) {
    const env = { ...process.env };
    delete env.ERRF_ALLOW_REMOTE_DEPLOYMENT;
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Remote operations disabled");
  }
});
it("CI deployment remains disabled unless repository authorization flag is enabled", () => {
  expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
    "vars.ALLOW_PRODUCTION_DEPLOYMENT == 'true'",
  );
});
