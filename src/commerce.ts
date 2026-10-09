import type { Env, Service, Update } from "./types";
import {
  assert,
  integer,
  text,
  jsonObject,
  id,
  now,
  one,
  rows,
  stmt,
  run,
  owner,
  audit,
  AppError,
} from "./core";
import { seal, open } from "./crypto";
import { messageStatements, type Reply } from "./delivery";
import { config } from "./settings";
import { buttons, reply, money, bytes, date, state } from "./ui";
export interface Plan {
  id: string;
  bot_id: string;
  panel_id: string;
  name: string;
  description: string;
  inbound_id: number;
  bytes: number;
  days: number;
  price_minor: number;
  currency: string;
  enabled: number;
}
export interface CardSettings {
  card_number: string;
  recipient_name: string;
  instructions: string;
}
export interface SalesOrder {
  id: string;
  bot_id: string;
  customer_id: number;
  plan_id: string;
  panel_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  payment_state: string;
  current_review_id: string | null;
  kind: string;
  target_service_id: string | null;
  created_at: number;
}
interface Snapshot {
  order_id: string;
  bot_id: string;
  plan_name: string;
  description: string;
  inbound_id: number;
  bytes: number;
  days: number;
  service_id: string;
  client_id: string;
  recipient_enc: string | null;
}
interface Review {
  id: string;
  bot_id: string;
  order_id: string;
  customer_id: number;
  evidence_enc: string;
  state: string;
  reviewer_id: number | null;
  reason_enc: string | null;
  decision_key: string | null;
  created_at: number;
  reviewed_at: number | null;
}
export interface Evidence {
  kind: "photo" | "document";
  file_id: string;
  file_unique_id: string;
  caption: string;
}
const safeKeys = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of Object.keys(o))
    assert(keys.includes(k), "UNSUPPORTED_SETTING");
};
export async function setCard(
  env: Env,
  bot: string,
  user: number,
  input: string,
) {
  const tenant = await owner(env, bot, user);
  const o = jsonObject(input);
  safeKeys(o, ["card_number", "recipient_name", "instructions", "enabled"]);
  assert(typeof o.enabled === "boolean", "INVALID_ENABLED");
  const card = text(o.card_number, 40)
    .replace(/[۰-۹]/g, (x) => String(x.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 1632))
    .replace(/[\s-]/g, "");
  assert(/^\d{16}$/.test(card) && !/^0+$/.test(card), "INVALID_RECIPIENT_CARD");
  const settings = {
    card_number: card,
    recipient_name: text(o.recipient_name, 120),
    instructions: text(o.instructions, 1000),
  };
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO bank_settings(bot_id,settings_enc,enabled,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET settings_enc=excluded.settings_enc,enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at",
      bot,
      await seal(env, JSON.stringify(settings), `bank:${bot}`),
      o.enabled ? 1 : 0,
      user,
      now(),
    ),
    stmt(
      env,
      "INSERT INTO audit_logs(id,tenant_id,bot_id,actor_id,action,target_id) VALUES(?,?,?,?,?,?)",
      id(),
      tenant,
      bot,
      user,
      "CARD_SETTINGS",
      bot,
    ),
  ]);
  return reply(
    `تنظیمات کارت مقصد ذخیره شد. کارت: **** ${card.slice(-4)}\nهیچ رمز، PIN یا کد بانکی لازم نیست.`,
  );
}
export async function getCard(
  env: Env,
  bot: string,
): Promise<CardSettings | null> {
  const r = await one<{ settings_enc: string }>(
    env,
    "SELECT settings_enc FROM bank_settings WHERE bot_id=? AND enabled=1",
    bot,
  );
  return r
    ? (JSON.parse(
        await open(env, r.settings_enc, `bank:${bot}`),
      ) as CardSettings)
    : null;
}
export async function fingerprint(p: Plan) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            p.id,
            p.panel_id,
            p.name,
            p.description,
            p.inbound_id,
            p.bytes,
            p.days,
            p.price_minor,
            p.currency,
            p.enabled,
          ]),
        ),
      ),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function enforceRoute(
  env: Env,
  bot: string,
  user: number,
  panel: string,
) {
  const rule = await one<{ panel_id: string }>(
    env,
    "SELECT panel_id FROM routing_rules WHERE bot_id=? AND customer_id=?",
    bot,
    user,
  );
  if (rule) {
    assert(rule.panel_id === panel, "ROUTING_POLICY_DENIED");
    return;
  }
  const cfg = await config(env, bot);
  if (cfg.panel_selection === "default") {
    const p = await one<{ id: string }>(
      env,
      "SELECT id FROM panels WHERE bot_id=? AND enabled=1 AND is_default=1",
      bot,
    );
    assert(p && p.id === panel, "ROUTING_POLICY_DENIED");
  }
}
export async function offer(
  env: Env,
  bot: string,
  user: number,
  planId: string,
  target: string | null = null,
): Promise<Reply> {
  const p = await one<Plan>(
    env,
    "SELECT * FROM plans WHERE bot_id=? AND id=? AND enabled=1",
    bot,
    planId,
  );
  assert(p, "PLAN_NOT_AVAILABLE");
  const panel = await one<{ name: string }>(
    env,
    "SELECT name FROM panels WHERE bot_id=? AND id=? AND enabled=1",
    bot,
    p.panel_id,
  );
  assert(panel, "PANEL_NOT_AVAILABLE");
  if (!target) await enforceRoute(env, bot, user, p.panel_id);
  if (target) {
    const s = await one<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND id=? AND customer_id=? AND state='ACTIVE'",
      bot,
      target,
      user,
    );
    assert(
      s && s.panel_id === p.panel_id && s.inbound_id === p.inbound_id,
      "RENEWAL_PLAN_INCOMPATIBLE",
    );
    assert(s.bytes > 0 && s.expires_at > 0, "UNLIMITED_RENEWAL_UNSUPPORTED");
  }
  await run(
    env,
    "INSERT INTO customers(bot_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING",
    bot,
    user,
  );
  const intent = id().replace(/-/g, "");
  await run(
    env,
    "INSERT INTO purchase_intents(id,bot_id,customer_id,plan_id,panel_id,target_service_id,fingerprint,expires_at) VALUES(?,?,?,?,?,?,?,?)",
    intent,
    bot,
    user,
    p.id,
    p.panel_id,
    target,
    await fingerprint(p),
    now() + 900,
  );
  return buttons(
    `📦 ${p.name}\n${p.description}\n🎯 پنل مقصد: ${panel.name}\nحجم: ${bytes(p.bytes)} | اعتبار: ${p.days} روز\nمبلغ: ${money(p.price_minor, p.currency)}\n${target ? "تمدید همان سرویس و همان پنل؛ حجم طرح به سقف فعلی اضافه می‌شود." : "سرویس جدید روی همین پنل ایجاد می‌شود."}\n${p.price_minor > 0 ? "پرداخت فقط کارت‌به‌کارت و تأیید دستی مدیر." : "این طرح بدون هزینه است."}`,
    [
      [{ text: "✅ تأیید طرح و پنل", callback_data: `/checkout ${intent}` }],
      [{ text: "بازگشت به پنل", callback_data: `/choose ${p.panel_id}` }],
    ],
  );
}
export async function checkout(
  env: Env,
  bot: string,
  user: number,
  intentId: string,
  key: string,
) {
  const i = await one<{
    plan_id: string;
    panel_id: string;
    target_service_id: string | null;
    fingerprint: string;
    expires_at: number;
  }>(
    env,
    "SELECT * FROM purchase_intents WHERE bot_id=? AND customer_id=? AND id=?",
    bot,
    user,
    intentId,
  );
  assert(i, "CHECKOUT_NOT_FOUND");
  assert(i.expires_at >= now(), "CHECKOUT_EXPIRED");
  const p = await one<Plan>(
    env,
    "SELECT * FROM plans WHERE bot_id=? AND id=? AND enabled=1",
    bot,
    i.plan_id,
  );
  assert(
    p && (await fingerprint(p)) === i.fingerprint,
    "PLAN_CHANGED_RECONFIRM",
  );
  return createOrder(
    env,
    bot,
    user,
    i.panel_id,
    i.plan_id,
    `intent:${intentId}`,
    i.target_service_id,
  );
}
export async function createOrder(
  env: Env,
  bot: string,
  user: number,
  panelId: string,
  planId: string,
  key: string,
  target: string | null = null,
): Promise<SalesOrder> {
  const prior = await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND request_key=?",
    bot,
    key,
  );
  if (prior) {
    assert(prior.customer_id === user, "FORBIDDEN");
    return prior;
  }
  if (!target) await enforceRoute(env, bot, user, panelId);
  const p = await one<Plan>(
    env,
    "SELECT * FROM plans WHERE bot_id=? AND panel_id=? AND id=? AND enabled=1",
    bot,
    panelId,
    planId,
  );
  assert(p, "PLAN_NOT_AVAILABLE");
  assert(
    await one(
      env,
      "SELECT id FROM panels WHERE bot_id=? AND id=? AND enabled=1",
      bot,
      panelId,
    ),
    "PANEL_NOT_AVAILABLE",
  );
  if (target) {
    const s = await one<Service>(
      env,
      "SELECT * FROM services WHERE bot_id=? AND id=? AND customer_id=? AND state='ACTIVE'",
      bot,
      target,
      user,
    );
    assert(
      s && s.panel_id === p.panel_id && s.inbound_id === p.inbound_id,
      "RENEWAL_PLAN_INCOMPATIBLE",
    );
    assert(s.bytes > 0 && s.expires_at > 0, "UNLIMITED_RENEWAL_UNSUPPORTED");
    assert(
      !(await one(
        env,
        "SELECT id FROM operations WHERE bot_id=? AND service_id=? AND state IN('PENDING','PROCESSING','UNKNOWN')",
        bot,
        target,
      )),
      "SERVICE_BUSY",
    );
  }
  const pending = await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND customer_id=? AND plan_id=? AND target_service_id IS ? AND state IN('UNCONFIGURED','AWAITING_PAYMENT','FREE','PAID','PROVISIONING')",
    bot,
    user,
    p.id,
    target,
  );
  if (pending) {
    assert(
      pending.target_service_id === target,
      "OPEN_ORDER_DIFFERENT_SERVICE",
    );
    return pending;
  }
  const card = p.price_minor > 0 ? await getCard(env, bot) : null;
  const orderId = id(),
    serviceId = id(),
    clientId = id();
  const pay =
      p.price_minor === 0
        ? "NOT_REQUIRED"
        : card
          ? "AWAITING_RECEIPT"
          : "UNCONFIGURED",
    status =
      p.price_minor === 0 ? "FREE" : card ? "AWAITING_PAYMENT" : "UNCONFIGURED";
  const batch = [
    stmt(
      env,
      "INSERT INTO customers(bot_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING",
      bot,
      user,
    ),
    stmt(
      env,
      "INSERT INTO orders(id,bot_id,customer_id,plan_id,panel_id,request_key,amount_minor,currency,state,payment_state,kind,target_service_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      orderId,
      bot,
      user,
      p.id,
      p.panel_id,
      key,
      p.price_minor,
      p.currency,
      status,
      pay,
      target ? "RENEW" : "CREATE",
      target,
    ),
    stmt(
      env,
      "INSERT INTO order_snapshots(order_id,bot_id,plan_name,description,inbound_id,bytes,days,service_id,client_id,recipient_enc) VALUES(?,?,?,?,?,?,?,?,?,?)",
      orderId,
      bot,
      p.name,
      p.description,
      p.inbound_id,
      p.bytes,
      p.days,
      serviceId,
      clientId,
      card
        ? await seal(env, JSON.stringify(card), `recipient:${bot}:${orderId}`)
        : null,
    ),
  ];
  if (p.price_minor === 0)
    batch.push(
      ...(await provisioningStatements(
        env,
        bot,
        orderId,
        `free:${orderId}`,
        null,
      )),
    );
  try {
    await env.DB.batch(batch);
  } catch (e) {
    const raced = await one<SalesOrder>(
      env,
      "SELECT * FROM orders WHERE bot_id=? AND customer_id=? AND plan_id=? AND target_service_id IS ? AND state IN('UNCONFIGURED','AWAITING_PAYMENT','FREE','PAID','PROVISIONING')",
      bot,
      user,
      p.id,
      target,
    );
    if (raced) {
      assert(
        raced.target_service_id === target,
        "OPEN_ORDER_DIFFERENT_SERVICE",
      );
      return raced;
    }
    throw e;
  }
  return (await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND id=?",
    bot,
    orderId,
  ))!;
}
// These statements are executed in the SAME atomic D1 batch as the approval/free-order insert.
export async function provisioningStatements(
  env: Env,
  bot: string,
  orderId: string,
  key: string,
  decision: { reviewId: string; decisionKey: string } | null,
) {
  const guard = decision
    ? "o.current_review_id=? AND EXISTS(SELECT 1 FROM manual_reviews r WHERE r.bot_id=o.bot_id AND r.id=? AND r.state='APPROVED' AND r.decision_key=?)"
    : "o.payment_state='NOT_REQUIRED'";
  const args = decision
    ? [decision.reviewId, decision.reviewId, decision.decisionKey]
    : [];
  const ts = now();
  return [
    stmt(
      env,
      `INSERT INTO services(id,bot_id,customer_id,panel_id,order_id,inbound_id,client_id,email,bytes,expires_at,state) SELECT s.service_id,o.bot_id,o.customer_id,o.panel_id,o.id,s.inbound_id,s.client_id,'errf_'||replace(s.service_id,'-',''),s.bytes,?+s.days*86400,'PENDING' FROM orders o JOIN order_snapshots s ON s.order_id=o.id AND s.bot_id=o.bot_id WHERE o.bot_id=? AND o.id=? AND o.kind='CREATE' AND ${guard} ON CONFLICT(order_id) DO NOTHING`,
      ts,
      bot,
      orderId,
      ...args,
    ),
    stmt(
      env,
      `INSERT INTO operations(id,bot_id,service_id,request_key,kind,payload,state,order_id) SELECT ?,o.bot_id,CASE WHEN o.kind='RENEW' THEN o.target_service_id ELSE s.service_id END,?,CASE WHEN o.kind='RENEW' THEN 'UPDATE' ELSE 'CREATE' END,CASE WHEN o.kind='RENEW' THEN json_object('bytes',v.bytes+s.bytes,'expires_at',MAX(v.expires_at,?)+s.days*86400,'base_bytes',v.bytes,'base_expires_at',v.expires_at) ELSE json_object('days',s.days) END,'PENDING',o.id FROM orders o JOIN order_snapshots s ON s.order_id=o.id AND s.bot_id=o.bot_id LEFT JOIN services v ON v.bot_id=o.bot_id AND v.id=o.target_service_id WHERE o.bot_id=? AND o.id=? AND ${guard} ON CONFLICT(bot_id,request_key) DO NOTHING`,
      id(),
      key,
      ts,
      bot,
      orderId,
      ...args,
    ),
    stmt(
      env,
      `UPDATE orders AS o SET state='PROVISIONING' WHERE bot_id=? AND id=? AND ${guard}`,
      bot,
      orderId,
      ...args,
    ),
  ];
}
export async function orderView(
  env: Env,
  bot: string,
  user: number,
  orderId: string,
  admin = false,
): Promise<Reply> {
  if (admin) await owner(env, bot, user);
  const o = await one<SalesOrder>(
    env,
    `SELECT * FROM orders WHERE bot_id=? AND id=? ${admin ? "" : "AND customer_id=?"}`,
    bot,
    orderId,
    ...(admin ? [] : [user]),
  );
  assert(o, "ORDER_NOT_FOUND");
  const snapshot = await one<Snapshot>(
    env,
    "SELECT * FROM order_snapshots WHERE bot_id=? AND order_id=?",
    bot,
    o.id,
  );
  const panel = await one<{ name: string }>(
    env,
    "SELECT name FROM panels WHERE bot_id=? AND id=?",
    bot,
    o.panel_id,
  );
  let body = `🧾 سفارش ${o.id}\nطرح: ${snapshot?.plan_name ?? "نسخه قبلی"}\nپنل مقصد: ${panel?.name ?? o.panel_id}\nمبلغ: ${money(o.amount_minor, o.currency)}\nپرداخت: ${state(o.payment_state)}\nعملیات: ${state(o.state)}\nتاریخ: ${date(o.created_at)}`;
  const options: { text: string; callback_data: string }[][] = [];
  if (
    snapshot?.recipient_enc &&
    ["AWAITING_RECEIPT", "MORE_EVIDENCE", "UNDER_REVIEW"].includes(
      o.payment_state,
    )
  ) {
    const card = JSON.parse(
      await open(env, snapshot.recipient_enc, `recipient:${bot}:${o.id}`),
    ) as CardSettings;
    body += `\n\n💳 کارت مقصد: ${card.card_number}\nگیرنده: ${card.recipient_name}\n${card.instructions}\nفقط تصویر رسید یا PDF ارسال کنید؛ رمز کارت، PIN و کد ورود بانکی لازم نیست.`;
  }
  if (["AWAITING_RECEIPT", "MORE_EVIDENCE"].includes(o.payment_state))
    options.push([
      { text: "📎 ارسال رسید پرداخت", callback_data: `/receipt ${o.id}` },
    ]);
  if (o.current_review_id) {
    const r = await one<Review>(
      env,
      "SELECT * FROM manual_reviews WHERE bot_id=? AND id=?",
      bot,
      o.current_review_id,
    );
    if (r?.reason_enc)
      body += `\nنظر مدیر: ${await open(env, r.reason_enc, `reason:${bot}:${r.id}`)}`;
  }
  if (o.state === "FULFILLED") {
    const s =
      o.target_service_id ??
      (
        await one<{ id: string }>(
          env,
          "SELECT id FROM services WHERE bot_id=? AND order_id=?",
          bot,
          o.id,
        )
      )?.id;
    if (s)
      options.push([
        { text: "🔗 سرویس و اتصال", callback_data: `/service ${s}` },
      ]);
  }
  if (o.payment_state === "UNCONFIGURED")
    body += "\nکارت مقصد فعال نیست. پول واریز نکنید؛ با پشتیبانی تماس بگیرید.";
  if (!admin)
    options.push([
      { text: "سفارش‌های من", callback_data: "/orders" },
      { text: "پشتیبانی", callback_data: "/support" },
    ]);
  return buttons(body, options);
}
export async function beginReceipt(
  env: Env,
  bot: string,
  user: number,
  orderId: string,
) {
  const o = await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND id=? AND customer_id=?",
    bot,
    orderId,
    user,
  );
  assert(
    o &&
      o.state === "AWAITING_PAYMENT" &&
      ["AWAITING_RECEIPT", "MORE_EVIDENCE"].includes(o.payment_state),
    "ORDER_NOT_ACCEPTING_EVIDENCE",
  );
  await run(
    env,
    "INSERT INTO receipt_sessions(bot_id,user_id,order_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(bot_id,user_id) DO UPDATE SET order_id=excluded.order_id,expires_at=excluded.expires_at",
    bot,
    user,
    orderId,
    now() + 900,
  );
  return reply(
    `📎 تصویر رسید یا فایل PDF را برای سفارش ${orderId} در همین گفتگوی خصوصی ارسال کنید (حداکثر ۱۰ مگابایت).\nپنل: ${o.panel_id}\nهیچ رمز، PIN یا کد بانکی ارسال نکنید. این انتخاب تا ۱۵ دقیقه معتبر است.\nبرای انتخاب صریح، کپشن را /receipt ${orderId} قرار دهید.`,
  );
}
export function evidenceFrom(update: Update): Evidence | null {
  const m = update.message;
  if (!m) return null;
  const p = m.photo?.at(-1);
  if (p) {
    assert(
      !p.file_size || p.file_size <= 10 * 1024 * 1024,
      "EVIDENCE_TOO_LARGE",
    );
    return {
      kind: "photo",
      file_id: text(p.file_id, 512),
      file_unique_id: text(p.file_unique_id, 256),
      caption: "",
    };
  }
  if (m.document) {
    assert(
      ["application/pdf", "image/jpeg", "image/png"].includes(
        m.document.mime_type ?? "",
      ),
      "EVIDENCE_FORMAT_UNSUPPORTED",
    );
    assert(
      typeof m.document.file_size === "number" &&
        m.document.file_size > 0 &&
        m.document.file_size <= 10 * 1024 * 1024,
      "EVIDENCE_TOO_LARGE",
    );
    return {
      kind: "document",
      file_id: text(m.document.file_id, 512),
      file_unique_id: text(m.document.file_unique_id, 256),
      caption: "",
    };
  }
  return null;
}
export async function submitEvidence(
  env: Env,
  bot: string,
  user: number,
  update: Update,
  key: string,
): Promise<Reply> {
  const prior = await one<Review>(
    env,
    "SELECT * FROM manual_reviews WHERE bot_id=? AND request_key=?",
    bot,
    key,
  );
  if (prior) {
    assert(prior.customer_id === user, "FORBIDDEN");
    return reply(
      `رسید ${prior.id} قبلاً ثبت شده؛ وضعیت: ${state(prior.state)}`,
    );
  }
  const evidence = evidenceFrom(update);
  assert(evidence, "EVIDENCE_REQUIRED");
  const explicit = /^\/receipt\s+([a-f0-9-]{36})\s*$/.exec(
    update.message?.caption ?? "",
  )?.[1];
  if ((update.message?.caption ?? "").startsWith("/receipt"))
    assert(explicit, "INVALID_RECEIPT_CAPTION");
  const session = await one<{ order_id: string; expires_at: number }>(
    env,
    "SELECT * FROM receipt_sessions WHERE bot_id=? AND user_id=?",
    bot,
    user,
  );
  const orderId =
    explicit ??
    (session && session.expires_at >= now() ? session.order_id : null);
  assert(orderId, "SELECT_ORDER_BEFORE_RECEIPT");
  const o = await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND id=? AND customer_id=?",
    bot,
    orderId,
    user,
  );
  assert(
    o &&
      o.state === "AWAITING_PAYMENT" &&
      ["AWAITING_RECEIPT", "MORE_EVIDENCE"].includes(o.payment_state),
    "ORDER_NOT_ACCEPTING_EVIDENCE",
  );
  const reviewId = id();
  const guard = {
    sql: "EXISTS(SELECT 1 FROM manual_reviews WHERE bot_id=? AND id=? AND state='PENDING')",
    params: [bot, reviewId],
  };
  const reviewers = await rows<{ user_id: number }>(
    env,
    "SELECT a.user_id FROM tenant_admins a JOIN bots b ON b.tenant_id=a.tenant_id WHERE b.id=?",
    bot,
  );
  assert(
    reviewers.some((x) => x.user_id !== user),
    "NO_INDEPENDENT_REVIEWER",
  );
  const snapshot = await one<Snapshot>(
    env,
    "SELECT * FROM order_snapshots WHERE bot_id=? AND order_id=?",
    bot,
    orderId,
  );
  assert(snapshot?.recipient_enc, "LEGACY_ORDER_RECREATE");
  const panel = await one<{ name: string }>(
    env,
    "SELECT name FROM panels WHERE bot_id=? AND id=?",
    bot,
    o.panel_id,
  );
  const messages = [];
  for (const r of reviewers.filter((x) => x.user_id !== user))
    messages.push(
      ...(await messageStatements(
        env,
        `review:${reviewId}:${r.user_id}`,
        bot,
        r.user_id,
        {
          text: `🔎 رسید جدید؛ نیازمند بررسی دستی\nسفارش: ${orderId}\nخریدار: ${user}\nطرح: ${snapshot.plan_name}\nپنل مقصد: ${panel?.name ?? o.panel_id}\nمبلغ: ${money(o.amount_minor, o.currency)}\nشناسه بررسی: ${reviewId}\nتصویر به‌تنهایی تأیید واریز نیست.`,
          admin_only: true,
          media: { kind: evidence.kind, file_id: evidence.file_id },
          reply_markup: {
            inline_keyboard: [
              [{ text: "بررسی و تصمیم", callback_data: `/review ${reviewId}` }],
            ],
          },
        },
        guard,
      )),
    );
  const result = await env.DB.batch([
    stmt(
      env,
      "UPDATE orders SET payment_state='UNDER_REVIEW',current_review_id=? WHERE bot_id=? AND id=? AND customer_id=? AND state='AWAITING_PAYMENT' AND payment_state IN('AWAITING_RECEIPT','MORE_EVIDENCE')",
      reviewId,
      bot,
      orderId,
      user,
    ),
    stmt(
      env,
      "INSERT INTO manual_reviews(id,bot_id,order_id,customer_id,evidence_enc,state,request_key,created_at) SELECT ?,?,?,?,?,'PENDING',?,? WHERE EXISTS(SELECT 1 FROM orders WHERE bot_id=? AND id=? AND current_review_id=? AND payment_state='UNDER_REVIEW')",
      reviewId,
      bot,
      orderId,
      user,
      await seal(env, JSON.stringify(evidence), `evidence:${bot}:${reviewId}`),
      key,
      now(),
      bot,
      orderId,
      reviewId,
    ),
    stmt(
      env,
      "DELETE FROM receipt_sessions WHERE bot_id=? AND user_id=? AND order_id=?",
      bot,
      user,
      orderId,
    ),
    ...messages,
  ]);
  assert(result[0]!.meta.changes === 1, "EVIDENCE_ALREADY_UNDER_REVIEW");
  return buttons(
    `✅ رسید برای سفارش ${orderId} ثبت شد و منتظر بررسی مدیر است.\nارسال تصویر پرداخت را خودکار تأیید نمی‌کند.`,
    [[{ text: "پیگیری سفارش", callback_data: `/order ${orderId}` }]],
  );
}
export async function reviewView(
  env: Env,
  bot: string,
  user: number,
  reviewId: string,
): Promise<Reply> {
  await owner(env, bot, user);
  const r = await one<Review>(
    env,
    "SELECT * FROM manual_reviews WHERE bot_id=? AND id=?",
    bot,
    reviewId,
  );
  assert(r, "REVIEW_NOT_FOUND");
  const o = await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND id=?",
    bot,
    r.order_id,
  );
  assert(o, "ORDER_NOT_FOUND");
  const cardView = await orderView(env, bot, user, o.id, true);
  const evidence = r.evidence_enc
    ? (JSON.parse(
        await open(env, r.evidence_enc, `evidence:${bot}:${r.id}`),
      ) as Evidence)
    : null;
  return {
    text: `بررسی ${r.id}\n${cardView.text}\nوضعیت مدرک: ${state(r.state)}\n${r.reviewer_id ? `بازبین: ${r.reviewer_id} | ${date(r.reviewed_at ?? 0)}` : "برای تأیید، واریز را خودتان بررسی کنید."}`,
    admin_only: true,
    ...(evidence
      ? { media: { kind: evidence.kind, file_id: evidence.file_id } }
      : {}),
    reply_markup: {
      inline_keyboard:
        r.state === "PENDING"
          ? [
              [
                {
                  text: "✅ پیش‌نمایش تأیید",
                  callback_data: `/approve ${r.id}`,
                },
              ],
              [
                { text: "❌ رد با دلیل", callback_data: `/ask_reject ${r.id}` },
                { text: "مدرک تکمیلی", callback_data: `/ask_more ${r.id}` },
              ],
            ]
          : [],
    },
  };
}
export async function decisionPrompt(
  env: Env,
  bot: string,
  user: number,
  reviewId: string,
  action: "REJECT" | "MORE_EVIDENCE",
) {
  await owner(env, bot, user);
  assert(
    await one(
      env,
      "SELECT id FROM manual_reviews WHERE bot_id=? AND id=? AND state='PENDING'",
      bot,
      reviewId,
    ),
    "REVIEW_NOT_PENDING",
  );
  await run(
    env,
    "INSERT INTO review_sessions(bot_id,user_id,review_id,action,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(bot_id,user_id) DO UPDATE SET review_id=excluded.review_id,action=excluded.action,expires_at=excluded.expires_at",
    bot,
    user,
    reviewId,
    action,
    now() + 900,
  );
  return reply(
    `دلیل ${action === "REJECT" ? "رد پرداخت" : "درخواست مدرک تکمیلی"} را در یک پیام متنی ارسال کنید. بررسی: ${reviewId}\nتا دریافت این پیام، تصمیمی ثبت نمی‌شود.`,
  );
}
export async function decide(
  env: Env,
  bot: string,
  user: number,
  reviewId: string,
  decision: "APPROVED" | "REJECTED" | "MORE_EVIDENCE",
  reason: string,
  key: string,
): Promise<Reply> {
  const tenant = await owner(env, bot, user);
  assert(["APPROVED", "REJECTED", "MORE_EVIDENCE"].includes(decision));
  const r = await one<Review>(
    env,
    "SELECT * FROM manual_reviews WHERE bot_id=? AND id=?",
    bot,
    reviewId,
  );
  assert(r, "REVIEW_NOT_FOUND");
  assert(r.customer_id !== user, "SELF_APPROVAL_FORBIDDEN");
  if (r.state !== "PENDING")
    return reply(
      `این بررسی قبلاً بسته شده: ${state(r.state)}؛ تصمیم جدیدی اعمال نشد.`,
    );
  if (decision !== "APPROVED") text(reason, 500);
  const o = await one<SalesOrder>(
    env,
    "SELECT * FROM orders WHERE bot_id=? AND id=?",
    bot,
    r.order_id,
  );
  assert(
    o &&
      o.state === "AWAITING_PAYMENT" &&
      o.payment_state === "UNDER_REVIEW" &&
      o.current_review_id === r.id,
    "ORDER_NOT_REVIEWABLE",
  );
  if (decision === "APPROVED") {
    assert(
      await one(
        env,
        "SELECT id FROM panels WHERE bot_id=? AND id=? AND enabled=1",
        bot,
        o.panel_id,
      ),
      "PANEL_NOT_AVAILABLE",
    );
    if (o.kind === "RENEW")
      assert(
        !(await one(
          env,
          "SELECT id FROM operations WHERE bot_id=? AND service_id=? AND state IN('PENDING','PROCESSING','UNKNOWN')",
          bot,
          o.target_service_id,
        )),
        "SERVICE_BUSY",
      );
  }
  const decisionKey = `${bot}:${key}`;
  const guard = {
    sql: "EXISTS(SELECT 1 FROM manual_reviews WHERE bot_id=? AND id=? AND decision_key=?)",
    params: [bot, r.id, decisionKey],
  };
  const messages = await messageStatements(
    env,
    `decision:${r.id}`,
    bot,
    r.customer_id,
    {
      text: `${decision === "APPROVED" ? "✅ پرداخت توسط مدیر تأیید شد؛ سرویس در صف آماده‌سازی است." : decision === "REJECTED" ? "❌ مدرک پرداخت رد شد." : "📎 لطفاً مدرک تکمیلی ارسال کنید."}\nسفارش: ${o.id}\n${reason ? `دلیل: ${reason}` : ""}\nپرداخت را دوباره انجام ندهید مگر پس از هماهنگی با پشتیبانی.`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "وضعیت سفارش", callback_data: `/order ${o.id}` }],
        ],
      },
    },
    guard,
  );
  const batch = [
    stmt(
      env,
      "UPDATE manual_reviews SET state=?,reviewer_id=?,reason_enc=?,decision_key=?,reviewed_at=? WHERE bot_id=? AND id=? AND state='PENDING' AND EXISTS(SELECT 1 FROM orders o WHERE o.bot_id=? AND o.id=? AND o.current_review_id=manual_reviews.id AND o.payment_state='UNDER_REVIEW' AND o.state='AWAITING_PAYMENT') AND EXISTS(SELECT 1 FROM tenant_admins a JOIN bots b ON b.tenant_id=a.tenant_id WHERE b.id=? AND a.user_id=?) AND (? != 'APPROVED' OR EXISTS(SELECT 1 FROM panels p WHERE p.bot_id=? AND p.id=? AND p.enabled=1)) AND (? != 'APPROVED' OR ? != 'RENEW' OR (EXISTS(SELECT 1 FROM services v WHERE v.bot_id=? AND v.id=? AND v.customer_id=? AND v.panel_id=? AND v.state='ACTIVE' AND v.bytes>0 AND v.expires_at>0) AND NOT EXISTS(SELECT 1 FROM operations x WHERE x.bot_id=? AND x.service_id=? AND x.state IN('PENDING','PROCESSING','UNKNOWN'))))",
      decision,
      user,
      reason ? await seal(env, reason, `reason:${bot}:${r.id}`) : null,
      decisionKey,
      now(),
      bot,
      r.id,
      bot,
      o.id,
      bot,
      user,
      decision,
      bot,
      o.panel_id,
      decision,
      o.kind,
      bot,
      o.target_service_id,
      o.customer_id,
      o.panel_id,
      bot,
      o.target_service_id,
    ),
    stmt(
      env,
      `UPDATE orders SET payment_state=?,state=? WHERE bot_id=? AND id=? AND ${guard.sql}`,
      decision === "APPROVED"
        ? "APPROVED"
        : decision === "REJECTED"
          ? "REJECTED"
          : "MORE_EVIDENCE",
      decision === "REJECTED"
        ? "CANCELLED"
        : decision === "APPROVED"
          ? "PAID"
          : "AWAITING_PAYMENT",
      bot,
      o.id,
      ...guard.params,
    ),
  ];
  if (decision === "APPROVED") {
    batch.push(
      stmt(
        env,
        `INSERT INTO payments(id,bot_id,order_id,provider,provider_event_id,amount_minor,currency,verified_at,reviewer_id,review_id) SELECT ?,bot_id,order_id,'manual-card',id,?, ?,reviewed_at,reviewer_id,id FROM manual_reviews WHERE bot_id=? AND id=? AND decision_key=? AND state='APPROVED' ON CONFLICT(provider,provider_event_id) DO NOTHING`,
        id(),
        o.amount_minor,
        o.currency,
        bot,
        r.id,
        decisionKey,
      ),
      ...(await provisioningStatements(env, bot, o.id, `manual:${r.id}`, {
        reviewId: r.id,
        decisionKey,
      })),
    );
  }
  batch.push(
    stmt(
      env,
      `INSERT INTO audit_logs(id,tenant_id,bot_id,actor_id,action,target_id) SELECT ?,?,?,?,?,? WHERE ${guard.sql}`,
      id(),
      tenant,
      bot,
      user,
      `PAYMENT_${decision}`,
      r.id,
      ...guard.params,
    ),
    ...messages,
    stmt(
      env,
      "DELETE FROM review_sessions WHERE bot_id=? AND user_id=? AND review_id=?",
      bot,
      user,
      r.id,
    ),
  );
  const result = await env.DB.batch(batch);
  return reply(
    result[0]!.meta.changes === 1
      ? `تصمیم ثبت شد: ${state(decision)}\nسفارش ${o.id}`
      : "مدیر دیگری این بررسی را بسته است؛ هیچ پرداخت یا سرویس تکراری ثبت نشد.",
  );
}
export async function reasonMessage(
  env: Env,
  bot: string,
  user: number,
  value: string,
  key: string,
): Promise<Reply | null> {
  const s = await one<{
    review_id: string;
    action: "REJECT" | "MORE_EVIDENCE";
    expires_at: number;
  }>(
    env,
    "SELECT * FROM review_sessions WHERE bot_id=? AND user_id=?",
    bot,
    user,
  );
  if (!s || s.expires_at < now()) return null;
  return decide(
    env,
    bot,
    user,
    s.review_id,
    s.action === "REJECT" ? "REJECTED" : "MORE_EVIDENCE",
    text(value, 500),
    key,
  );
}
export async function reviewQueue(
  env: Env,
  bot: string,
  user: number,
  page = 0,
) {
  await owner(env, bot, user);
  const list = await rows<Review>(
    env,
    "SELECT * FROM manual_reviews WHERE bot_id=? AND state='PENDING' ORDER BY created_at,id LIMIT 11 OFFSET ?",
    bot,
    page * 10,
  );
  const opts = list.slice(0, 10).map((r) => [
    {
      text: `رسید ${r.id.slice(0, 8)} | سفارش ${r.order_id.slice(0, 8)}`,
      callback_data: `/review ${r.id}`,
    },
  ]);
  if (list.length > 10)
    opts.push([{ text: "بعدی", callback_data: `/payments ${page + 1}` }]);
  if (page > 0)
    opts.push([{ text: "قبلی", callback_data: `/payments ${page - 1}` }]);
  return buttons(
    list.length
      ? "🔎 رسیدهای در انتظار تصمیم شما:"
      : "رسیدی در انتظار بررسی نیست.",
    opts,
  );
}
