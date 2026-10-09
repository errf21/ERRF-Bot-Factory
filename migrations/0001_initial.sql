PRAGMA foreign_keys = ON;
CREATE TABLE tenants (id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE bots (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), telegram_id INTEGER NOT NULL UNIQUE,
 username TEXT NOT NULL, token_enc TEXT NOT NULL, webhook_secret_enc TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('CONFIGURING','ACTIVE','INACTIVE','ERROR','DELETING','DELETED')),
 error_code TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()), UNIQUE(tenant_id,id)
);
CREATE TABLE bot_configs (bot_id TEXT PRIMARY KEY REFERENCES bots(id), tenant_id TEXT NOT NULL,
 config TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(tenant_id,bot_id) REFERENCES bots(tenant_id,id));
CREATE TABLE tenant_admins (tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id INTEGER NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN')), PRIMARY KEY(tenant_id,user_id));
CREATE TABLE customers (bot_id TEXT NOT NULL REFERENCES bots(id), user_id INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(bot_id,user_id));
CREATE TABLE panels (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), name TEXT NOT NULL,
 adapter TEXT NOT NULL CHECK(adapter='sanaei-2.8'), url_enc TEXT NOT NULL, credentials_enc TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN(0,1)),
 health TEXT NOT NULL DEFAULT 'UNTESTED', checked_at INTEGER, UNIQUE(bot_id,id)
);
CREATE UNIQUE INDEX one_default_panel ON panels(bot_id) WHERE is_default=1;
CREATE TABLE plans (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, panel_id TEXT NOT NULL,
 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', inbound_id INTEGER NOT NULL CHECK(inbound_id>0),
 bytes INTEGER NOT NULL CHECK(bytes>0), days INTEGER NOT NULL CHECK(days>0 AND days<=3650),
 price_minor INTEGER NOT NULL CHECK(price_minor>=0), currency TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), UNIQUE(bot_id,id),
 FOREIGN KEY(bot_id,panel_id) REFERENCES panels(bot_id,id));
CREATE TABLE orders (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, customer_id INTEGER NOT NULL, plan_id TEXT NOT NULL,
 panel_id TEXT NOT NULL, request_key TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('UNCONFIGURED','AWAITING_PAYMENT','FREE','PAID','PROVISIONING','FULFILLED','FAILED','CANCELLED')),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()), UNIQUE(bot_id,request_key), UNIQUE(bot_id,id),
 FOREIGN KEY(bot_id,customer_id) REFERENCES customers(bot_id,user_id),
 FOREIGN KEY(bot_id,plan_id) REFERENCES plans(bot_id,id), FOREIGN KEY(bot_id,panel_id) REFERENCES panels(bot_id,id));
CREATE TABLE payments (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, order_id TEXT NOT NULL, provider TEXT NOT NULL,
 provider_event_id TEXT NOT NULL, amount_minor INTEGER NOT NULL, currency TEXT NOT NULL,
 verified_at INTEGER NOT NULL, UNIQUE(provider,provider_event_id), FOREIGN KEY(bot_id,order_id) REFERENCES orders(bot_id,id));
CREATE TABLE services (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, customer_id INTEGER NOT NULL, panel_id TEXT NOT NULL,
 order_id TEXT NOT NULL UNIQUE, inbound_id INTEGER NOT NULL, client_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE,
 bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN('PENDING','ACTIVE','REVOKED','FAILED')),
 created_at INTEGER NOT NULL DEFAULT(unixepoch()), renewed_at INTEGER, UNIQUE(bot_id,id),
 FOREIGN KEY(bot_id,panel_id) REFERENCES panels(bot_id,id), FOREIGN KEY(bot_id,order_id) REFERENCES orders(bot_id,id),
 FOREIGN KEY(bot_id,customer_id) REFERENCES customers(bot_id,user_id));
CREATE TABLE operations (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, service_id TEXT NOT NULL, request_key TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('CREATE','UPDATE','REVOKE')), payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('PENDING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch()), completed_at INTEGER,
 UNIQUE(bot_id,request_key), FOREIGN KEY(bot_id,service_id) REFERENCES services(bot_id,id));
CREATE UNIQUE INDEX one_open_operation ON operations(service_id) WHERE state IN('PENDING','PROCESSING','UNKNOWN');
CREATE TABLE webhook_updates (route TEXT NOT NULL, update_id INTEGER NOT NULL, bot_id TEXT,
 payload_enc TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','PROCESSING','DONE','DEAD')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(route,update_id));
CREATE TABLE outbox (id TEXT PRIMARY KEY, route TEXT NOT NULL, chat_id INTEGER NOT NULL, payload_enc TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN('PENDING','PROCESSING','SENT','DEAD')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT, bot_id TEXT, actor_id INTEGER NOT NULL,
 action TEXT NOT NULL, target_id TEXT, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE global_admins (user_id INTEGER PRIMARY KEY);
CREATE TABLE global_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE rate_limits (scope TEXT PRIMARY KEY, window INTEGER NOT NULL, hits INTEGER NOT NULL);
CREATE INDEX pending_updates ON webhook_updates(state,next_at,lease_until);
CREATE INDEX pending_operations ON operations(state,next_at,lease_until);
CREATE INDEX pending_outbox ON outbox(state,next_at,lease_until);
CREATE INDEX bot_orders ON orders(bot_id,customer_id,created_at);
CREATE INDEX bot_services ON services(bot_id,customer_id);
CREATE INDEX bot_audit ON audit_logs(bot_id,created_at);
