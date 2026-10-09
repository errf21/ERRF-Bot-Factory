import type { Env } from "./types";
import { now, stmt, rows, run, id } from "./core";
import { open, seal } from "./crypto";
export async function recoverExhaustedClaims(env: Env) {
  await env.DB.batch([
    stmt(
      env,
      "UPDATE operations SET state='UNKNOWN',error_code='LEASE_EXHAUSTED' WHERE state='PROCESSING' AND attempts>=5 AND lease_until<?",
      now(),
    ),
    stmt(
      env,
      "UPDATE webhook_updates SET state='DEAD',payload_enc='',error_code='LEASE_EXHAUSTED' WHERE state='PROCESSING' AND attempts>=5 AND lease_until<?",
      now(),
    ),
    stmt(
      env,
      "UPDATE outbox SET state='DEAD',payload_enc='',error_code='LEASE_EXHAUSTED' WHERE state='PROCESSING' AND attempts>=5 AND lease_until<?",
      now(),
    ),
  ]);
}
export async function retainFinancialEvidence(env: Env) {
  const cutoff = now() - 90 * 86400;
  await env.DB.batch([
    stmt(
      env,
      "UPDATE manual_reviews SET evidence_enc='' WHERE id IN (SELECT r.id FROM manual_reviews r JOIN orders o ON o.bot_id=r.bot_id AND o.id=r.order_id WHERE r.evidence_enc!='' AND r.state!='PENDING' AND r.reviewed_at<? AND o.state IN('FULFILLED','CANCELLED') LIMIT 50)",
      cutoff,
    ),
    stmt(
      env,
      "UPDATE order_snapshots SET recipient_enc=NULL WHERE order_id IN(SELECT s.order_id FROM order_snapshots s JOIN orders o ON o.bot_id=s.bot_id AND o.id=s.order_id WHERE s.recipient_enc IS NOT NULL AND o.created_at<? AND o.state IN('FULFILLED','CANCELLED') LIMIT 50)",
      cutoff,
    ),
    stmt(env, "DELETE FROM purchase_intents WHERE expires_at<?", now() - 86400),
    stmt(env, "DELETE FROM receipt_sessions WHERE expires_at<?", now()),
    stmt(env, "DELETE FROM review_sessions WHERE expires_at<?", now()),
  ]);
}
export async function rewrapFinance(env: Env, bot: string, actor: number) {
  const query = `SELECT 'bank' AS kind,bot_id AS record_id,settings_enc AS envelope FROM bank_settings WHERE bot_id=? AND json_extract(settings_enc,'$.v')!=?
 UNION ALL SELECT 'recipient',order_id,recipient_enc FROM order_snapshots WHERE bot_id=? AND recipient_enc IS NOT NULL AND json_extract(recipient_enc,'$.v')!=?
 UNION ALL SELECT 'evidence',id,evidence_enc FROM manual_reviews WHERE bot_id=? AND evidence_enc!='' AND json_extract(evidence_enc,'$.v')!=?
 UNION ALL SELECT 'reason',id,reason_enc FROM manual_reviews WHERE bot_id=? AND reason_enc IS NOT NULL AND json_extract(reason_enc,'$.v')!=? LIMIT 8`;
  const args = [
    bot,
    env.KEY_VERSION,
    bot,
    env.KEY_VERSION,
    bot,
    env.KEY_VERSION,
    bot,
    env.KEY_VERSION,
  ];
  const items = await rows<{
    kind: string;
    record_id: string;
    envelope: string;
  }>(env, query, ...args);
  const updates = [];
  for (const item of items) {
    const context =
      item.kind === "bank"
        ? `bank:${bot}`
        : item.kind === "recipient"
          ? `recipient:${bot}:${item.record_id}`
          : `${item.kind}:${bot}:${item.record_id}`;
    const value = await seal(
      env,
      await open(env, item.envelope, context),
      context,
    );
    const mapping: Record<string, [string, string, string]> = {
      bank: ["bank_settings", "settings_enc", "bot_id"],
      recipient: ["order_snapshots", "recipient_enc", "order_id"],
      evidence: ["manual_reviews", "evidence_enc", "id"],
      reason: ["manual_reviews", "reason_enc", "id"],
    };
    const [table, field, pk] = mapping[item.kind]!;
    updates.push(
      stmt(
        env,
        `UPDATE ${table} SET ${field}=? WHERE bot_id=? AND ${pk}=? AND ${field}=?`,
        value,
        bot,
        item.record_id,
        item.envelope,
      ),
    );
  }
  if (updates.length) {
    updates.push(
      stmt(
        env,
        "INSERT INTO audit_logs(id,bot_id,actor_id,action,target_id) VALUES(?,?,?,?,?)",
        id(),
        bot,
        actor,
        "FINANCE_KEY_REWRAP",
        bot,
      ),
    );
    await env.DB.batch(updates);
  }
  return {
    rewrapped: items.length,
    more: (await rows(env, query, ...args)).length > 0,
  };
}
