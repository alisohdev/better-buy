CREATE TABLE wishlist_scan_schedule (
  user_id TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  schedule_slot TEXT NOT NULL CHECK (schedule_slot IN ('morning','evening')),
  location_id TEXT NOT NULL,
  location_revision INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, schedule_date, schedule_slot)
);
CREATE TABLE wishlist_scan_schedule_jobs (
  user_id TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  schedule_slot TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('snappmarket','okala')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_after TEXT NOT NULL,
  scan_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, schedule_date, schedule_slot, source),
  FOREIGN KEY (user_id, schedule_date, schedule_slot)
    REFERENCES wishlist_scan_schedule(user_id, schedule_date, schedule_slot) ON DELETE CASCADE
);
CREATE INDEX wishlist_scan_schedule_pending ON wishlist_scan_schedule_jobs(state,retry_after,user_id);
