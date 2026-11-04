CREATE TABLE provider_carts (
  user_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('snappmarket','okala')),
  group_key TEXT NOT NULL,
  title TEXT NOT NULL,
  image TEXT,
  category_title TEXT,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  origin_scan_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, source, group_key)
);
CREATE INDEX provider_carts_tenant_source ON provider_carts(user_id, source, created_at, group_key);
