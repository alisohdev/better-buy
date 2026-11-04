ALTER TABLE locations ADD COLUMN coordinate_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scans ADD COLUMN context_json TEXT;
ALTER TABLE deals ADD COLUMN facts_json TEXT;
CREATE INDEX scans_context_predecessor ON scans(user_id, location_id, source, threshold, status, created_at, id);
