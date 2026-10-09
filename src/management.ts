import type { Env, Panel, Service } from "./types";
import {
  assert,
  owner,
  integer,
  text,
  jsonObject,
  one,
  rows,
  run,
  stmt,
  id,
  now,
  audit,
} from "./core";
import { adapter } from "./adapters/panel";
import { open } from "./crypto";
import {
  connectionURI,
  type ConnectionOptions,
  type TransportInbound,
} from "./connections";
import {
  setCard,
  getCard,
  reviewView,
  reviewQueue,
  decisionPrompt,
  decide,
  orderView,
  type Plan,
} from "./commerce";
import { buttons, reply, money, state } from "./ui";
import type { Reply } from "./delivery";
export async function publishPlan(
  env: Env,
  bot: string,
  user: number,
  planId: string,
  commit = true,
) {
  await owner(env, bot, user);
  const p = await one<Plan>(
    env,
    "SELECT * FROM plans WHERE bot_id=? AND id=?",
    bot,
    planId,
  );
  assert(p, "PLAN_NOT_FOUND");
  const panel = await one<Panel>(
    env,
    "SELECT * FROM panels WHERE bot_id=? AND id=? AND enabled=1",
    bot,
    p.panel_id,
  );
  assert(panel, "PANEL_NOT_AVAILABLE");
  const inbound = (await (await adapter(env, panel)).list()).find(
    (x) => x.id === p.inbound_id,
  );
  assert(inbound, "INBOUND_UNAVAILABLE");
  const credentials = JSON.parse(
    await open(
      env,
      panel.credentials_enc,
      `panel:${bot}:${panel.id}:credentials`,
    ),
  ) as ConnectionOptions;
  connectionURI(
    inbound as TransportInbound,
    {
      id: "00000000-0000-4000-8000-000000000001",
      email: "validation-only",
      totalGB: p.bytes,
      expiryTime: 1,
      enable: true,
    },
    credentials,
  );
  if (commit) {
    await run(
      env,
      "UPDATE plans SET enabled=1 WHERE bot_id=? AND id=?",
      bot,
      p.id,
    );
    await audit(env, user, "PLAN_PUBLISH", p.id, null, bot);
  }
  return buttons(
    `✅ طرح ${p.name} منتشر شد.\n🎯 پنل مقصد: ${panel.name}\nمبلغ: ${money(p.price_minor, p.currency)}`,
    [[{ text: "فهرست طرح‌ها", callback_data: "/plans" }]],
  );
}
export async function manageSales(
  env: Env,
  bot: string,
  user: number,
  c: string,
  args: string,
  key: string,
): Promise<Reply | null> {
  const tenant = await owner(env, bot, user);
  if (c === "/panels") {
    const page = args ? integer(Number(args), 0, 1000000) : 0;
    const ps = await rows<Panel & { health: string }>(
      env,
      "SELECT * FROM panels WHERE bot_id=? ORDER BY name,id LIMIT 11 OFFSET ?",
      bot,
      page * 10,
    );
    const opts = ps.slice(0, 10).map((p) => [
      {
        text: `${p.enabled ? "🟢" : "⚪"} ${p.name}${p.is_default ? " ⭐" : ""} | ${p.health}`,
        callback_data: `/panel_view ${p.id}`,
      },
    ]);
    if (ps.length > 10)
      opts.push([{ text: "بعدی", callback_data: `/panels ${page + 1}` }]);
    if (page)
      opts.push([{ text: "قبلی", callback_data: `/panels ${page - 1}` }]);
    return buttons(
      '🖥 پنل‌های ربات جاری\nافزودن: /panel_add {"name":"...","url":"https://HOST/PATH/","username":"...","password":"..."}\nاعتبارنامه‌ها هرگز در فهرست نمایش داده نمی‌شوند.',
      opts,
    );
  }
  if (c === "/panel_view") {
    const p = await one<
      Panel & {
        health: string;
        error_code: string | null;
        checked_at: number | null;
      }
    >(env, "SELECT * FROM panels WHERE bot_id=? AND id=?", bot, text(args, 40));
    assert(p, "PANEL_NOT_FOUND");
    return buttons(
      `🖥 ${p.name}\nشناسه: ${p.id}\nآداپتر: ${p.adapter}\nوضعیت: ${p.enabled ? "فعال" : "غیرفعال"} | پیش‌فرض: ${p.is_default ? "بله" : "خیر"}\nآخرین تست: ${p.health} | ${p.error_code ?? "بدون خطای ثبت‌شده"}\nویرایش: /panel_edit {"id":"${p.id}","name":"...","connection_host":"HOST"}`,
      [
        [
          { text: "تست اتصال", callback_data: `/panel_test ${p.id}` },
          { text: "این‌باندها", callback_data: `/inbounds ${p.id}` },
        ],
        [
          { text: "انتخاب پیش‌فرض", callback_data: `/panel_default ${p.id}` },
          {
            text: p.enabled ? "غیرفعال کردن" : "فعال کردن",
            callback_data: `/panel_toggle ${p.id} ${p.enabled ? "off" : "on"}`,
          },
        ],
        [
          {
            text: "حذف امن با تأیید",
            callback_data: `/panel_delete ${p.id} CONFIRM`,
          },
          { text: "بازگشت", callback_data: "/panels" },
        ],
      ],
    );
  }
  if (c === "/plans") {
    const page = args ? integer(Number(args), 0, 1000000) : 0;
    const ps = await rows<Plan>(
      env,
      "SELECT * FROM plans WHERE bot_id=? ORDER BY id LIMIT 11 OFFSET ?",
      bot,
      page * 10,
    );
    const opts = ps.slice(0, 10).map((p) => [
      {
        text: `${p.enabled ? "🟢" : "📝"} ${p.name} | ${money(p.price_minor, p.currency)}`,
        callback_data: `/plan_manage ${p.id}`,
      },
    ]);
    if (ps.length > 10)
      opts.push([{ text: "بعدی", callback_data: `/plans ${page + 1}` }]);
    if (page)
      opts.push([{ text: "قبلی", callback_data: `/plans ${page - 1}` }]);
    return buttons(
      '📦 طرح‌ها؛ طرح جدید ابتدا پیش‌نویس است.\n/plan_add {"name":"...","panel_id":"ID","inbound_id":1,"bytes":1073741824,"days":30,"price_minor":10000,"currency":"IRR"}',
      opts,
    );
  }
  if (c === "/plan_manage") {
    const p = await one<Plan>(
      env,
      "SELECT * FROM plans WHERE bot_id=? AND id=?",
      bot,
      text(args, 40),
    );
    assert(p, "PLAN_NOT_FOUND");
    const panel = await one<{ name: string }>(
      env,
      "SELECT name FROM panels WHERE bot_id=? AND id=?",
      bot,
      p.panel_id,
    );
    return buttons(
      `📦 ${p.name}\n${p.description}\nپنل مقصد: ${panel?.name ?? p.panel_id}\nقیمت: ${money(p.price_minor, p.currency)}\nوضعیت: ${p.enabled ? "منتشرشده" : "پیش‌نویس / غیرفعال"}\nویرایش: /plan_edit {"id":"${p.id}","price_minor":10000}`,
      [
        [{ text: "بررسی و انتشار", callback_data: `/plan_publish ${p.id}` }],
        [{ text: "طرح‌ها", callback_data: "/plans" }],
      ],
    );
  }
  if (c === "/bank_set") return setCard(env, bot, user, args);
  if (c === "/bank") {
    const card = await getCard(env, bot);
    return reply(
      card
        ? `💳 کارت فعال: **** ${card.card_number.slice(-4)}\nگیرنده: ${card.recipient_name}\nتنظیم کارت مقصد با /bank_set {"card_number":"شماره ۱۶ رقمی","recipient_name":"نام گیرنده","instructions":"راهنمای انتقال","enabled":true}\nPIN، رمز یا کد بانکی ارسال نکنید.`
        : 'کارت مقصد فعال نیست.\n/bank_set {"card_number":"شماره ۱۶ رقمی","recipient_name":"نام گیرنده","instructions":"راهنمای انتقال","enabled":true}\nاین تنظیم فقط کارت گیرنده است؛ هیچ رمز یا کد بانکی لازم نیست.',
    );
  }
  if (c === "/payments")
    return reviewQueue(
      env,
      bot,
      user,
      args ? integer(Number(args), 0, 1000000) : 0,
    );
  if (c === "/review") return reviewView(env, bot, user, text(args, 40));
  if (c === "/approve") {
    const reviewId = text(args, 40);
    const r = await one<{
      order_id: string;
      customer_id: number;
      state: string;
    }>(
      env,
      "SELECT order_id,customer_id,state FROM manual_reviews WHERE bot_id=? AND id=?",
      bot,
      reviewId,
    );
    assert(r && r.state === "PENDING", "REVIEW_NOT_PENDING");
    assert(r.customer_id !== user, "SELF_APPROVAL_FORBIDDEN");
    const summary = await orderView(env, bot, user, r.order_id, true);
    return buttons(
      `⚠️ تأیید قطعی دستی\n${summary.text}\nتصویر به‌تنهایی اثبات واریز نیست. مبلغ و واریز به حساب مقصد را خودتان بررسی کنید. با دکمه زیر مسئولیت تأیید دستی را می‌پذیرید.`,
      [
        [
          {
            text: "✅ واریز را بررسی کردم؛ تأیید",
            callback_data: `/confirm_pay ${reviewId}`,
          },
        ],
        [{ text: "بازگشت به رسید", callback_data: `/review ${reviewId}` }],
      ],
    );
  }
  if (c === "/confirm_pay")
    return decide(env, bot, user, text(args, 40), "APPROVED", "", key);
  if (c === "/ask_reject" || c === "/ask_more")
    return decisionPrompt(
      env,
      bot,
      user,
      text(args, 40),
      c === "/ask_reject" ? "REJECT" : "MORE_EVIDENCE",
    );
  if (c === "/reject" || c === "/more") {
    const [reviewId, ...reason] = args.split(" ");
    return decide(
      env,
      bot,
      user,
      text(reviewId, 40),
      c === "/reject" ? "REJECTED" : "MORE_EVIDENCE",
      text(reason.join(" "), 500),
      key,
    );
  }
  if (c === "/admin_order")
    return orderView(env, bot, user, text(args, 40), true);
  if (c === "/plan_publish") return publishPlan(env, bot, user, text(args, 40));
  if (c === "/route_add") {
    const o = jsonObject(args);
    assert(
      Object.keys(o).every((x) => ["customer_id", "panel_id"].includes(x)),
    );
    const uid = integer(o.customer_id),
      panel = text(o.panel_id, 40);
    assert(
      await one(
        env,
        "SELECT id FROM panels WHERE bot_id=? AND id=?",
        bot,
        panel,
      ),
      "PANEL_NOT_FOUND",
    );
    await run(
      env,
      "INSERT INTO routing_rules(bot_id,customer_id,panel_id) VALUES(?,?,?) ON CONFLICT(bot_id,customer_id) DO UPDATE SET panel_id=excluded.panel_id",
      bot,
      uid,
      panel,
    );
    await audit(env, user, "ROUTE_SET", String(uid), tenant, bot);
    return reply(
      "قانون مقصد ذخیره شد؛ اگر پنل در دسترس نباشد، درخواست متوقف می‌شود و به پنل دیگری نمی‌رود.",
    );
  }
  if (c === "/route_remove") {
    const uid = integer(Number(args));
    await run(
      env,
      "DELETE FROM routing_rules WHERE bot_id=? AND customer_id=?",
      bot,
      uid,
    );
    await audit(env, user, "ROUTE_REMOVE", String(uid), tenant, bot);
    return reply("قانون مقصد حذف شد.");
  }
  if (c === "/routes")
    return reply(
      JSON.stringify(
        await rows(
          env,
          "SELECT r.customer_id,r.panel_id,p.name FROM routing_rules r JOIN panels p ON p.bot_id=r.bot_id AND p.id=r.panel_id WHERE r.bot_id=? LIMIT 50",
          bot,
        ),
      ),
    );
  if (c === "/import_config")
    return importConfig(env, bot, user, jsonObject(args), key);
  if (c === "/manage_help")
    return reply(
      '💼 راهنمای مدیریت\n/bank_set تنظیم کارت مقصد بدون رمز\n/payments صف رسیدها\n/review ID بررسی مدرک\n/reject ID دلیل\n/more ID دلیل درخواست مدرک تکمیلی\n/plan_publish ID بررسی پنل و انتشار طرح\n/route_add {"customer_id":123,"panel_id":"ID"}\n/routes و /route_remove USER_ID\n/import_config {"panel_id":"ID","inbound_id":1,"customer_id":123,"uri":"vless://... یا vmess://..."}\nپنل، سرویس و پرداخت همیشه به ربات جاری محدود هستند. برای جزئیات پنل‌ها /admin را بزنید.',
    );
  return null;
}
export function parseConnection(value: unknown): {
  protocol: string;
  clientId: string;
} {
  const uri = text(value, 12000);
  let clientId: string, protocol: string;
  if (uri.startsWith("vless://")) {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      assert(false, "INVALID_CONNECTION");
    }
    assert(!u.password, "INVALID_CONNECTION");
    clientId = decodeURIComponent(u.username);
    protocol = "vless";
  } else {
    assert(uri.startsWith("vmess://"), "CONNECTION_IMPORT_UNSUPPORTED");
    let obj: { id: string };
    try {
      const data = Uint8Array.from(atob(uri.slice(8)), (x) => x.charCodeAt(0));
      obj = JSON.parse(new TextDecoder().decode(data)) as { id: string };
    } catch {
      assert(false, "INVALID_CONNECTION");
    }
    clientId = text(obj.id, 36);
    protocol = "vmess";
  }
  assert(
    /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(
      clientId,
    ),
    "INVALID_CLIENT_ID",
  );
  return { protocol, clientId };
}
export async function importConfig(
  env: Env,
  bot: string,
  user: number,
  o: Record<string, unknown>,
  key: string,
): Promise<Reply> {
  const tenant = await owner(env, bot, user);
  assert(
    Object.keys(o).every((x) =>
      ["panel_id", "inbound_id", "customer_id", "uri"].includes(x),
    ),
  );
  const prior = await one<{ id: string }>(
    env,
    "SELECT s.id FROM services s JOIN orders q ON q.bot_id=s.bot_id AND q.id=s.order_id WHERE s.bot_id=? AND q.request_key=?",
    bot,
    key,
  );
  if (prior) return reply(`این سرویس قبلاً وارد شد: ${prior.id}`);
  const panel = await one<Panel>(
    env,
    "SELECT * FROM panels WHERE bot_id=? AND id=? AND enabled=1",
    bot,
    text(o.panel_id, 40),
  );
  assert(panel, "PANEL_NOT_AVAILABLE");
  const inboundId = integer(o.inbound_id),
    customer = integer(o.customer_id),
    parsed = parseConnection(o.uri);
  const inbound = (await (await adapter(env, panel)).list()).find(
    (x) => x.id === inboundId,
  );
  assert(
    inbound && inbound.protocol === parsed.protocol,
    "INBOUND_INCOMPATIBLE",
  );
  const settings = JSON.parse(inbound.settings) as {
    clients: {
      id: string;
      email: string;
      totalGB: number;
      expiryTime: number;
      enable: boolean;
    }[];
  };
  assert(Array.isArray(settings.clients), "PANEL_API_INCOMPATIBLE");
  const client = settings.clients.find((x) => x.id === parsed.clientId);
  assert(client, "SERVICE_MISSING_REMOTE");
  assert(
    !(await one(env, "SELECT id FROM services WHERE client_id=?", client.id)),
    "CLIENT_ALREADY_REGISTERED",
  );
  const quota = integer(client.totalGB, 0, 10 ** 15),
    expiry = integer(client.expiryTime, 0);
  assert(typeof client.enable === "boolean");
  const email = text(client.email, 256);
  const orderId = id(),
    planId = id(),
    serviceId = id();
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO customers(bot_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      bot,
      customer,
    ),
    stmt(
      env,
      "INSERT INTO plans(id,bot_id,panel_id,name,description,inbound_id,bytes,days,price_minor,currency,enabled) VALUES(?,?,?,'Imported client','Reference only; not a sales offering',?,?,1,0,'IRR',0)",
      planId,
      bot,
      panel.id,
      inboundId,
      Math.max(1, quota),
    ),
    stmt(
      env,
      "INSERT INTO orders(id,bot_id,customer_id,plan_id,panel_id,request_key,amount_minor,currency,state,payment_state,kind) VALUES(?,?,?,?,?,?,0,'IRR','FULFILLED','NOT_REQUIRED','IMPORT')",
      orderId,
      bot,
      customer,
      planId,
      panel.id,
      key,
    ),
    stmt(
      env,
      "INSERT INTO services(id,bot_id,customer_id,panel_id,order_id,inbound_id,client_id,email,bytes,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      serviceId,
      bot,
      customer,
      panel.id,
      orderId,
      inboundId,
      client.id,
      email,
      quota,
      Math.floor(expiry / 1000),
      "ACTIVE",
    ),
    stmt(
      env,
      "INSERT INTO audit_logs(id,tenant_id,bot_id,actor_id,action,target_id) VALUES(?,?,?,?,?,?)",
      id(),
      tenant,
      bot,
      user,
      "SERVICE_IMPORT",
      serviceId,
    ),
  ]);
  return buttons(
    `✅ کلاینت موجود و واقعی پنل وارد شد؛ هیچ کلاینت جدیدی در پنل ساخته نشد.\nسرویس: ${serviceId}\nپنل اصلی: ${panel.name}\nمالک سرویس: ${customer}\nاین لینک صرفاً برای تطبیق شناسه استفاده شد؛ تنظیمات خروجی از پنل واقعی تولید می‌شوند.`,
    [[{ text: "پنل‌ها", callback_data: "/panels" }]],
  );
}
