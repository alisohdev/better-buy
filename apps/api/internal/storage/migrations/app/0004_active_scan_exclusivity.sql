CREATE UNIQUE INDEX IF NOT EXISTS scans_one_active_per_user
  ON scans(user_id)
  WHERE status IN ('queued', 'running');
