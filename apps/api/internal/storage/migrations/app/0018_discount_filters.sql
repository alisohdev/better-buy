ALTER TABLE wishlist_items ADD COLUMN min_discount INTEGER NOT NULL DEFAULT 15
  CHECK (min_discount BETWEEN 15 AND 80);

DROP INDEX IF EXISTS scans_one_active_per_user;
CREATE UNIQUE INDEX scans_one_active_per_user_source
  ON scans(user_id, source)
  WHERE status IN ('queued', 'running');
