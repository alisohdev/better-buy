CREATE INDEX IF NOT EXISTS locations_user_id_id
  ON locations(user_id, id);

CREATE INDEX IF NOT EXISTS scans_user_location_scope
  ON scans(user_id, location_id, threshold, source, mode, status, created_at DESC);
