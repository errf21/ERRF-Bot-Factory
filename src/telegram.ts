import type { Env, Bot } from "./types";
import { AppError, assert } from "./core";
import { open } from "./crypto";
export async function telegram<T>(
  token: string,
  method: string,
  data: Record<string, unknown> = {},
  safe = false,
): Promise<T> {
  const max = safe ? 3 : 1;
  for (let n = 0; n < max; n++) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(8000),
          redirect: "manual",
        },
      );
      if (response.status >= 300 && response.status < 400)
        throw new AppError("TELEGRAM_REDIRECT_DENIED", 502);
      const body = (await response.json()) as {
        ok: boolean;
        result: T;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (body.ok) return body.result;
      if (
        safe &&
        n < max - 1 &&
        (response.status >= 500 || body.error_code === 429)
      ) {
        const delay = Math.min(body.parameters?.retry_after ?? 2 ** n, 3);
        await new Promise((r) => setTimeout(r, delay * 1000));
        continue;
      }
      throw new AppError(
        body.error_code === 401
          ? "TELEGRAM_TOKEN_INVALID"
          : body.error_code === 429
            ? "TELEGRAM_RATE_LIMIT"
            : "TELEGRAM_API_ERROR",
        502,
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (safe && n < max - 1) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** n));
        continue;
      }
      throw new AppError("TELEGRAM_NETWORK_ERROR", 502);
    }
  }
  throw new AppError("TELEGRAM_API_ERROR", 502);
}
export async function tokenFor(env: Env, route: string) {
  if (route === "factory") return env.FACTORY_BOT_TOKEN;
  const bot = await env.DB.prepare("SELECT * FROM bots WHERE id=? AND state!=?")
    .bind(route, "DELETED")
    .first<Bot>();
  assert(bot, "BOT_NOT_FOUND");
  return open(env, bot.token_enc, `bot:${bot.tenant_id}:${bot.id}:token`);
}
export function baseURL(env: Env) {
  const url = new URL(env.PUBLIC_BASE_URL);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "INVALID_PUBLIC_URL",
  );
  return url.origin;
}
export async function configureWebhook(env: Env, bot: Bot, token: string) {
  const sec = await open(
    env,
    bot.webhook_secret_enc,
    `bot:${bot.tenant_id}:${bot.id}:webhook`,
  );
  await telegram(
    token,
    "setMyCommands",
    {
      commands: [
        { command: "start", description: "شروع" },
        { command: "buy", description: "خرید سرویس" },
        { command: "services", description: "سرویس‌های من" },
        { command: "help", description: "راهنما" },
        { command: "admin", description: "مدیریت مالک" },
      ],
    },
    true,
  );
  await telegram(
    token,
    "setWebhook",
    {
      url: `${baseURL(env)}/telegram/${bot.id}`,
      secret_token: sec,
      allowed_updates: ["message", "callback_query"],
      max_connections: 4,
      drop_pending_updates: false,
    },
    true,
  );
}
