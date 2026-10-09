import type { Env } from "./types";
import { id, now, one, run, stmt, failCode, owner } from "./core";
import { open, seal } from "./crypto";
import { telegram, tokenFor } from "./telegram";
export interface Reply {
  text: string;
  reply_markup?: unknown;
  admin_only?: boolean;
  media?: { kind: "photo" | "document"; file_id: string };
}
export async function messageStatements(
  env: Env,
  key: string,
  route: string,
  chatId: number,
  reply: Reply,
  guard?: { sql: string; params: unknown[] },
) {
  const chunks: string[] = [];
  let rest = reply.text;
  while (rest.length) {
    let end = Math.min(reply.media ? 900 : 3500, rest.length);
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (!chunks.length) chunks.push(" ");
  return Promise.all(
    chunks.map(async (chunk, i) => {
      const partKey = `${key}:${i}`;
      return stmt(
        env,
        guard
          ? `INSERT INTO outbox(id,route,chat_id,payload_enc) SELECT ?,?,?,? WHERE ${guard.sql} ON CONFLICT DO NOTHING`
          : "INSERT INTO outbox(id,route,chat_id,payload_enc) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        partKey,
        route,
        chatId,
        await seal(
          env,
          JSON.stringify({
            text: chunk,
            ...(reply.admin_only ? { admin_only: true } : {}),
            ...(i === 0 && reply.media ? { media: reply.media } : {}),
            ...(i === chunks.length - 1 && reply.reply_markup
              ? { reply_markup: reply.reply_markup }
              : {}),
          }),
          `outbox:${partKey}`,
        ),
        ...(guard?.params ?? []),
      );
    }),
  );
}
export async function enqueue(
  env: Env,
  key: string,
  route: string,
  chatId: number,
  reply: Reply,
) {
  await env.DB.batch(await messageStatements(env, key, route, chatId, reply));
}
export async function deliver(env: Env, max = 2) {
  for (let i = 0; i < max; i++) {
    const message = await one<{
      id: string;
      route: string;
      chat_id: number;
      payload_enc: string;
      attempts: number;
      claim_id: string;
    }>(
      env,
      "UPDATE outbox SET state='PROCESSING',attempts=attempts+1,lease_until=?,claim_id=? WHERE id=(SELECT o.id FROM outbox o LEFT JOIN bots b ON b.id=o.route WHERE (o.route='factory' OR b.state='ACTIVE') AND (o.state='PENDING' OR (o.state='PROCESSING' AND o.lease_until<?)) AND o.next_at<=? ORDER BY o.created_at LIMIT 1) RETURNING *",
      now() + 120,
      id(),
      now(),
      now(),
    );
    if (!message) return;
    try {
      const reply = JSON.parse(
        await open(env, message.payload_enc, `outbox:${message.id}`),
      ) as Reply;
      if (reply.admin_only) {
        try {
          await owner(env, message.route, message.chat_id);
        } catch {
          await run(
            env,
            "UPDATE outbox SET state='DEAD',payload_enc='',error_code='ADMIN_PERMISSION_REVOKED' WHERE id=? AND claim_id=?",
            message.id,
            message.claim_id,
          );
          continue;
        }
      }
      const token = await tokenFor(env, message.route);
      if (reply.media) {
        await telegram(
          token,
          reply.media.kind === "photo" ? "sendPhoto" : "sendDocument",
          {
            chat_id: message.chat_id,
            [reply.media.kind === "photo" ? "photo" : "document"]:
              reply.media.file_id,
            caption: reply.text,
            protect_content: true,
            reply_markup: reply.reply_markup,
          },
        );
      } else
        await telegram(token, "sendMessage", {
          chat_id: message.chat_id,
          text: reply.text,
          reply_markup: reply.reply_markup,
        });
      await run(
        env,
        "UPDATE outbox SET state='SENT',payload_enc='',error_code=NULL WHERE id=? AND claim_id=?",
        message.id,
        message.claim_id,
      );
    } catch (e) {
      await run(
        env,
        "UPDATE outbox SET state=?,next_at=?,error_code=? WHERE id=? AND claim_id=?",
        message.attempts >= 5 ? "DEAD" : "PENDING",
        now() + Math.min(900, 2 ** message.attempts * 15),
        failCode(e),
        message.id,
        message.claim_id,
      );
      console.error(
        JSON.stringify({
          event: "outbox_failed",
          id: message.id,
          code: failCode(e),
        }),
      );
    }
  }
}
