ALTER TABLE deals ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown'
  CHECK (availability IN ('available', 'unavailable', 'unknown'));
ALTER TABLE deals ADD COLUMN stock_quantity INTEGER;
UPDATE deals SET availability = CASE WHEN stock > 0 THEN 'available' ELSE 'unknown' END,
  stock_quantity = CASE WHEN stock > 0 THEN stock ELSE NULL END;
