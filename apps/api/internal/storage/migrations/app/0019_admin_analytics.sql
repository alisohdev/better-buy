CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('visit', 'search')),
  query TEXT,
  source TEXT CHECK (source IN ('snappmarket', 'okala', 'digikalajet', 'all')),
  created_at TEXT NOT NULL,
  CHECK ((kind = 'visit' AND query IS NULL AND source IS NULL) OR
         (kind = 'search' AND query IS NOT NULL AND source IS NOT NULL))
);
CREATE INDEX analytics_events_created ON analytics_events(created_at, kind);
CREATE INDEX analytics_events_user ON analytics_events(user_id, kind, created_at DESC);
CREATE INDEX analytics_events_search ON analytics_events(query, created_at) WHERE kind = 'search';
