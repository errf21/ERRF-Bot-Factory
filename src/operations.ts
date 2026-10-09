import type { Env, Operation, Service, Panel } from "./types";
import { assert, one, run, stmt, now, failCode, id } from "./core";
import { adapter, type Client } from "./adapters/panel";
import { messageStatements } from "./delivery";
import { errorText } from "./ui";
import { config } from "./settings";
function matches(client: Client, s: Service) {
  return (
    client.enable === true &&
    client.totalGB === s.bytes &&
    client.expiryTime === s.expires_at * 1000
  );
}
export async function processOperations(env: Env, max = 1) {
  for (let n = 0; n < max; n++) {
    const op = await one<Operation>(
      env,
      "UPDATE operations SET state='PROCESSING',attempts=attempts+1,lease_until=?,claim_id=? WHERE id=(SELECT o.id FROM operations o JOIN bots b ON b.id=o.bot_id WHERE b.state='ACTIVE' AND ((o.state IN ('PENDING','UNKNOWN')) OR (o.state='PROCESSING' AND o.lease_until<?)) AND o.next_at<=? AND o.attempts<5 ORDER BY o.created_at LIMIT 1) RETURNING *",
      now() + 120,
      id(),
      now(),
      now(),
    );
    if (!op) return;
    try {
      const service = await one<Service>(
        env,
        "SELECT * FROM services WHERE bot_id=? AND id=?",
        op.bot_id,
        op.service_id,
      );
      assert(service, "SERVICE_NOT_FOUND");
      const panel = await one<Panel>(
        env,
        "SELECT * FROM panels WHERE bot_id=? AND id=? AND enabled=1",
        op.bot_id,
        service.panel_id,
      );
      assert(panel, "PANEL_NOT_AVAILABLE");
      const api = await adapter(env, panel);
      const existing = await api.find(service);
      const payload = JSON.parse(op.payload) as {
        bytes?: number;
        expires_at?: number;
        days?: number;
        base_bytes?: number;
        base_expires_at?: number;
      };
      const desired = {
        ...service,
        bytes: payload.bytes ?? service.bytes,
        expires_at: payload.expires_at ?? service.expires_at,
      };
      if (op.kind === "CREATE") {
        if (existing)
          assert(matches(existing, desired), "PANEL_CLIENT_CONFLICT");
        else {
          if (payload.days) {
            assert(
              Number.isSafeInteger(payload.days) &&
                payload.days >= 1 &&
                payload.days <= 3650,
              "INVALID_OPERATION",
            );
            const anchored = now() + payload.days * 86400;
            const result = await run(
              env,
              "UPDATE services SET expires_at=? WHERE bot_id=? AND id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='PROCESSING')",
              anchored,
              op.bot_id,
              service.id,
              op.id,
              op.claim_id,
            );
            if (result.meta.changes !== 1) continue;
            desired.expires_at = anchored;
          }
          await api.create(desired);
          const confirmed = await api.find(desired);
          assert(
            confirmed && matches(confirmed, desired),
            "PANEL_RESULT_UNCONFIRMED",
          );
        }
      } else if (op.kind === "UPDATE") {
        assert(existing, "SERVICE_MISSING_REMOTE");
        if (!matches(existing, desired)) {
          if (payload.base_bytes !== undefined)
            assert(
              existing.totalGB === payload.base_bytes &&
                existing.expiryTime === payload.base_expires_at! * 1000,
              "REMOTE_STATE_CHANGED",
            );
          await api.update(desired, {
            ...existing,
            totalGB: desired.bytes,
            expiryTime: desired.expires_at * 1000,
            enable: true,
          });
          const confirmed = await api.find(desired);
          assert(
            confirmed && matches(confirmed, desired),
            "PANEL_RESULT_UNCONFIRMED",
          );
        }
      } else if (existing) {
        await api.revoke(service);
        assert(!(await api.find(service)), "PANEL_RESULT_UNCONFIRMED");
      }
      const current = await one(
        env,
        "SELECT id FROM operations WHERE id=? AND claim_id=? AND state='PROCESSING'",
        op.id,
        op.claim_id,
      );
      if (!current) continue;
      const settings = await config(env, op.bot_id);
      const messages = settings.notifications_enabled
        ? await messageStatements(
            env,
            `operation:${op.id}`,
            op.bot_id,
            service.customer_id,
            {
              text: `✅ ${op.kind === "CREATE" ? "سرویس آماده و تحویل شد" : op.kind === "UPDATE" ? "تمدید یا تغییر سرویس تأیید شد" : "سرویس لغو شد"}.\nشناسه سرویس: ${service.id}\nپنل اصلی: ${panel.name}`,
              reply_markup: {
                inline_keyboard:
                  op.kind === "REVOKE"
                    ? [[{ text: "سفارش‌ها", callback_data: "/orders" }]]
                    : [
                        [
                          {
                            text: "🔗 اتصال و وضعیت واقعی",
                            callback_data: `/service ${service.id}`,
                          },
                        ],
                        [
                          {
                            text: "دریافت لینک اتصال",
                            callback_data: `/connect ${service.id}`,
                          },
                        ],
                      ],
              },
            },
            {
              sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='PROCESSING')",
              params: [op.id, op.claim_id],
            },
          )
        : [];
      await env.DB.batch([
        ...messages,

        stmt(
          env,
          "UPDATE services SET state=?,bytes=?,expires_at=?,renewed_at=CASE WHEN ? THEN ? ELSE renewed_at END WHERE bot_id=? AND id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='PROCESSING')",
          op.kind === "REVOKE" ? "REVOKED" : "ACTIVE",
          desired.bytes,
          desired.expires_at,
          op.kind === "UPDATE" ? 1 : 0,
          now(),
          op.bot_id,
          service.id,
          op.id,
          op.claim_id,
        ),
        stmt(
          env,
          "UPDATE operations SET state='SUCCEEDED',error_code=NULL,completed_at=? WHERE id=? AND claim_id=?",
          now(),
          op.id,
          op.claim_id,
        ),
        stmt(
          env,
          "UPDATE orders SET state='FULFILLED' WHERE bot_id=? AND id=? AND state IN('PROVISIONING','FAILED') AND EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='SUCCEEDED')",
          op.bot_id,
          op.order_id ?? service.order_id,
          op.id,
          op.claim_id,
        ),
      ]);
    } catch (e) {
      const code = failCode(e);
      const permanent = [
        "PANEL_CLIENT_CONFLICT",
        "SERVICE_NOT_FOUND",
        "SERVICE_MISSING_REMOTE",
        "UNSUPPORTED_PANEL",
        "REMOTE_STATE_CHANGED",
      ].includes(code);
      await run(
        env,
        "UPDATE operations SET state=?,error_code=?,next_at=? WHERE id=? AND claim_id=?",
        permanent ? "FAILED" : "UNKNOWN",
        code,
        now() + Math.min(1800, 30 * 2 ** op.attempts),
        op.id,
        op.claim_id,
      );
      if (permanent && op.kind === "CREATE") {
        await env.DB.batch([
          stmt(
            env,
            "UPDATE services SET state='FAILED' WHERE bot_id=? AND id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='FAILED')",
            op.bot_id,
            op.service_id,
            op.id,
            op.claim_id,
          ),
          stmt(
            env,
            "UPDATE orders SET state='FAILED' WHERE bot_id=? AND id=(SELECT order_id FROM services WHERE bot_id=? AND id=?) AND EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='FAILED')",
            op.bot_id,
            op.bot_id,
            op.service_id,
            op.id,
            op.claim_id,
          ),
        ]);
      }
      if (permanent && op.order_id)
        await run(
          env,
          "UPDATE orders SET state='FAILED' WHERE bot_id=? AND id=? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state='FAILED')",
          op.bot_id,
          op.order_id,
          op.id,
          op.claim_id,
        );
      if (permanent || op.attempts >= 5) {
        const svc = await one<Service>(
          env,
          "SELECT * FROM services WHERE bot_id=? AND id=?",
          op.bot_id,
          op.service_id,
        );
        if (svc)
          await env.DB.batch(
            await messageStatements(
              env,
              `failure:${op.id}:${op.attempts}`,
              op.bot_id,
              svc.customer_id,
              {
                text: `آماده‌سازی سرویس نیازمند بررسی مدیر است.\n${errorText(code)}\nاگر پرداخت شما تأیید شده، دوباره پرداخت نکنید.\nشناسه عملیات: ${op.id}`,
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: "پشتیبانی", callback_data: "/support" },
                      { text: "سفارش‌ها", callback_data: "/orders" },
                    ],
                  ],
                },
              },
              {
                sql: "EXISTS(SELECT 1 FROM operations WHERE id=? AND claim_id=? AND state IN('UNKNOWN','FAILED'))",
                params: [op.id, op.claim_id],
              },
            ),
          );
      }
      console.error(
        JSON.stringify({ event: "operation_failed", id: op.id, code }),
      );
    }
  }
}
