import { expect, it } from "vitest";
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
it("fails closed without environment-specific deployment configuration", () => {
  const result = spawnSync(process.execPath, ["scripts/configure.mjs"], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Missing CLOUDFLARE_ACCOUNT_ID");
});
it("generates production binding config without writing secrets", () => {
  const temp = mkdtempSync(join(tmpdir(), "errf-config-"));
  try {
    copyFileSync("wrangler.json", join(temp, "wrangler.json"));
    const r = spawnSync(process.execPath, [resolve("scripts/configure.mjs")], {
      cwd: temp,
      encoding: "utf8",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
        D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
        PUBLIC_BASE_URL: "https://factory.example",
        CLOUDFLARE_API_TOKEN: "NOT-A-REAL-SECRET",
      },
    });
    expect(r.status).toBe(0);
    const output = readFileSync(join(temp, "wrangler.production.json"), "utf8");
    expect(output).not.toContain("NOT-A-REAL-SECRET");
    expect(JSON.parse(output).vars.PUBLIC_BASE_URL).toBe(
      "https://factory.example",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
