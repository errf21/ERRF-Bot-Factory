import type { Env, Update } from "./types";
import { AppError, failCode, limit, now, one, run, id } from "./core";
import { open } from "./crypto";
import { actor, handle } from "./commands";
import { messageStatements } from "./delivery";
import { errorText } from "./ui";
export async function processUpdates(env: Env, max = 1) {
  for (let n = 0; n < max; n++) {
    const job = await one<{
      route: string;
      update_id: number;
      payload_enc: string;
      attempts: number;
      claim_id: string;
    }>(
      env,
      "UPDATE webhook_updates SET state='PROCESSING',attempts=attempts+1,lease_until=?,claim_id=? WHERE (route,update_id)=(SELECT u.route,u.update_id FROM webhook_updates u LEFT JOIN bots b ON b.id=u.bot_id WHERE (u.route='factory' OR b.state='ACTIVE') AND (u.state='PENDING' OR (u.state='PROCESSING' AND u.lease_until<?)) AND u.next_at<=? ORDER BY u.created_at LIMIT 1) RETURNING *",
      now() + 120,
      id(),
      now(),
      now(),
    );
    if (!job) return;
    const key = `${job.route}:${job.update_id}`;
    let update: Update | undefined;
    try {
      update = JSON.parse(
        await open(env, job.payload_enc, `update:${key}`),
      ) as Update;
      const a = actor(update, job.route);
      if (a) await limit(env, `user:${job.route}:${a.user}`, 30);
      const result = await handle(env, job.route, update);
      if (result && a)
        await env.DB.batch(
          await messageStatements(
            env,
            `reply:${key}`,
            job.route,
            a.chat,
            result,
            {
              sql: "EXISTS(SELECT 1 FROM webhook_updates WHERE route=? AND update_id=? AND claim_id=? AND state='PROCESSING')",
              params: [job.route, job.update_id, job.claim_id],
            },
          ),
        );
      await run(
        env,
        "UPDATE webhook_updates SET state='DONE',payload_enc='' WHERE route=? AND update_id=? AND claim_id=?",
        job.route,
        job.update_id,
        job.claim_id,
      );
    } catch (e) {
      const code = failCode(e);
      const temporary =
        !(e instanceof AppError) ||
        [
          "TELEGRAM_NETWORK_ERROR",
          "TELEGRAM_API_ERROR",
          "TELEGRAM_RATE_LIMIT",
          "CREDENTIAL_DECRYPT_FAILED",
          "PANEL_NETWORK_UNCERTAIN",
          "PANEL_HTTP_ERROR",
        ].includes(code);
      if (temporary && job.attempts < 5) {
        await run(
          env,
          "UPDATE webhook_updates SET state='PENDING',next_at=?,error_code=? WHERE route=? AND update_id=? AND claim_id=?",
          now() + 15 * 2 ** job.attempts,
          code,
          job.route,
          job.update_id,
          job.claim_id,
        );
      } else {
        const a = update ? actor(update, job.route) : null;
        if (a)
          await env.DB.batch(
            await messageStatements(
              env,
              `reply:${key}`,
              job.route,
              a.chat,
              {
                text: `${errorText(code)}\nکد پیگیری: ${code} | ${job.update_id}`,
              },
              {
                sql: "EXISTS(SELECT 1 FROM webhook_updates WHERE route=? AND update_id=? AND claim_id=? AND state='PROCESSING')",
                params: [job.route, job.update_id, job.claim_id],
              },
            ),
          );
        await run(
          env,
          "UPDATE webhook_updates SET state='DEAD',payload_enc='',error_code=? WHERE route=? AND update_id=? AND claim_id=?",
          code,
          job.route,
          job.update_id,
          job.claim_id,
        );
      }
      console.error(
        JSON.stringify({
          event: "update_failed",
          route: job.route,
          update_id: job.update_id,
          code,
        }),
      );
    }
  }
}
