import type { Env, Bot, Panel, Service, Update, BotConfig } from "./types";
import { defaultConfig } from "./types";
import {
  failCode,
  assert,
  audit,
  central,
  id,
  integer,
  jsonObject,
  now,
  one,
  owner,
  primaryOwner,
  rows,
  run,
  stmt,
  text,
} from "./core";
import { open, seal } from "./crypto";
import {
  register,
  lifecycle,
  inspectWebhook,
  rotateCredential,
} from "./factory";
import { adapter, validatePanelURL } from "./adapters/panel";
import { order, serviceOperation } from "./sales";
import { telegram, tokenFor } from "./telegram";
import type { Reply } from "./delivery";
import {
  offer,
  checkout,
  orderView,
  beginReceipt,
  submitEvidence,
  reviewView,
  reviewQueue,
  decisionPrompt,
  decide,
  reasonMessage,
  setCard,
  getCard,
  fingerprint,
  type Plan,
  type SalesOrder,
} from "./commerce";
import {
  money,
  bytes as formatBytes,
  date as formatDate,
  state as stateLabel,
} from "./ui";
import { rewrapFinance } from "./recovery";
import { manageSales } from "./management";
interface Actor {
  user: number;
  chat: number;
  command: string;
  args: string;
  key: string;
  messageId: number;
}
export function actor(update: Update, route: string): Actor | null {
  const message = update.message ?? update.callback_query?.message;
  const from = update.callback_query?.from ?? update.message?.from;
  if (
    !message ||
    !message.chat ||
    !from ||
    !Number.isSafeInteger(from.id) ||
    from.id <= 0 ||
    !Number.isSafeInteger(message.chat.id) ||
    !Number.isSafeInteger(message.message_id) ||
    from.is_bot ||
    message.chat.type !== "private" ||
    message.chat.id !== from.id
  )
    return null;
  const commandText = update.callback_query?.data ?? update.message?.text ?? "";
  if (typeof commandText !== "string") return null;
  const [raw, ...args] = commandText.trim().split(/\s+/);
  return {
    user: integer(from.id),
    chat: integer(message.chat.id),
    command: (raw ?? "").replace(/@\w+$/, "").toLowerCase(),
    args: args.join(" "),
    key: `${route}:${update.update_id}`,
    messageId: message.message_id,
  };
}
const reply = (text: string): Reply => ({ text });
const buttons = (
  text: string,
  options: { text: string; callback_data: string }[][],
): Reply => ({ text, reply_markup: { inline_keyboard: options } });
export { config } from "./settings";
import { config } from "./settings";
export async function handle(
  env: Env,
  route: string,
  update: Update,
): Promise<Reply | null> {
  const a = actor(update, route);
  if (!a) return null;
  if (
    a.command === "/register" ||
    a.command === "/panel_add" ||
    a.command === "/panel_edit" ||
    a.command === "/bank_set" ||
    a.command === "/import_config"
  ) {
    try {
      await telegram(await tokenFor(env, route), "deleteMessage", {
        chat_id: a.chat,
        message_id: a.messageId,
      });
    } catch {
      /* Best-effort removal; never echo credentials. */
    }
  }
  if (route !== "factory") {
    assert(
      await one(
        env,
        "SELECT id FROM bots WHERE id=? AND state='ACTIVE'",
        route,
      ),
      "BOT_INACTIVE",
    );
    if (update.message?.photo || update.message?.document)
      return submitEvidence(env, route, a.user, update, a.key);
    if (update.message?.text && !a.command.startsWith("/")) {
      const result = await reasonMessage(
        env,
        route,
        a.user,
        update.message.text,
        a.key,
      );
      if (result) return result;
      return buttons("برای خرید، سفارش‌ها یا پشتیبانی از منو استفاده کنید.", [
        [
          { text: "خرید", callback_data: "/buy" },
          { text: "سفارش‌ها", callback_data: "/orders" },
        ],
        [{ text: "پشتیبانی", callback_data: "/support" }],
      ]);
    }
    if (update.callback_query) {
      try {
        await telegram(
          await tokenFor(env, route),
          "answerCallbackQuery",
          { callback_query_id: update.callback_query.id },
          true,
        );
      } catch {
        /* Durable business processing does not depend on dismissing the spinner. */
      }
    }
  }
  return route === "factory"
    ? factoryCommand(env, a)
    : customerCommand(env, route, a);
}
async function factoryCommand(env: Env, a: Actor): Promise<Reply> {
  const { command: c, args, user } = a;
  if (c === "/start" || c === "/help")
    return reply(
      "کارخانه ERRF\nتوکن BotFather را فقط در گفتگوی خصوصی با /register TOKEN ثبت کنید. پیام توکن به‌صورت بهترین تلاش حذف می‌شود؛ تلگرام گفتگوی رمزنگاری سرتاسری نیست.\n/mybots\n/bot_activate ID\n/bot_deactivate ID\n/bot_repair ID\n/bot_delete ID CONFIRM\n/bot_status ID",
    );
  if (c === "/register") {
    const bot = await register(env, user, args);
    return reply(
      `ربات @${bot.username} فعال شد. شناسه: ${bot.id}\nبرای تنظیم پنل در گفتگوی خصوصی ربات خود /admin را بزنید.`,
    );
  }
  if (c === "/mybots") {
    const bots = await rows(
      env,
      "SELECT b.id,b.username,b.state,b.error_code FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE t.owner_id=? AND b.state!='DELETED'",
      user,
    );
    return reply(JSON.stringify(bots));
  }
  if (c.startsWith("/bot_")) {
    const [botId, confirm] = args.split(" ");
    assert(botId);
    if (c === "/bot_status") {
      await owner(env, botId, user);
      const b = await one(
        env,
        "SELECT id,username,state,error_code FROM bots WHERE id=?",
        botId,
      );
      const w = await inspectWebhook(env, botId);
      return reply(
        JSON.stringify({
          bot: b,
          webhook: {
            pending: w.pending_update_count,
            last_error_date: w.last_error_date ?? null,
          },
        }),
      );
    }
    const action = c.slice(5);
    assert(["activate", "deactivate", "repair", "delete"].includes(action));
    if (action === "delete") assert(confirm === "CONFIRM", "CONFIRM_REQUIRED");
    await lifecycle(
      env,
      user,
      botId,
      action as "activate" | "deactivate" | "repair" | "delete",
    );
    return reply("تنظیم ربات به‌روزرسانی شد.");
  }
  assert(await central(env, user), "FORBIDDEN");
  if (c === "/admin")
    return reply(
      "مدیریت مرکزی\n/bots\n/stats\n/errors\n/audit\n/central_bot ID activate|deactivate|repair|delete [CONFIRM]\n/central_admin add|remove USER_ID\n/global registration_paused true|false\n/rotate_keys ID\n/panel_health BOT_ID",
    );
  if (c === "/bots") {
    const page = args ? integer(Number(args), 0, 1000000) : 0;
    const bs = await rows<Bot>(
      env,
      "SELECT * FROM bots WHERE state!='DELETED' ORDER BY created_at DESC,id LIMIT 11 OFFSET ?",
      page * 10,
    );
    const opts = bs.slice(0, 10).map((b) => [
      {
        text: `@${b.username} | ${b.state}`,
        callback_data: `/central_status ${b.id}`,
      },
    ]);
    if (bs.length > 10)
      opts.push([{ text: "بعدی", callback_data: `/bots ${page + 1}` }]);
    if (page) opts.push([{ text: "قبلی", callback_data: `/bots ${page - 1}` }]);
    return buttons("🤖 ربات‌های ثبت‌شده؛ اطلاعات و اقدامات مرکزی:", opts);
  }
  if (c === "/central_status") {
    const b = await one<Bot>(
      env,
      "SELECT * FROM bots WHERE id=? AND state!='DELETED'",
      text(args, 40),
    );
    assert(b, "BOT_NOT_FOUND");
    return buttons(
      `🤖 @${b.username}\nشناسه: ${b.id}\nوضعیت: ${b.state}\nخطا: ${b.error_code ?? "بدون خطای ثبت‌شده"}\nاعطای دسترسی مدیریتی به ربات: /central_grant ${b.id} NUMERIC_ID\nاین دسترسی صریح، قابل لغو توسط مالک و ثبت‌شده در ممیزی است.`,
      [
        [
          { text: "فعال‌سازی", callback_data: `/central_bot ${b.id} activate` },
          {
            text: "غیرفعال‌سازی",
            callback_data: `/central_bot ${b.id} deactivate`,
          },
        ],
        [
          {
            text: "تعمیر وب‌هوک",
            callback_data: `/central_bot ${b.id} repair`,
          },
        ],
        [{ text: "آمار", callback_data: `/tenant_stats ${b.id}` }],
        [{ text: "بازگشت", callback_data: "/bots" }],
      ],
    );
  }
  if (c === "/central_grant") {
    const [botId, uid] = args.split(" ");
    const b = await one<Bot>(
      env,
      "SELECT * FROM bots WHERE id=? AND state!='DELETED'",
      text(botId, 40),
    );
    assert(b, "BOT_NOT_FOUND");
    const target = integer(Number(uid));
    await env.DB.batch([
      stmt(
        env,
        "INSERT INTO tenant_admins(tenant_id,user_id,role) VALUES(?,?,'ADMIN') ON CONFLICT DO NOTHING",
        b.tenant_id,
        target,
      ),
      stmt(
        env,
        "INSERT INTO audit_logs(id,tenant_id,bot_id,actor_id,action,target_id) VALUES(?,?,?,?,?,?)",
        id(),
        b.tenant_id,
        b.id,
        user,
        "CENTRAL_TENANT_ADMIN_GRANT",
        String(target),
      ),
    ]);
    return reply(
      `دسترسی مدیریتی صریح برای ${target} در @${b.username} ثبت شد. برای رسیدها باید گفتگوی خصوصی همین ربات باز شود؛ تصاویر به ربات کارخانه منتقل نمی‌شوند.`,
    );
  }
  if (c === "/stats")
    return reply(
      JSON.stringify(
        await one(
          env,
          "SELECT (SELECT count(*) FROM bots WHERE state!='DELETED') AS bots,(SELECT count(*) FROM services WHERE state='ACTIVE') AS services,(SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM payments) AS payments,(SELECT count(*) FROM operations WHERE state IN('FAILED','UNKNOWN')) AS failed_operations",
        ),
      ),
    );
  if (c === "/errors")
    return reply(
      JSON.stringify({
        operations: await rows(
          env,
          "SELECT id,bot_id,kind,state,error_code,attempts FROM operations WHERE state IN('UNKNOWN','FAILED') ORDER BY created_at DESC LIMIT 10",
        ),
        updates: await rows(
          env,
          "SELECT route,update_id,state,error_code,attempts FROM webhook_updates WHERE error_code IS NOT NULL ORDER BY created_at DESC LIMIT 10",
        ),
        delivery: await rows(
          env,
          "SELECT id,route,state,error_code,attempts FROM outbox WHERE error_code IS NOT NULL ORDER BY created_at DESC LIMIT 10",
        ),
      }),
    );
  if (c === "/health")
    return reply(
      JSON.stringify({
        database: "reachable",
        pending_updates: await one(
          env,
          "SELECT count(*) AS n FROM webhook_updates WHERE state IN('PENDING','PROCESSING')",
        ),
        pending_operations: await one(
          env,
          "SELECT count(*) AS n FROM operations WHERE state IN('PENDING','PROCESSING','UNKNOWN')",
        ),
        pending_delivery: await one(
          env,
          "SELECT count(*) AS n FROM outbox WHERE state IN('PENDING','PROCESSING')",
        ),
      }),
    );
  if (c === "/central_payments") {
    const target = text(args, 40);
    return reply(
      JSON.stringify(
        await rows(
          env,
          "SELECT r.id,r.order_id,r.state,r.reviewer_id,r.created_at,r.reviewed_at,o.amount_minor,o.currency FROM manual_reviews r JOIN orders o ON o.bot_id=r.bot_id AND o.id=r.order_id WHERE r.bot_id=? ORDER BY r.created_at DESC LIMIT 20",
          target,
        ),
      ),
    );
  }
  if (c === "/tenant_stats") {
    const botId = text(args, 40);
    return reply(
      JSON.stringify({
        orders: await rows(
          env,
          "SELECT state,currency,count(*) AS item_count,sum(amount_minor) AS amount_minor FROM orders WHERE bot_id=? GROUP BY state,currency",
          botId,
        ),
        payments: await rows(
          env,
          "SELECT provider,currency,count(*) AS item_count,sum(amount_minor) AS amount_minor FROM payments WHERE bot_id=? GROUP BY provider,currency",
          botId,
        ),
        services: await rows(
          env,
          "SELECT state,count(*) AS item_count FROM services WHERE bot_id=? GROUP BY state",
          botId,
        ),
      }),
    );
  }
  if (c === "/audit")
    return reply(
      JSON.stringify(
        await rows(
          env,
          "SELECT action,target_id,actor_id,created_at FROM audit_logs ORDER BY created_at DESC LIMIT 30",
        ),
      ),
    );
  if (c === "/panel_health") {
    return reply(
      JSON.stringify(
        await rows(
          env,
          "SELECT id,name,enabled,health,checked_at,error_code FROM panels WHERE bot_id=? LIMIT 50",
          text(args, 40),
        ),
      ),
    );
  }
  if (c === "/central_bot") {
    const [botId, action, confirm] = args.split(" ");
    assert(
      botId &&
        action &&
        ["activate", "deactivate", "repair", "delete"].includes(action),
    );
    if (action === "delete") assert(confirm === "CONFIRM", "CONFIRM_REQUIRED");
    await lifecycle(
      env,
      user,
      botId,
      action as "activate" | "deactivate" | "repair" | "delete",
      true,
    );
    return reply("انجام شد.");
  }
  if (c === "/central_admin") {
    assert(
      env.CENTRAL_ADMIN_IDS.split(",")
        .map((x) => x.trim())
        .includes(String(user)),
      "BOOTSTRAP_ADMIN_REQUIRED",
    );
    const [action, uid] = args.split(" ");
    const target = integer(Number(uid));
    assert(action === "add" || action === "remove");
    if (action === "add")
      await run(
        env,
        "INSERT INTO global_admins(user_id) VALUES(?) ON CONFLICT DO NOTHING",
        target,
      );
    else await run(env, "DELETE FROM global_admins WHERE user_id=?", target);
    await audit(env, user, "CENTRAL_ADMIN_CHANGE", String(target));
    return reply("انجام شد.");
  }
  if (c === "/global") {
    const [key, value] = args.split(" ");
    assert(
      key === "registration_paused" && ["true", "false"].includes(value ?? ""),
    );
    await run(
      env,
      "INSERT INTO global_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      value,
    );
    await audit(env, user, "GLOBAL_SETTING", key);
    return reply("انجام شد.");
  }
  if (c === "/rotate_finance") {
    const result = await rewrapFinance(env, text(args, 40), user);
    return reply(
      `رکوردهای مالی رمزگذاری‌شده با کلید جاری: ${result.rewrapped}\n${result.more ? "دوباره همین دستور را اجرا کنید؛ رکورد قدیمی باقی مانده است." : "در این گروه رکورد قدیمی باقی نمانده است؛ صف‌ها و نسخه‌های پشتیبان را جداگانه بررسی کنید."}`,
    );
  }
  if (c === "/rotate_keys") {
    const b = await one<Bot>(
      env,
      "SELECT * FROM bots WHERE id=? AND state!='DELETED'",
      text(args, 40),
    );
    assert(b, "BOT_NOT_FOUND");
    await rotateCredential(env, b);
    const panels = await rows<Panel>(
      env,
      "SELECT * FROM panels WHERE bot_id=? AND (json_extract(url_enc,'$.v')!=? OR json_extract(credentials_enc,'$.v')!=?) LIMIT 6",
      b.id,
      env.KEY_VERSION,
      env.KEY_VERSION,
    );
    for (const p of panels)
      await run(
        env,
        "UPDATE panels SET url_enc=?,credentials_enc=? WHERE bot_id=? AND id=?",
        await seal(
          env,
          await open(env, p.url_enc, `panel:${p.bot_id}:${p.id}:url`),
          `panel:${p.bot_id}:${p.id}:url`,
        ),
        await seal(
          env,
          await open(
            env,
            p.credentials_enc,
            `panel:${p.bot_id}:${p.id}:credentials`,
          ),
          `panel:${p.bot_id}:${p.id}:credentials`,
        ),
        b.id,
        p.id,
      );
    await audit(env, user, "KEY_REWRAP", b.id, b.tenant_id, b.id);
    return reply(
      "اعتبارنامه ربات و حداکثر ۶ پنل قدیمی با کلید جاری بازنویسی شدند. برای پنل‌های بیشتر، دستور را تکرار کنید. /rotate_finance را برای رکوردهای مالی نیز اجرا کنید. کلید قدیمی را تا تکمیل همه صف‌ها و نسخه‌های پشتیبان حذف نکنید.",
    );
  }
  return reply("دستور ناشناخته. /help یا /admin");
}
async function customerCommand(
  env: Env,
  botId: string,
  a: Actor,
): Promise<Reply> {
  const bot = await one<Bot>(
    env,
    "SELECT * FROM bots WHERE id=? AND state='ACTIVE'",
    botId,
  );
  assert(bot, "BOT_INACTIVE");
  const cfg = await config(env, botId);
  const { command: c, args, user, key } = a;
  await run(
    env,
    "INSERT INTO customers(bot_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING",
    botId,
    user,
  );
  if (c === "/start")
    return buttons(cfg.welcome, [
      [
        { text: cfg.menu_buy, callback_data: "/buy" },
        { text: cfg.menu_services, callback_data: "/services" },
      ],
      [
        { text: "🧾 سفارش‌های من", callback_data: "/orders" },
        { text: "💬 پشتیبانی", callback_data: "/support" },
      ],
    ]);
  if (c === "/support") return reply(cfg.support);
  if (c === "/help") return reply(`${cfg.help}\n${cfg.support}`);
  if (c === "/buy") {
    assert(cfg.sales_enabled, "SALES_DISABLED");
    const page = args ? integer(Number(args), 0, 1000000) : 0;
    let panels = await rows<{ id: string; name: string }>(
      env,
      "SELECT id,name FROM panels WHERE bot_id=? AND enabled=1 ORDER BY is_default DESC,name,id LIMIT 21 OFFSET ?",
      botId,
      page * 20,
    );
    const rule = await one<{ panel_id: string }>(
      env,
      "SELECT panel_id FROM routing_rules WHERE bot_id=? AND customer_id=?",
      botId,
      user,
    );
    if (rule) {
      const p = await one<{ id: string; name: string }>(
        env,
        "SELECT id,name FROM panels WHERE bot_id=? AND id=? AND enabled=1",
        botId,
        rule.panel_id,
      );
      assert(p, "ROUTED_PANEL_UNAVAILABLE");
      panels = [p];
    } else if (cfg.panel_selection === "default") {
      const d = await one<{ id: string; name: string }>(
        env,
        "SELECT id,name FROM panels WHERE bot_id=? AND enabled=1 AND is_default=1",
        botId,
      );
      assert(d, "DEFAULT_PANEL_NOT_AVAILABLE");
      panels = [d];
    }
    const options = panels
      .slice(0, 20)
      .map((p) => [{ text: p.name, callback_data: `/choose ${p.id}` }]);
    if (page > 0)
      options.push([{ text: "قبلی", callback_data: `/buy ${page - 1}` }]);
    if (panels.length > 20)
      options.push([{ text: "بعدی", callback_data: `/buy ${page + 1}` }]);
    return buttons(
      panels.length ? "پنل مقصد را انتخاب کنید:" : "پنلی فعال نیست.",
      options,
    );
  }
  if (c === "/choose") {
    assert(cfg.sales_enabled, "SALES_DISABLED");
    const [panelRaw, pageRaw] = args.split(" ");
    const panelId = text(panelRaw, 40),
      page = pageRaw ? integer(Number(pageRaw), 0, 1000000) : 0;
    assert(
      await one(
        env,
        "SELECT id FROM panels WHERE bot_id=? AND id=? AND enabled=1",
        botId,
        panelId,
      ),
      "PANEL_NOT_AVAILABLE",
    );
    const plans = await rows<{
      id: string;
      name: string;
      price_minor: number;
      currency: string;
      description: string;
    }>(
      env,
      "SELECT id,name,price_minor,currency,description FROM plans WHERE bot_id=? AND panel_id=? AND enabled=1 ORDER BY id LIMIT 21 OFFSET ?",
      botId,
      panelId,
      page * 20,
    );
    const options = plans.slice(0, 20).map((p) => [
      {
        text: `${p.name} · ${p.price_minor} ${p.currency}`,
        callback_data: `/plan ${p.id}`,
      },
    ]);
    if (page > 0)
      options.push([
        { text: "قبلی", callback_data: `/choose ${panelId} ${page - 1}` },
      ]);
    if (plans.length > 20)
      options.push([
        { text: "بعدی", callback_data: `/choose ${panelId} ${page + 1}` },
      ]);
    return buttons(
      plans.length
        ? "طرح را انتخاب کنید. مبلغ در کوچک‌ترین واحد ارز است."
        : "طرحی برای این پنل فعال نیست.",
      options,
    );
  }
  if (c === "/plan" || c === "/purchase") {
    assert(cfg.sales_enabled, "SALES_DISABLED");
    return offer(env, botId, user, text(args, 40));
  }
  if (c === "/checkout") {
    assert(cfg.sales_enabled, "SALES_DISABLED");
    const o = await checkout(env, botId, user, text(args, 40), key);
    return orderView(env, botId, user, o.id);
  }
  if (c === "/order") return orderView(env, botId, user, text(args, 40));
  if (c === "/receipt") return beginReceipt(env, botId, user, text(args, 40));
  if (c === "/cancel_order") {
    const o = await one<SalesOrder>(
      env,
      "SELECT * FROM orders WHERE bot_id=? AND id=? AND customer_id=?",
      botId,
      text(args, 40),
      user,
    );
    assert(o, "ORDER_NOT_FOUND");
    const r = await run(
      env,
      "UPDATE orders SET state='CANCELLED',payment_state='CANCELLED' WHERE bot_id=? AND id=? AND customer_id=? AND state IN('UNCONFIGURED','AWAITING_PAYMENT') AND payment_state IN('UNCONFIGURED','AWAITING_RECEIPT','MORE_EVIDENCE','LEGACY')",
      botId,
      o.id,
      user,
    );
    assert(r.meta.changes > 0, "ORDER_NOT_CANCELLABLE");
    return reply("سفارش پرداخت‌نشده لغو شد.");
  }
  if (c === "/orders") {
    const page = args ? integer(Number(args), 0, 1000000) : 0;
    const os = await rows<SalesOrder>(
      env,
      "SELECT * FROM orders WHERE bot_id=? AND customer_id=? ORDER BY created_at DESC,id LIMIT 11 OFFSET ?",
      botId,
      user,
      page * 10,
    );
    const opts = os.slice(0, 10).map((o) => [
      {
        text: `${o.id.slice(0, 8)} | ${stateLabel(o.state === "AWAITING_PAYMENT" ? o.payment_state : o.state)}`,
        callback_data: `/order ${o.id}`,
      },
    ]);
    if (os.length > 10)
      opts.push([{ text: "بعدی", callback_data: `/orders ${page + 1}` }]);
    if (page)
      opts.push([{ text: "قبلی", callback_data: `/orders ${page - 1}` }]);
    return buttons("🧾 سفارش‌ها و خریدهای شما:", opts);
  }
  if (c === "/services") {
    const page = args ? integer(Number(args), 0, 1000000) : 0;
    const ss = await rows<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND customer_id=? ORDER BY created_at DESC,id LIMIT 11 OFFSET ?",
      botId,
      user,
      page * 10,
    );
    const opts = ss.slice(0, 10).map((v) => [
      {
        text: `${v.id.slice(0, 8)} | ${stateLabel(v.state)}`,
        callback_data: `/service ${v.id}`,
      },
    ]);
    if (ss.length > 10)
      opts.push([{ text: "بعدی", callback_data: `/services ${page + 1}` }]);
    if (page)
      opts.push([{ text: "قبلی", callback_data: `/services ${page - 1}` }]);
    return buttons("📡 سرویس‌های شما:", opts);
  }
  if (c === "/renew_catalog") {
    assert(cfg.sales_enabled, "SALES_DISABLED");
    const [raw, pageRaw] = args.split(" ");
    const serviceId = text(raw, 40),
      page = pageRaw ? integer(Number(pageRaw), 0, 1000000) : 0;
    const v = await one<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND id=? AND customer_id=? AND state='ACTIVE'",
      botId,
      serviceId,
      user,
    );
    assert(v, "SERVICE_NOT_FOUND");
    const ps = await rows<Plan>(
      env,
      "SELECT * FROM plans WHERE bot_id=? AND panel_id=? AND inbound_id=? AND enabled=1 ORDER BY id LIMIT 11 OFFSET ?",
      botId,
      v.panel_id,
      v.inbound_id,
      page * 10,
    );
    const opts = [];
    const inserts = [];
    for (const p of ps.slice(0, 10)) {
      const intent = id().replace(/-/g, "");
      inserts.push(
        stmt(
          env,
          "INSERT INTO purchase_intents(id,bot_id,customer_id,plan_id,panel_id,target_service_id,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?)",
          intent,
          botId,
          user,
          p.id,
          p.panel_id,
          v.id,
          await fingerprint(p),
          now() + 900,
        ),
      );
      opts.push([
        {
          text: `${p.name} · ${money(p.price_minor, p.currency)}`,
          callback_data: `/renew_offer ${intent}`,
        },
      ]);
    }
    if (inserts.length) await env.DB.batch(inserts);
    if (ps.length > 10)
      opts.push([
        {
          text: "بعدی",
          callback_data: `/renew_catalog ${serviceId} ${page + 1}`,
        },
      ]);
    if (page)
      opts.push([
        {
          text: "قبلی",
          callback_data: `/renew_catalog ${serviceId} ${page - 1}`,
        },
      ]);
    return buttons(
      `تمدید سرویس ${serviceId.slice(0, 8)} فقط روی پنل اصلی ${v.panel_id} انجام می‌شود. طرح را انتخاب و جزئیات را تأیید کنید:`,
      opts,
    );
  }
  if (c === "/renew_offer") {
    const intent = await one<{ plan_id: string; target_service_id: string }>(
      env,
      "SELECT plan_id,target_service_id FROM purchase_intents WHERE bot_id=? AND customer_id=? AND id=? AND expires_at>=?",
      botId,
      user,
      text(args, 40),
      now(),
    );
    assert(intent, "CHECKOUT_EXPIRED");
    return offer(env, botId, user, intent.plan_id, intent.target_service_id);
  }
  if (c === "/connect") {
    const s = await one<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND id=? AND customer_id=?",
      botId,
      text(args, 40),
      user,
    );
    assert(s, "SERVICE_NOT_FOUND");
    const p = await one<Panel>(
      env,
      "SELECT * FROM panels WHERE bot_id=? AND id=?",
      botId,
      s.panel_id,
    );
    assert(p, "PANEL_NOT_AVAILABLE");
    return reply(await (await adapter(env, p)).connection(s));
  }
  if (c === "/history") {
    const s = await one(
      env,
      "SELECT id FROM services WHERE bot_id=? AND id=? AND customer_id=?",
      botId,
      text(args, 40),
      user,
    );
    assert(s, "SERVICE_NOT_FOUND");
    return reply(
      JSON.stringify(
        await rows(
          env,
          "SELECT kind,state,payload,created_at,completed_at,error_code FROM operations WHERE bot_id=? AND service_id=? ORDER BY created_at DESC LIMIT 20",
          botId,
          args,
        ),
      ),
    );
  }
  if (c === "/service") {
    const s = await one<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND id=? AND customer_id=?",
      botId,
      text(args, 40),
      user,
    );
    assert(s, "SERVICE_NOT_FOUND");
    const p = await one<Panel>(
      env,
      "SELECT * FROM panels WHERE bot_id=? AND id=?",
      botId,
      s.panel_id,
    );
    assert(p, "PANEL_NOT_AVAILABLE");
    const api = await adapter(env, p);
    const client = await api.find(s);
    assert(client, "SERVICE_MISSING_REMOTE");
    const usage = await api.usage(s.email);
    const used = usage.up + usage.down;
    const remaining =
      usage.total === 0
        ? "نامحدود"
        : formatBytes(Math.max(0, usage.total - used));
    const panelName = p.name;
    return buttons(
      `📡 سرویس ${s.id}\n🎯 پنل اصلی: ${panelName}\nوضعیت پنل: ${usage.enable ? "فعال" : "غیرفعال"}\nمصرف واقعی: ${formatBytes(used)}\nسقف: ${formatBytes(usage.total)}\nباقی‌مانده: ${remaining}\nانقضای واقعی: ${formatDate(Math.floor(usage.expiryTime / 1000))}`,
      [
        [
          { text: "🔗 دریافت اتصال", callback_data: `/connect ${s.id}` },
          { text: "🔄 تمدید", callback_data: `/renew_catalog ${s.id}` },
        ],
        [
          { text: "تاریخچه", callback_data: `/history ${s.id}` },
          { text: "پشتیبانی", callback_data: "/support" },
        ],
      ],
    );
  }
  const tenant = await owner(env, botId, user);
  const managed = await manageSales(env, botId, user, c, args, key);
  if (managed) return managed;
  if (c === "/admin")
    return buttons(
      'مدیریت مالک ERRF\n/panels\n/panel_add {"name":"Main","url":"https://panel.example/path/","username":"...","password":"..."}\n/panel_edit {"id":"...","name":"..."}\n/panel_test ID\n/inbounds ID\n/panel_toggle ID on|off\n/panel_default ID\n/panel_delete ID CONFIRM\n/plans\n/plan_add {"name":"...","panel_id":"...","inbound_id":1,"bytes":1073741824,"days":30,"price_minor":0,"currency":"IRR"}\n/plan_edit {"id":"...","enabled":false}\n/config {"welcome":"..."}\n/display_name NAME\n/admin_add USER_ID\n/admin_remove USER_ID\n/report\n/tenant_audit\n/renew {"id":"SERVICE","days":30}\n/service_update {"id":"SERVICE","bytes":2147483648,"expires_at":1800000000}\n/revoke ID\n/retry OPERATION_ID',
      [
        [
          { text: "🔎 رسیدهای پرداخت", callback_data: "/payments" },
          { text: "💳 کارت مقصد", callback_data: "/bank" },
        ],
        [
          { text: "🖥 پنل‌ها", callback_data: "/panels" },
          { text: "📦 طرح‌ها", callback_data: "/plans" },
        ],
        [
          { text: "📊 گزارش", callback_data: "/report" },
          { text: "راهنمای مدیریت", callback_data: "/manage_help" },
        ],
      ],
    );
  if (c === "/panel_add") {
    const obj = jsonObject(args),
      panelId = await stableId(`${key}:panel`);
    const existing = await one(
      env,
      "SELECT id FROM panels WHERE bot_id=? AND id=?",
      botId,
      panelId,
    );
    if (!existing) {
      const url = validatePanelURL(env, text(obj.url, 500)).href;
      await run(
        env,
        "INSERT INTO panels(id,bot_id,name,adapter,url_enc,credentials_enc) VALUES(?,?,?,?,?,?)",
        panelId,
        botId,
        text(obj.name, 80),
        "sanaei-2.8",
        await seal(env, url, `panel:${botId}:${panelId}:url`),
        await seal(
          env,
          JSON.stringify({
            username: text(obj.username, 128),
            password: text(obj.password, 256),
          }),
          `panel:${botId}:${panelId}:credentials`,
        ),
      );
      await audit(env, user, "PANEL_ADD", panelId, tenant, botId);
    }
    return reply(
      `پنل ثبت شد (اتصال هنوز تأیید نشده): ${panelId}\n/panel_test ${panelId}`,
    );
  }
  if (c === "/panel_edit") {
    const obj = jsonObject(args),
      panelId = text(obj.id, 40);
    const p = await one<Panel>(
      env,
      "SELECT * FROM panels WHERE bot_id=? AND id=?",
      botId,
      panelId,
    );
    assert(p, "PANEL_NOT_FOUND");
    if (obj.url !== undefined)
      p.url_enc = await seal(
        env,
        validatePanelURL(env, text(obj.url, 500)).href,
        `panel:${botId}:${panelId}:url`,
      );
    if (
      obj.username !== undefined ||
      obj.password !== undefined ||
      obj.connection_host !== undefined ||
      obj.connection_port !== undefined ||
      obj.reality_public_key !== undefined
    ) {
      const old = JSON.parse(
        await open(
          env,
          p.credentials_enc,
          `panel:${botId}:${panelId}:credentials`,
        ),
      ) as Record<string, unknown>;
      if (obj.connection_host !== undefined) {
        const host = text(obj.connection_host, 253);
        assert(/^[a-zA-Z0-9.-]+$/.test(host));
        old.connection_host = host;
      }
      if (obj.connection_port !== undefined)
        old.connection_port = integer(obj.connection_port, 1, 65535);
      if (obj.reality_public_key !== undefined) {
        const pk = text(obj.reality_public_key, 43);
        assert(/^[A-Za-z0-9_-]{43}$/.test(pk));
        old.reality_public_key = pk;
      }
      p.credentials_enc = await seal(
        env,
        JSON.stringify({
          ...old,
          username:
            obj.username === undefined ? old.username : text(obj.username, 128),
          password:
            obj.password === undefined ? old.password : text(obj.password, 256),
        }),
        `panel:${botId}:${panelId}:credentials`,
      );
    }
    await run(
      env,
      "UPDATE panels SET name=?,url_enc=?,credentials_enc=?,health='UNTESTED' WHERE bot_id=? AND id=?",
      obj.name === undefined ? p.name : text(obj.name, 80),
      p.url_enc,
      p.credentials_enc,
      botId,
      panelId,
    );
    await audit(env, user, "PANEL_EDIT", panelId, tenant, botId);
    return reply("پنل به‌روزرسانی شد.");
  }
  if (
    [
      "/panel_test",
      "/inbounds",
      "/panel_toggle",
      "/panel_default",
      "/panel_delete",
    ].includes(c)
  ) {
    const [panelId, flag] = args.split(" ");
    assert(panelId);
    const p = await one<Panel>(
      env,
      "SELECT * FROM panels WHERE bot_id=? AND id=?",
      botId,
      panelId,
    );
    assert(p, "PANEL_NOT_FOUND");
    if (c === "/panel_test" || c === "/inbounds") {
      try {
        const list = await (await adapter(env, p)).list();
        await run(
          env,
          "UPDATE panels SET health='OK',error_code=NULL,checked_at=? WHERE bot_id=? AND id=?",
          now(),
          botId,
          p.id,
        );
        return reply(
          JSON.stringify(
            list.map((x) => ({
              id: x.id,
              name: x.remark,
              protocol: x.protocol,
            })),
          ),
        );
      } catch (e) {
        await run(
          env,
          "UPDATE panels SET health='ERROR',error_code=?,checked_at=? WHERE bot_id=? AND id=?",
          failCode(e),
          now(),
          botId,
          p.id,
        );
        throw e;
      }
    }
    if (c === "/panel_toggle") {
      assert(flag === "on" || flag === "off");
      await run(
        env,
        "UPDATE panels SET enabled=? WHERE bot_id=? AND id=?",
        flag === "on" ? 1 : 0,
        botId,
        p.id,
      );
    }
    if (c === "/panel_default") {
      assert(p.enabled, "PANEL_NOT_AVAILABLE");
      await env.DB.batch([
        stmt(env, "UPDATE panels SET is_default=0 WHERE bot_id=?", botId),
        stmt(
          env,
          "UPDATE panels SET is_default=1 WHERE bot_id=? AND id=?",
          botId,
          p.id,
        ),
      ]);
    }
    if (c === "/panel_delete") {
      assert(flag === "CONFIRM", "CONFIRM_REQUIRED");
      assert(
        !(await one(
          env,
          "SELECT id FROM services WHERE bot_id=? AND panel_id=? LIMIT 1",
          botId,
          p.id,
        )) &&
          !(await one(
            env,
            "SELECT id FROM plans WHERE bot_id=? AND panel_id=? LIMIT 1",
            botId,
            p.id,
          )),
        "PANEL_HAS_REFERENCES",
      );
      await run(env, "DELETE FROM panels WHERE bot_id=? AND id=?", botId, p.id);
    }
    await audit(env, user, c.slice(1).toUpperCase(), p.id, tenant, botId);
    return reply("انجام شد.");
  }
  if (c === "/plan_add") {
    const o = jsonObject(args),
      planId = await stableId(`${key}:plan`);
    const panelId = text(o.panel_id, 40);
    assert(
      await one(
        env,
        "SELECT id FROM panels WHERE bot_id=? AND id=?",
        botId,
        panelId,
      ),
      "PANEL_NOT_FOUND",
    );
    const currency = text(o.currency, 3);
    assert(/^[A-Z]{3}$/.test(currency));
    await run(
      env,
      "INSERT INTO plans(id,bot_id,panel_id,name,description,inbound_id,bytes,days,price_minor,currency,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(id) DO NOTHING",
      planId,
      botId,
      panelId,
      text(o.name, 80),
      o.description === undefined ? "" : text(o.description, 500),
      integer(o.inbound_id),
      integer(o.bytes, 1, 10 ** 15),
      integer(o.days, 1, 3650),
      integer(o.price_minor, 0),
      currency,
    );
    await audit(env, user, "PLAN_ADD", planId, tenant, botId);
    return buttons(
      `طرح پیش‌نویس ذخیره شد: ${planId}\nپیش از انتشار، پنل و اطلاعات اتصال بررسی می‌شوند.`,
      [[{ text: "انتشار طرح", callback_data: `/plan_publish ${planId}` }]],
    );
  }
  if (c === "/plan_edit") {
    const o = jsonObject(args),
      planId = text(o.id, 40);
    const p = await one<Record<string, unknown>>(
      env,
      "SELECT * FROM plans WHERE bot_id=? AND id=?",
      botId,
      planId,
    );
    assert(p, "PLAN_NOT_FOUND");
    for (const field of Object.keys(o))
      assert(
        [
          "id",
          "name",
          "description",
          "bytes",
          "days",
          "price_minor",
          "currency",
          "enabled",
        ].includes(field),
      );
    if (o.name !== undefined) p.name = text(o.name, 80);
    if (o.description !== undefined) p.description = text(o.description, 500);
    if (o.bytes !== undefined) p.bytes = integer(o.bytes, 1, 10 ** 15);
    if (o.days !== undefined) p.days = integer(o.days, 1, 3650);
    if (o.price_minor !== undefined) p.price_minor = integer(o.price_minor, 0);
    if (o.currency !== undefined) {
      p.currency = text(o.currency, 3);
      assert(/^[A-Z]{3}$/.test(p.currency as string));
    }
    if (o.enabled !== undefined) {
      assert(typeof o.enabled === "boolean");
      if (o.enabled) {
        await (
          await import("./management")
        ).publishPlan(env, botId, user, planId, false);
      }
      p.enabled = o.enabled ? 1 : 0;
    }
    await run(
      env,
      "UPDATE plans SET name=?,description=?,bytes=?,days=?,price_minor=?,currency=?,enabled=? WHERE bot_id=? AND id=?",
      p.name,
      p.description,
      p.bytes,
      p.days,
      p.price_minor,
      p.currency,
      p.enabled,
      botId,
      planId,
    );
    await audit(env, user, "PLAN_EDIT", planId, tenant, botId);
    return reply("طرح به‌روزرسانی شد.");
  }
  if (c === "/config") {
    const o = jsonObject(args);
    for (const [field, v] of Object.entries(o)) {
      assert(Object.hasOwn(defaultConfig, field));
      if (["sales_enabled", "notifications_enabled"].includes(field))
        assert(typeof v === "boolean");
      else if (field === "language") assert(v === "fa" || v === "en");
      else if (field === "panel_selection")
        assert(v === "choose" || v === "default");
      else text(v, field === "welcome" || field === "help" ? 1000 : 200);
    }
    await run(
      env,
      "UPDATE bot_configs SET config=? WHERE bot_id=?",
      JSON.stringify({ ...cfg, ...o }),
      botId,
    );
    await audit(env, user, "BOT_CONFIG", botId, tenant, botId);
    return reply("تنظیمات ذخیره شد. زبان انگلیسی هنوز ترجمه کامل رابط ندارد.");
  }
  if (c === "/display_name") {
    await telegram(
      await tokenFor(env, botId),
      "setMyName",
      { name: text(args, 64) },
      true,
    );
    await audit(env, user, "TELEGRAM_DISPLAY_NAME", botId, tenant, botId);
    return reply("نام نمایشی تلگرام به‌روزرسانی شد.");
  }
  if (c === "/admin_add" || c === "/admin_remove") {
    await primaryOwner(env, botId, user);
    const uid = integer(Number(args));
    if (c === "/admin_add")
      await run(
        env,
        "INSERT INTO tenant_admins(tenant_id,user_id,role) VALUES(?,?,'ADMIN') ON CONFLICT DO NOTHING",
        tenant,
        uid,
      );
    else
      await run(
        env,
        "DELETE FROM tenant_admins WHERE tenant_id=? AND user_id=? AND role='ADMIN'",
        tenant,
        uid,
      );
    await audit(env, user, "TENANT_ADMIN_CHANGE", String(uid), tenant, botId);
    return reply("انجام شد.");
  }
  if (c === "/report")
    return reply(
      JSON.stringify({
        orders: await rows(
          env,
          "SELECT state,count(*) AS item_count,sum(amount_minor) AS amount_minor,currency FROM orders WHERE bot_id=? GROUP BY state,currency",
          botId,
        ),
        services: await rows(
          env,
          "SELECT state,count(*) AS item_count FROM services WHERE bot_id=? GROUP BY state",
          botId,
        ),
        payments: await rows(
          env,
          "SELECT provider,currency,count(*) AS item_count,sum(amount_minor) AS amount_minor FROM payments WHERE bot_id=? GROUP BY provider,currency",
          botId,
        ),
        operations: await rows(
          env,
          "SELECT id,kind,state,error_code,attempts FROM operations WHERE bot_id=? AND state IN('UNKNOWN','FAILED') LIMIT 20",
          botId,
        ),
      }),
    );
  if (c === "/tenant_audit")
    return reply(
      JSON.stringify(
        await rows(
          env,
          "SELECT action,target_id,actor_id,created_at FROM audit_logs WHERE bot_id=? ORDER BY created_at DESC LIMIT 30",
          botId,
        ),
      ),
    );
  if (c === "/renew" || c === "/service_update" || c === "/revoke") {
    const o = c === "/revoke" ? { id: args } : jsonObject(args);
    const serviceId = text(o.id, 40);
    const s = await one<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND id=?",
      botId,
      serviceId,
    );
    assert(s, "SERVICE_NOT_FOUND");
    const payload: Record<string, unknown> = {};
    if (c === "/renew") {
      const days = integer(o.days, 1, 3650);
      payload.expires_at = Math.max(now(), s.expires_at) + days * 86400;
    }
    if (c === "/service_update") {
      if (o.bytes !== undefined) payload.bytes = integer(o.bytes, 1, 10 ** 15);
      if (o.expires_at !== undefined)
        payload.expires_at = integer(
          o.expires_at,
          now() + 1,
          now() + 3650 * 86400,
        );
      assert(Object.keys(payload).length > 0);
    }
    await serviceOperation(
      env,
      botId,
      serviceId,
      c === "/revoke" ? "REVOKE" : "UPDATE",
      payload,
      key,
    );
    await audit(env, user, c.slice(1).toUpperCase(), serviceId, tenant, botId);
    return reply(
      "عملیات ثبت شد؛ موفقیت تنها پس از بررسی پنل اعلام می‌شود. تمدید فعلی یک اقدام مدیریتی است، نه پرداخت مشتری.",
    );
  }
  if (c === "/retry") {
    const operationId = text(args, 40);
    const op = await one<{ state: string }>(
      env,
      "SELECT state FROM operations WHERE bot_id=? AND id=?",
      botId,
      operationId,
    );
    assert(
      op && (op.state === "UNKNOWN" || op.state === "FAILED"),
      "OPERATION_NOT_RETRYABLE",
    );
    await run(
      env,
      "UPDATE operations SET state='UNKNOWN',attempts=0,next_at=0,error_code=NULL WHERE bot_id=? AND id=?",
      botId,
      operationId,
    );
    await audit(env, user, "OPERATION_RETRY", operationId, tenant, botId);
    return reply(
      "ابتدا وضعیت واقعی پنل بررسی می‌شود؛ سپس عملیات تکرار می‌شود.",
    );
  }
  return reply("دستور ناشناخته. /help یا /admin");
}
async function stableId(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes.slice(0, 16)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
