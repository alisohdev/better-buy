CREATE TABLE okala_offer_cache (
  request_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('fetching','ready','failed','noncacheable')),
  payload_json TEXT,
  observed_at TEXT,
  reusable_until TEXT,
  lease_until TEXT,
  fencing_token TEXT,
  failure_code TEXT,
  failure_message TEXT,
  updated_at TEXT NOT NULL,
  CHECK(state!='ready' OR (payload_json IS NOT NULL AND observed_at IS NOT NULL AND reusable_until IS NOT NULL))
);
CREATE INDEX okala_offer_cache_lease_idx ON okala_offer_cache(state,lease_until);

CREATE TABLE scan_offer_observations (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  reusable_until TEXT NOT NULL,
  reused INTEGER NOT NULL CHECK(reused IN (0,1)),
  PRIMARY KEY(scan_id,request_key)
);

CREATE TABLE scan_offer_coordination (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  started_at TEXT NOT NULL,
  PRIMARY KEY(scan_id,request_key)
);
