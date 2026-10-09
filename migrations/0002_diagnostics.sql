ALTER TABLE panels ADD COLUMN error_code TEXT;
CREATE TABLE service_notifications (
 bot_id TEXT NOT NULL, service_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(bot_id,service_id,expires_at),
 FOREIGN KEY(bot_id,service_id) REFERENCES services(bot_id,id)
);
