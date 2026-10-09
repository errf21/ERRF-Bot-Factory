import type { Env } from "./types";
import { assert, id, now, one, stmt, run } from "./core";
import type { VerifiedPayment } from "./adapters/payment";
import { createOrder } from "./commerce";
export const order = createOrder;
// Retained as a fail-closed compatibility symbol. Card-to-card approvals MUST use decide().
export async function recordVerifiedPayment(
  _env: Env,
  _payment: VerifiedPayment,
): Promise<void> {
  throw new (await import("./core")).AppError("ONLINE_PAYMENTS_DISABLED", 403);
}
export async function serviceOperation(
  env: Env,
  botId: string,
  serviceId: string,
  kind: "UPDATE" | "REVOKE",
  payload: Record<string, unknown>,
  key: string,
) {
  const existing = await one(
    env,
    "SELECT id FROM operations WHERE bot_id=? AND request_key=?",
    botId,
    key,
  );
  if (existing) return;
  const s = await one<{ state: string }>(
    env,
    "SELECT state FROM services WHERE bot_id=? AND id=?",
    botId,
    serviceId,
  );
  assert(s?.state === "ACTIVE", "SERVICE_NOT_ACTIVE");
  assert(
    !(await one(
      env,
      "SELECT id FROM operations WHERE bot_id=? AND service_id=? AND state IN ('PENDING','PROCESSING','UNKNOWN')",
      botId,
      serviceId,
    )),
    "SERVICE_BUSY",
  );
  await run(
    env,
    "INSERT INTO operations(id,bot_id,service_id,request_key,kind,payload,state) VALUES(?,?,?,?,?,?,?)",
    id(),
    botId,
    serviceId,
    key,
    kind,
    JSON.stringify(payload),
    "PENDING",
  );
}
