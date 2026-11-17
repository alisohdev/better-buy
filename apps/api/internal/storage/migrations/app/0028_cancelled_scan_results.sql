DROP TRIGGER scan_live_offers_terminal_cleanup;
CREATE TRIGGER scan_live_offers_terminal_cleanup AFTER UPDATE OF status ON scans
WHEN NEW.status IN ('succeeded','failed')
BEGIN
 DELETE FROM scan_live_offers WHERE scan_id=NEW.id;
END;
CREATE TRIGGER cancelled_scan_result_count AFTER UPDATE OF status ON scans
WHEN NEW.status='cancelled'
BEGIN
 UPDATE scans SET deal_count=(SELECT COUNT(*) FROM (
  SELECT deal_key FROM scan_live_offers WHERE scan_id=NEW.id AND offer_json IS NOT NULL
  UNION
  SELECT deal_key FROM scan_campaign_contributions WHERE scan_id=NEW.id AND state='accepted' AND json_type(offer_json,'$.Offer')='object'
 ) WHERE deal_key NOT IN (SELECT deal_key FROM scan_campaign_contributions WHERE scan_id=NEW.id AND state='quarantined')) WHERE id=NEW.id;
END;
