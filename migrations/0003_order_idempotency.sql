-- A customer must resolve/cancel an open order before starting the same plan again.
-- Existing installations with duplicate open orders must reconcile those records
-- before applying this uniqueness index; no automatic deletion is performed.
CREATE UNIQUE INDEX one_open_customer_plan ON orders(bot_id,customer_id,plan_id)
WHERE state IN('UNCONFIGURED','AWAITING_PAYMENT','FREE','PAID','PROVISIONING');
ALTER TABLE outbox ADD COLUMN error_code TEXT;
