CREATE TABLE vps_scan_jobs (
  instance_id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL UNIQUE REFERENCES scans(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'stopped')),
  ready_at INTEGER NOT NULL,
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  worker_failures INTEGER NOT NULL DEFAULT 0 CHECK (worker_failures >= 0),
  stop_reason TEXT CHECK (stop_reason IN ('complete', 'errored', 'terminated')),
  owner_boot_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX vps_scan_jobs_ready
  ON vps_scan_jobs(state, ready_at, created_at);

CREATE TABLE vps_scan_steps (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('running', 'retry_wait', 'succeeded', 'sleeping', 'complete', 'failed')
  ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at INTEGER,
  wake_at INTEGER,
  result_version INTEGER,
  result_json TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scan_id, step_name)
);

CREATE INDEX vps_scan_steps_state
  ON vps_scan_steps(scan_id, state, retry_at, wake_at);

CREATE TABLE vps_maintenance_ticks (
  task TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'complete', 'failed')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task, scheduled_at)
);
