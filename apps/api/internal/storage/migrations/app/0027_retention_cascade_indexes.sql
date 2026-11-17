CREATE INDEX product_projection_scan_cleanup ON product_projection_scans(scan_id);
CREATE INDEX saved_products_scan_cleanup ON saved_products(scan_id);
CREATE INDEX saved_product_offers_scan_cleanup ON saved_product_offers(scan_id);
CREATE INDEX scan_start_intents_cleanup ON scan_start_intents(scan_id);
