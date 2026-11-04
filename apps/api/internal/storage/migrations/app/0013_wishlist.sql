CREATE TABLE wishlist_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  phrase TEXT NOT NULL,
  normalized_phrase TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, normalized_phrase)
);
CREATE TABLE wishlist_preferences (
  user_id TEXT PRIMARY KEY,
  default_location_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE wishlist_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  matches_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX wishlist_notifications_inbox ON wishlist_notifications(user_id, created_at DESC, id);
CREATE TABLE wishlist_seen (
  user_id TEXT NOT NULL,
  wishlist_id TEXT NOT NULL REFERENCES wishlist_items(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  product_id TEXT NOT NULL,
  price REAL NOT NULL,
  PRIMARY KEY(user_id, wishlist_id, scope, product_id)
);
CREATE TABLE wishlist_scan_receipts (
  scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  encrypted_subscription TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_owner ON push_subscriptions(user_id);
CREATE TABLE wishlist_push_deliveries (
  notification_id TEXT NOT NULL REFERENCES wishlist_notifications(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  delivered_at TEXT,
  PRIMARY KEY(notification_id, subscription_id)
);
CREATE INDEX wishlist_push_pending ON wishlist_push_deliveries(delivered_at, next_attempt_at);
