import type { Bot, Env } from "./types";
import {
  assert,
  audit,
  id,
  one,
  run,
  stmt,
  central,
  owner,
  failCode,
} from "./core";
import { open, seal, secret } from "./crypto";
import { configureWebhook, telegram, tokenFor } from "./telegram";
export async function register(
  env: Env,
  user: number,
  token: string,
): Promise<Bot> {
  assert(
    env.FACTORY_OPEN_REGISTRATION === "true" || (await central(env, user)),
    "REGISTRATION_CLOSED",
  );
  const paused = await one<{ value: string }>(
    env,
    "SELECT value FROM global_settings WHERE key=?",
    "registration_paused",
  );
  assert(paused?.value !== "true", "REGISTRATION_CLOSED");
  assert(/^\d{5,20}:[A-Za-z0-9_-]{20,100}$/.test(token), "INVALID_BOT_TOKEN");
  assert(
    token.split(":")[0] !== env.FACTORY_BOT_TOKEN.split(":")[0],
    "FACTORY_TOKEN_NOT_ALLOWED",
  );
  const identity = await telegram<{
    id: number;
    is_bot: boolean;
    username: string;
  }>(token, "getMe", {}, true);
  assert(
    identity.is_bot && typeof identity.username === "string",
    "INVALID_BOT_IDENTITY",
  );
  let bot = await one<Bot>(
    env,
    "SELECT * FROM bots WHERE telegram_id=?",
    identity.id,
  );
  if (bot) {
    const tenant = await one<{ owner_id: number }>(
      env,
      "SELECT owner_id FROM tenants WHERE id=?",
      bot.tenant_id,
    );
    assert(tenant?.owner_id === user, "BOT_ALREADY_OWNED");
    assert(
      bot.state !== "DELETED" && bot.state !== "DELETING",
      "BOT_TOMBSTONED",
    );
    bot.token_enc = await seal(
      env,
      token,
      `bot:${bot.tenant_id}:${bot.id}:token`,
    );
    await run(
      env,
      "UPDATE bots SET token_enc=? WHERE id=?",
      bot.token_enc,
      bot.id,
    );
  } else {
    const tenant = id(),
      botId = id();
    bot = {
      id: botId,
      tenant_id: tenant,
      telegram_id: identity.id,
      username: identity.username,
      token_enc: await seal(env, token, `bot:${tenant}:${botId}:token`),
      webhook_secret_enc: await seal(
        env,
        secret(),
        `bot:${tenant}:${botId}:webhook`,
      ),
      state: "CONFIGURING",
      error_code: null,
    };
    try {
      await env.DB.batch([
        stmt(env, "INSERT INTO tenants(id,owner_id) VALUES(?,?)", tenant, user),
        stmt(
          env,
          "INSERT INTO bots(id,tenant_id,telegram_id,username,token_enc,webhook_secret_enc,state) VALUES(?,?,?,?,?,?,?)",
          bot.id,
          tenant,
          identity.id,
          identity.username,
          bot.token_enc,
          bot.webhook_secret_enc,
          "CONFIGURING",
        ),
        stmt(
          env,
          "INSERT INTO tenant_admins(tenant_id,user_id,role) VALUES(?,?,?)",
          tenant,
          user,
          "OWNER",
        ),
        stmt(
          env,
          "INSERT INTO bot_configs(bot_id,tenant_id) VALUES(?,?)",
          bot.id,
          tenant,
        ),
      ]);
    } catch {
      throw new (await import("./core")).AppError("REGISTRATION_CONFLICT");
    }
  }
  await audit(env, user, "BOT_REGISTER", bot.id, bot.tenant_id, bot.id);
  try {
    await configureWebhook(env, bot, token);
    await run(
      env,
      "UPDATE bots SET state=?,error_code=NULL WHERE id=?",
      "ACTIVE",
      bot.id,
    );
    bot.state = "ACTIVE";
  } catch (error) {
    await run(
      env,
      "UPDATE bots SET state=?,error_code=? WHERE id=?",
      "ERROR",
      failCode(error),
      bot.id,
    );
    throw error;
  }
  return bot;
}
export async function lifecycle(
  env: Env,
  user: number,
  botId: string,
  action: "activate" | "deactivate" | "repair" | "delete",
  global = false,
) {
  if (global) assert(await central(env, user), "FORBIDDEN");
  else await owner(env, botId, user);
  const bot = await one<Bot>(env, "SELECT * FROM bots WHERE id=?", botId);
  assert(bot && bot.state !== "DELETED", "BOT_NOT_FOUND");
  if (action === "delete") {
    const busy = await one(
      env,
      "SELECT id FROM operations WHERE bot_id=? AND state IN ('PENDING','PROCESSING','UNKNOWN') LIMIT 1",
      botId,
    );
    assert(!busy, "BOT_HAS_PENDING_OPERATIONS");
    assert(
      !(await one(
        env,
        "SELECT id FROM orders WHERE bot_id=? AND (payment_state='UNDER_REVIEW' OR (payment_state='APPROVED' AND state!='FULFILLED')) LIMIT 1",
        botId,
      )),
      "BOT_HAS_PAYMENT_OBLIGATIONS",
    );
    assert(
      !(await one(
        env,
        "SELECT id FROM services WHERE bot_id=? AND state='ACTIVE' LIMIT 1",
        botId,
      )),
      "BOT_HAS_ACTIVE_SERVICES",
    );
  }
  const token = await tokenFor(env, botId);
  if (action === "activate" || action === "repair") {
    assert(bot.state !== "DELETING", "BOT_DELETING");
    try {
      await configureWebhook(env, bot, token);
      await run(
        env,
        "UPDATE bots SET state=?,error_code=NULL WHERE id=?",
        "ACTIVE",
        botId,
      );
    } catch (e) {
      await run(
        env,
        "UPDATE bots SET state=?,error_code=? WHERE id=?",
        "ERROR",
        failCode(e),
        botId,
      );
      throw e;
    }
  } else {
    await run(
      env,
      "UPDATE bots SET state=? WHERE id=?",
      action === "delete" ? "DELETING" : "INACTIVE",
      botId,
    );
    await telegram(
      token,
      "deleteWebhook",
      { drop_pending_updates: false },
      true,
    );
    if (action === "delete")
      await env.DB.batch([
        stmt(
          env,
          "UPDATE bots SET state='DELETED',token_enc='',webhook_secret_enc='' WHERE id=?",
          botId,
        ),
        stmt(
          env,
          "UPDATE webhook_updates SET state='DEAD',payload_enc='' WHERE route=? AND state!='DONE'",
          botId,
        ),
        stmt(
          env,
          "UPDATE outbox SET state='DEAD',payload_enc='' WHERE route=? AND state!='SENT'",
          botId,
        ),
      ]);
  }
  await audit(
    env,
    user,
    `BOT_${action.toUpperCase()}`,
    botId,
    bot.tenant_id,
    botId,
  );
}
export async function inspectWebhook(env: Env, botId: string) {
  return telegram<{
    url: string;
    pending_update_count: number;
    last_error_date?: number;
  }>(await tokenFor(env, botId), "getWebhookInfo", {}, true);
}
export async function rotateCredential(env: Env, bot: Bot) {
  const token = await open(
    env,
    bot.token_enc,
    `bot:${bot.tenant_id}:${bot.id}:token`,
  );
  const sec = await open(
    env,
    bot.webhook_secret_enc,
    `bot:${bot.tenant_id}:${bot.id}:webhook`,
  );
  await run(
    env,
    "UPDATE bots SET token_enc=?,webhook_secret_enc=? WHERE id=?",
    await seal(env, token, `bot:${bot.tenant_id}:${bot.id}:token`),
    await seal(env, sec, `bot:${bot.tenant_id}:${bot.id}:webhook`),
    bot.id,
  );
}
