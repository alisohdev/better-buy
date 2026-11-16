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
