-- Widen provider support while preserving every user's saved basket.
CREATE TABLE provider_carts_v3 (
 user_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('snappmarket','okala','digikalajet')),
 group_key TEXT NOT NULL,title TEXT NOT NULL,image TEXT,category_title TEXT,
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
 origin_scan_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(user_id,source,group_key)
);
INSERT INTO provider_carts_v3 SELECT * FROM provider_carts;
DROP TABLE provider_carts;
ALTER TABLE provider_carts_v3 RENAME TO provider_carts;
CREATE INDEX provider_carts_tenant_source ON provider_carts(user_id,source,created_at,group_key);
