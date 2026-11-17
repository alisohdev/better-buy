CREATE TABLE push_subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 encrypted_subscription TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(user_id);
