-- Additive migration: existing orders/payment history are preserved as LEGACY.
ALTER TABLE orders ADD COLUMN payment_state TEXT NOT NULL DEFAULT 'LEGACY' CHECK(payment_state IN('LEGACY','UNCONFIGURED','NOT_REQUIRED','AWAITING_RECEIPT','UNDER_REVIEW','MORE_EVIDENCE','APPROVED','REJECTED','CANCELLED'));
ALTER TABLE orders ADD COLUMN current_review_id TEXT;
ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'CREATE' CHECK(kind IN('CREATE','RENEW','IMPORT'));
ALTER TABLE orders ADD COLUMN target_service_id TEXT;
ALTER TABLE operations ADD COLUMN claim_id TEXT;
ALTER TABLE webhook_updates ADD COLUMN claim_id TEXT;
ALTER TABLE outbox ADD COLUMN claim_id TEXT;
CREATE TABLE bank_settings (bot_id TEXT PRIMARY KEY REFERENCES bots(id), settings_enc TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN(0,1)), updated_by INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE order_snapshots (order_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, plan_name TEXT NOT NULL, description TEXT NOT NULL,
 inbound_id INTEGER NOT NULL, bytes INTEGER NOT NULL, days INTEGER NOT NULL, service_id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL UNIQUE,
 recipient_enc TEXT, FOREIGN KEY(bot_id,order_id) REFERENCES orders(bot_id,id));
CREATE TABLE manual_reviews (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, order_id TEXT NOT NULL, customer_id INTEGER NOT NULL,
 evidence_enc TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('PENDING','APPROVED','REJECTED','MORE_EVIDENCE')),
 request_key TEXT NOT NULL, reviewer_id INTEGER, reason_enc TEXT, decision_key TEXT UNIQUE, created_at INTEGER NOT NULL, reviewed_at INTEGER,
 UNIQUE(bot_id,id), UNIQUE(bot_id,request_key), FOREIGN KEY(bot_id,order_id) REFERENCES orders(bot_id,id), FOREIGN KEY(bot_id,customer_id) REFERENCES customers(bot_id,user_id));
CREATE UNIQUE INDEX one_pending_review ON manual_reviews(bot_id,order_id) WHERE state='PENDING';
CREATE INDEX review_queue ON manual_reviews(bot_id,state,created_at);
CREATE UNIQUE INDEX one_manual_payment ON payments(bot_id,order_id) WHERE provider='manual-card';
ALTER TABLE payments ADD COLUMN reviewer_id INTEGER;
ALTER TABLE payments ADD COLUMN review_id TEXT;
CREATE TABLE receipt_sessions (bot_id TEXT NOT NULL, user_id INTEGER NOT NULL, order_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(bot_id,user_id), FOREIGN KEY(bot_id,order_id) REFERENCES orders(bot_id,id), FOREIGN KEY(bot_id,user_id) REFERENCES customers(bot_id,user_id));
CREATE TABLE review_sessions (bot_id TEXT NOT NULL, user_id INTEGER NOT NULL, review_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('REJECT','MORE_EVIDENCE')), expires_at INTEGER NOT NULL,
 PRIMARY KEY(bot_id,user_id), FOREIGN KEY(bot_id,review_id) REFERENCES manual_reviews(bot_id,id));
CREATE TABLE purchase_intents (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, customer_id INTEGER NOT NULL, plan_id TEXT NOT NULL,
 panel_id TEXT NOT NULL, target_service_id TEXT, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(bot_id,customer_id) REFERENCES customers(bot_id,user_id), FOREIGN KEY(bot_id,plan_id) REFERENCES plans(bot_id,id), FOREIGN KEY(bot_id,panel_id) REFERENCES panels(bot_id,id), FOREIGN KEY(bot_id,target_service_id) REFERENCES services(bot_id,id));
CREATE TABLE routing_rules (bot_id TEXT NOT NULL, customer_id INTEGER NOT NULL, panel_id TEXT NOT NULL,
 PRIMARY KEY(bot_id,customer_id), FOREIGN KEY(bot_id,panel_id) REFERENCES panels(bot_id,id));
ALTER TABLE operations ADD COLUMN order_id TEXT;
DROP INDEX one_open_customer_plan;
CREATE UNIQUE INDEX one_open_customer_plan ON orders(bot_id,customer_id,plan_id,COALESCE(target_service_id,'')) WHERE state IN('UNCONFIGURED','AWAITING_PAYMENT','FREE','PAID','PROVISIONING');
