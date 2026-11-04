CREATE TABLE product_projection_scans (
  user_id TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 2,
  ready INTEGER NOT NULL DEFAULT 0,
  cursor_product_id TEXT NOT NULL DEFAULT '',
  baseline_scan_id TEXT,
  baseline_reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scan_id)
);
CREATE TABLE saved_products (
  user_id TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  search_text TEXT NOT NULL,
  title_sort TEXT NOT NULL,
  presence INTEGER NOT NULL,
  rank_ratio REAL NOT NULL,
  rank_discount REAL NOT NULL,
  rank_price REAL NOT NULL,
  rank_price_desc REAL NOT NULL,
  summary_json TEXT NOT NULL,
  PRIMARY KEY(user_id,scan_id,group_key)
);
CREATE INDEX saved_products_discount ON saved_products(user_id,scan_id,presence,rank_ratio,rank_discount,rank_price,group_key);
CREATE INDEX saved_products_price ON saved_products(user_id,scan_id,presence,rank_price,group_key);
CREATE INDEX saved_products_price_desc ON saved_products(user_id,scan_id,presence,rank_price_desc,group_key);
CREATE INDEX saved_products_title ON saved_products(user_id,scan_id,presence,title_sort,group_key);
CREATE TABLE saved_product_offers (
  user_id TEXT NOT NULL,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  offer_key TEXT NOT NULL,
  conditional INTEGER NOT NULL,
  presence INTEGER NOT NULL,
  final_price REAL NOT NULL,
  vendor_id TEXT NOT NULL,
  offer_json TEXT NOT NULL,
  PRIMARY KEY(user_id,scan_id,group_key,offer_key)
);
CREATE INDEX saved_product_offers_page ON saved_product_offers(user_id,scan_id,group_key,conditional,presence,final_price,vendor_id,offer_key);
CREATE INDEX deals_projection_products ON deals(scan_id,product_variation_id,deal_key);
