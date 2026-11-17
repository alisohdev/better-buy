CREATE INDEX scans_retention_scope ON scans(user_id,location_id,source,created_at DESC,id DESC);
CREATE TABLE scan_diagnostics (
 scan_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,
 error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 vendor_count INTEGER NOT NULL DEFAULT 0,product_count INTEGER NOT NULL DEFAULT 0,deal_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX scan_diagnostics_expiry ON scan_diagnostics(updated_at);
CREATE INDEX scan_diagnostics_user ON scan_diagnostics(user_id,updated_at DESC);
INSERT INTO scan_diagnostics SELECT id,user_id,source,status,error_code,created_at,COALESCE(finished_at,created_at),vendor_count,product_count,deal_count FROM scans WHERE julianday(COALESCE(finished_at,created_at))>julianday('now','-3 days');
CREATE TRIGGER scan_diagnostics_status AFTER UPDATE OF status ON scans BEGIN
 INSERT INTO scan_diagnostics VALUES(NEW.id,NEW.user_id,NEW.source,NEW.status,NEW.error_code,NEW.created_at,COALESCE(NEW.finished_at,NEW.created_at),NEW.vendor_count,NEW.product_count,NEW.deal_count)
 ON CONFLICT(scan_id) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,updated_at=excluded.updated_at,vendor_count=excluded.vendor_count,product_count=excluded.product_count,deal_count=excluded.deal_count;
END;
CREATE TABLE scan_delete_requests(scan_id TEXT PRIMARY KEY REFERENCES scans(id) ON DELETE CASCADE,requested_at TEXT NOT NULL);
CREATE TABLE admin_scan_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,admin_id TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX admin_scan_audit_expiry ON admin_scan_audit(created_at);
CREATE VIEW retained_scan_history AS
WITH ranked AS (
 SELECT id,ROW_NUMBER() OVER(PARTITION BY user_id,location_id,source ORDER BY created_at DESC,id DESC) position
 FROM scans WHERE status IN ('succeeded','failed','cancelled') AND julianday(COALESCE(started_at,created_at))>julianday('now','-1 day')
)
SELECT id FROM ranked WHERE position<=3
UNION ALL SELECT id FROM scans WHERE status IN ('queued','running');
