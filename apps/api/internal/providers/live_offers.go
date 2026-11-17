package providers

import (
	"context"
	"encoding/json"
)

func (j *journal) publishLiveOffers(ctx context.Context, observations []liveObservation) error {
	if len(observations) == 0 {
		return ctx.Err()
	}
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := j.activeOn(ctx, tx); err != nil {
		return err
	}
	statement, err := tx.PrepareContext(ctx, `INSERT INTO scan_live_offers(scan_id,deal_key,offer_json,observed_nano,category_id) VALUES(?,?,?,?,?) ON CONFLICT(scan_id,deal_key) DO UPDATE SET offer_json=excluded.offer_json,observed_nano=excluded.observed_nano,category_id=excluded.category_id WHERE excluded.observed_nano>scan_live_offers.observed_nano OR (excluded.observed_nano=scan_live_offers.observed_nano AND excluded.category_id>scan_live_offers.category_id)`)
	if err != nil {
		return err
	}
	defer statement.Close()
	for _, observation := range observations {
		var offer any
		if observation.Offer != nil {
			encoded, err := json.Marshal(observation.Offer)
			if err != nil {
				return err
			}
			offer = string(encoded)
		}
		if _, err := statement.ExecContext(ctx, j.claim.ScanID, observation.Key, offer, observation.ObservedNano, observation.CategoryID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Discovery examines catalogue rows before the full collection plan is frozen.
// Count distinct product identities here too, including rows below the threshold.
func (j *journal) recordDiscoveryObservations(ctx context.Context, observations []scanObservation) error {
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := j.activeOn(ctx, tx); err != nil {
		return err
	}
	statement, err := tx.PrepareContext(ctx, `INSERT INTO scan_observations(scan_id,kind,identity) VALUES(?,?,?) ON CONFLICT(scan_id,kind,identity) DO NOTHING`)
	if err != nil {
		return err
	}
	defer statement.Close()
	for _, observation := range observations {
		if _, err := statement.ExecContext(ctx, j.claim.ScanID, observation.Kind, observation.Identity); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE scans SET vendor_count=MAX(vendor_count,(SELECT COUNT(*) FROM scan_observations WHERE scan_id=? AND kind='vendor')),product_count=MAX(product_count,(SELECT COUNT(*) FROM scan_observations WHERE scan_id=? AND kind='product')) WHERE id=? AND user_id=?`, j.claim.ScanID, j.claim.ScanID, j.claim.ScanID, j.claim.UserID)
	if err != nil {
		return err
	}
	return tx.Commit()
}
