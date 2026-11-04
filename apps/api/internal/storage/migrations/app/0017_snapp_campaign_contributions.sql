ALTER TABLE scan_execution
ADD COLUMN campaign_contribution_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE scan_campaign_contributions (
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  deal_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted','quarantined')),
  offer_json TEXT,
  PRIMARY KEY(scan_id, unit_id, deal_key),
  CHECK(
    (state='accepted' AND offer_json IS NOT NULL) OR
    (state='quarantined' AND offer_json IS NULL)
  )
);
