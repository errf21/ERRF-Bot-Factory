import type { Env, Service } from "./types";
import { now, one, stmt } from "./core";
import { messageStatements } from "./delivery";
import { config } from "./settings";
export async function notifyExpiration(env: Env) {
  const s = await one<Service>(
    env,
    "SELECT s.* FROM services s JOIN bots b ON b.id=s.bot_id WHERE b.state='ACTIVE' AND s.state='ACTIVE' AND s.expires_at>0 AND s.expires_at<=? AND NOT EXISTS(SELECT 1 FROM service_notifications n WHERE n.bot_id=s.bot_id AND n.service_id=s.id AND n.expires_at=s.expires_at) ORDER BY s.expires_at LIMIT 1",
    now(),
  );
  if (!s) return;
  const cfg = await config(env, s.bot_id);
  const messages = cfg.notifications_enabled
    ? await messageStatements(
        env,
        `expiration:${s.id}:${s.expires_at}`,
        s.bot_id,
        s.customer_id,
        {
          text: `زمان اعتبار ثبت‌شده سرویس ${s.id} پایان یافته است. وضعیت و مصرف واقعی پنل را با /service ${s.id} بررسی کنید.`,
        },
      )
    : [];
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO service_notifications(bot_id,service_id,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      s.bot_id,
      s.id,
      s.expires_at,
    ),
    ...messages,
  ]);
}
