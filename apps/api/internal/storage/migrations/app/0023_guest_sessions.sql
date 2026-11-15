CREATE TABLE guest_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX guest_sessions_expiry ON guest_sessions(expires_at);
CREATE TABLE guest_location_imports (
  user_id TEXT NOT NULL,
  guest_location_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  PRIMARY KEY(user_id, guest_location_id)
);
