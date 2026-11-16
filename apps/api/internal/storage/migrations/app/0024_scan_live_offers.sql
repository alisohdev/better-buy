CREATE TABLE scan_live_offers (
 scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
 deal_key TEXT NOT NULL,
 offer_json TEXT,
 observed_nano INTEGER NOT NULL,
 category_id INTEGER NOT NULL,
 PRIMARY KEY(scan_id,deal_key)
);
CREATE TRIGGER scan_live_offers_terminal_cleanup AFTER UPDATE OF status ON scans
WHEN NEW.status IN ('succeeded','failed','cancelled')
BEGIN
 DELETE FROM scan_live_offers WHERE scan_id=NEW.id;
END;
