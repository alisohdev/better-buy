CREATE TABLE scan_execution (
 scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL, contract_version INTEGER NOT NULL DEFAULT 1,
 execution_kind TEXT NOT NULL DEFAULT 'workflow',
 instance_id TEXT NOT NULL UNIQUE, dispatch_state TEXT NOT NULL DEFAULT 'dispatch_pending',
 phase TEXT NOT NULL DEFAULT 'queued', device_id TEXT NOT NULL,
 enrichment_enabled INTEGER NOT NULL DEFAULT 0, manifest_frozen INTEGER NOT NULL DEFAULT 0,
 cancel_requested INTEGER NOT NULL DEFAULT 0, attempt_count INTEGER NOT NULL DEFAULT 0,
 guest_401_refreshed INTEGER NOT NULL DEFAULT 0,
 attempt_limit INTEGER NOT NULL DEFAULT 250, page_limit INTEGER NOT NULL DEFAULT 100,
 offer_limit INTEGER NOT NULL DEFAULT 10000, heartbeat_at TEXT,
 deadline_at TEXT NOT NULL, queued_until TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX scan_execution_pending ON scan_execution(dispatch_state, heartbeat_at);
CREATE TABLE scan_start_intents (
 user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,idempotency_key)
);
CREATE TABLE scan_units (
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 unit_id TEXT NOT NULL, descriptor_json TEXT NOT NULL,
 terminal INTEGER NOT NULL DEFAULT 0, terminal_evidence TEXT,
 PRIMARY KEY(scan_id,unit_id)
);
CREATE TABLE scan_pages (
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE, unit_id TEXT NOT NULL,
 page INTEGER NOT NULL, digest TEXT NOT NULL, metadata_json TEXT NOT NULL,
 expected_chunks INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(scan_id,unit_id,page)
);
CREATE TABLE scan_chunks (
 scan_id TEXT NOT NULL, unit_id TEXT NOT NULL, page INTEGER NOT NULL,
 chunk INTEGER NOT NULL, digest TEXT NOT NULL,
 PRIMARY KEY(scan_id,unit_id,page,chunk),
 FOREIGN KEY(scan_id,unit_id,page) REFERENCES scan_pages(scan_id,unit_id,page) ON DELETE CASCADE
);
CREATE TABLE scan_observations (
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(scan_id,kind,identity)
);
CREATE TABLE scan_discovery (
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL, body_json TEXT NOT NULL,
 PRIMARY KEY(scan_id,request_key)
);
CREATE TABLE scan_attempts (
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 operation TEXT NOT NULL, ordinal INTEGER NOT NULL, reserved_at TEXT NOT NULL,
 PRIMARY KEY(scan_id,operation,ordinal)
);
