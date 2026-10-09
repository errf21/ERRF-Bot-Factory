import type { Env } from "./types";
export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export function assert(value: unknown, code = "INVALID_INPUT"): asserts value {
  if (!value) throw new AppError(code);
}
export function integer(
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  assert(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= min &&
      value <= max,
  );
  return value;
}
export function text(value: unknown, max = 1000): string {
  assert(typeof value === "string" && value.length > 0 && value.length <= max);
  return value;
}
export function jsonObject(value: string): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = JSON.parse(value);
  } catch {
    throw new AppError("INVALID_JSON");
  }
  assert(obj && typeof obj === "object" && !Array.isArray(obj));
  return obj as Record<string, unknown>;
}
export function failCode(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}
export function stmt(
  env: Env,
  sql: string,
  ...args: unknown[]
): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...args);
}
export async function one<T>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  return stmt(env, sql, ...args).first<T>();
}
export async function rows<T>(
  env: Env,
  sql: string,
  ...args: unknown[]
): Promise<T[]> {
  return (await stmt(env, sql, ...args).all<T>()).results;
}
export async function run(env: Env, sql: string, ...args: unknown[]) {
  return stmt(env, sql, ...args).run();
}
export async function audit(
  env: Env,
  actor: number,
  action: string,
  target: string,
  tenant: string | null = null,
  bot: string | null = null,
) {
  await run(
    env,
    "INSERT INTO audit_logs(id,tenant_id,bot_id,actor_id,action,target_id) VALUES(?,?,?,?,?,?)",
    id(),
    tenant,
    bot,
    actor,
    action,
    target,
  );
}
export async function central(env: Env, user: number) {
  return (
    env.CENTRAL_ADMIN_IDS.split(",")
      .map((x) => x.trim())
      .includes(String(user)) ||
    !!(await one(
      env,
      "SELECT user_id FROM global_admins WHERE user_id=?",
      user,
    ))
  );
}
export async function owner(env: Env, botId: string, user: number) {
  const bot = await one<{ tenant_id: string }>(
    env,
    "SELECT b.tenant_id FROM bots b JOIN tenant_admins a ON a.tenant_id=b.tenant_id WHERE b.id=? AND a.user_id=? AND b.state!=?",
    botId,
    user,
    "DELETED",
  );
  assert(bot, "FORBIDDEN");
  return bot.tenant_id;
}
export async function primaryOwner(env: Env, botId: string, user: number) {
  const b = await one<{ tenant_id: string }>(
    env,
    "SELECT b.tenant_id FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE b.id=? AND t.owner_id=?",
    botId,
    user,
  );
  assert(b, "FORBIDDEN");
  return b.tenant_id;
}
export async function limit(
  env: Env,
  scope: string,
  max: number,
  seconds = 60,
) {
  const window = Math.floor(now() / seconds);
  const item = await one<{ hits: number }>(
    env,
    "INSERT INTO rate_limits(scope,window,hits) VALUES(?,?,1) ON CONFLICT(scope) DO UPDATE SET window=excluded.window,hits=CASE WHEN rate_limits.window=excluded.window THEN rate_limits.hits+1 ELSE 1 END RETURNING hits",
    scope,
    window,
  );
  assert(item && item.hits <= max, "RATE_LIMITED");
}
export async function secureEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xx = new Uint8Array(x),
    yy = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xx.length; i++) diff |= xx[i]! ^ yy[i]!;
  return diff === 0;
}
