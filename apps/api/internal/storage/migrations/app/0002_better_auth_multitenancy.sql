CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  accessToken TEXT,
  refreshToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  idToken TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT,
  updatedAt TEXT
);
CREATE INDEX IF NOT EXISTS session_user_idx ON session(userId);
CREATE INDEX IF NOT EXISTS account_user_idx ON account(userId);
CREATE INDEX IF NOT EXISTS account_provider_idx ON account(providerId, accountId);

CREATE TABLE locations_v2 (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
INSERT INTO locations_v2 SELECT id, 'legacy', name, latitude, longitude, is_default, created_at, updated_at FROM locations;
DROP TABLE locations;
ALTER TABLE locations_v2 RENAME TO locations;

CREATE TABLE provider_settings_v2 (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  encrypted_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TEXT,
  app_version TEXT,
  app_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);
INSERT INTO provider_settings_v2 SELECT 'legacy', provider, encrypted_token, encrypted_refresh_token, token_expires_at, app_version, app_id, updated_at FROM provider_settings;
DROP TABLE provider_settings;
ALTER TABLE provider_settings_v2 RENAME TO provider_settings;

CREATE TABLE scans_v2 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  source TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  vendor_count INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  deal_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT
);
INSERT INTO scans_v2 SELECT id, 'legacy', location_id, threshold, source, mode, status, started_at, finished_at, created_at, vendor_count, product_count, deal_count, error_code, error_message FROM scans;
DROP TABLE scans;
ALTER TABLE scans_v2 RENAME TO scans;
CREATE INDEX IF NOT EXISTS scans_user_location_created ON scans(user_id, location_id, created_at DESC);
