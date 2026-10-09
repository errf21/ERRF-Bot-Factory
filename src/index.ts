import type { Env, Bot, Update } from "./types";
import {
  AppError,
  assert,
  failCode,
  integer,
  limit,
  now,
  one,
  run,
  secureEqual,
} from "./core";
import { open, seal } from "./crypto";
import { baseURL } from "./telegram";
import { processUpdates } from "./inbox";
import { deliver } from "./delivery";
import { processOperations } from "./operations";
import { recoverExhaustedClaims, retainFinancialEvidence } from "./recovery";
import { notifyExpiration } from "./expiration";
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
async function boundedBody(request: Request): Promise<string> {
  assert(
    Number(request.headers.get("content-length") ?? 0) <= 65536,
    "PAYLOAD_TOO_LARGE",
  );
  const reader = request.body?.getReader();
  assert(reader, "EMPTY_BODY");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new AppError("PAYLOAD_TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(bytes);
}
export async function pump(env: Env) {
  await processUpdates(env, 1);
  await processOperations(env, 1);
  await deliver(env, 2);
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        (url.pathname === "/healthz" || url.pathname === "/readyz")
      ) {
        await one(env, "SELECT 1 AS ok");
        if (url.pathname === "/readyz") {
          baseURL(env);
          const keys = JSON.parse(env.MASTER_KEYS) as Record<string, string>;
          assert(
            keys[env.KEY_VERSION] && atob(keys[env.KEY_VERSION]!).length === 32,
            "KEY_UNAVAILABLE",
          );
        }
        return response({
          status: "ok",
          version: env.BUILD_VERSION ?? "local",
        });
      }
      if (request.method !== "POST")
        return response({ error: "NOT_FOUND" }, 404);
      const route = /^\/telegram\/(factory|[a-f0-9]{32}|[a-f0-9-]{36})$/.exec(
        url.pathname,
      )?.[1];
      if (!route) return response({ error: "NOT_FOUND" }, 404);
      let expected: string;
      let bot: Bot | null = null;
      if (route === "factory") {
        expected = env.FACTORY_WEBHOOK_SECRET;
        assert(expected, "FACTORY_UNCONFIGURED");
      } else {
        bot = await one<Bot>(env, "SELECT * FROM bots WHERE id=?", route);
        if (!bot || ["DELETED", "DELETING"].includes(bot.state))
          return response({ error: "NOT_FOUND" }, 404);
        expected = await open(
          env,
          bot.webhook_secret_enc,
          `bot:${bot.tenant_id}:${bot.id}:webhook`,
        );
      }
      if (
        !(await secureEqual(
          request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
          expected,
        ))
      )
        return response({ error: "UNAUTHORIZED" }, 401);
      if (bot && bot.state === "INACTIVE")
        return response({ accepted: false, reason: "inactive" });
      await limit(env, `webhook:${route}`, 120);
      let update: Update;
      try {
        update = JSON.parse(await boundedBody(request)) as Update;
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError("INVALID_JSON");
      }
      assert(update && typeof update === "object");
      integer(update.update_id, 0);
      const payload = await seal(
        env,
        JSON.stringify(update),
        `update:${route}:${update.update_id}`,
      );
      await run(
        env,
        "INSERT INTO webhook_updates(route,update_id,bot_id,payload_enc) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        route,
        update.update_id,
        bot?.id ?? null,
        payload,
      );
      ctx.waitUntil(
        pump(env).catch((e) =>
          console.error(
            JSON.stringify({ event: "pump_failed", code: failCode(e) }),
          ),
        ),
      );
      return response({ accepted: true });
    } catch (e) {
      const code = failCode(e);
      console.error(JSON.stringify({ event: "request_failed", code }));
      return response(
        { error: code },
        e instanceof AppError
          ? code === "RATE_LIMITED"
            ? 429
            : e.status
          : 503,
      );
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        await recoverExhaustedClaims(env);
        await pump(env); // D1 is authoritative; bounded work respects free-plan subrequest limits.
        if (Math.floor(now() / 60) % 60 === 0) {
          await notifyExpiration(env);
          await retainFinancialEvidence(env);
          await run(
            env,
            "DELETE FROM webhook_updates WHERE state IN('DONE','DEAD') AND created_at<?",
            now() - 7 * 86400,
          );
          await run(
            env,
            "DELETE FROM outbox WHERE state IN('SENT','DEAD') AND created_at<?",
            now() - 7 * 86400,
          );
          await run(
            env,
            "DELETE FROM rate_limits WHERE window<?",
            Math.floor(now() / 60) - 1440,
          );
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
