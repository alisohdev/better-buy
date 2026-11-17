CREATE INDEX okala_offer_cache_retention ON okala_offer_cache(reusable_until,lease_until,request_key);
CREATE INDEX product_projection_baseline ON product_projection_scans(baseline_scan_id);
CREATE INDEX scans_retention_status ON scans(status,created_at,user_id,location_id,source);
