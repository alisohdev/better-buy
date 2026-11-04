CREATE TABLE api_rate_limits (
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('read','start','cancel')),
  window_start INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK (requests > 0),
  PRIMARY KEY (user_id, bucket, window_start)
);
CREATE INDEX api_rate_limits_expiry ON api_rate_limits(window_start);
