package products

import (
	"context"
	"encoding/json"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

func (s *Service) previewDeals(ctx context.Context, queue *scans.Queue, userID, scanID string) ([]DealRecord, *scans.Record, error) {
	scan, err := queue.Get(ctx, userID, scanID)
	if err != nil {
		return nil, nil, err
	}
	if scan.Status == "succeeded" {
		return s.Deals(ctx, queue, userID, scanID)
	}
	if scan.Status != "running" && scan.Status != "queued" && scan.Status != "cancelled" {
		return nil, &scan, &scans.Error{Code: "SCAN_NOT_PUBLISHED", Message: "Live results are unavailable for this scan.", Status: 409}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT o.offer_json FROM scan_live_offers o JOIN scans s ON s.id=o.scan_id WHERE o.scan_id=? AND s.user_id=? AND s.status IN ('running','cancelled') AND o.offer_json IS NOT NULL UNION ALL SELECT json_extract(c.offer_json,'$.Offer') FROM scan_campaign_contributions c JOIN scans s ON s.id=c.scan_id WHERE c.scan_id=? AND s.user_id=? AND s.status IN ('running','cancelled') AND c.state='accepted' AND json_type(c.offer_json,'$.Offer')='object' AND c.deal_key NOT IN (SELECT bad.deal_key FROM scan_campaign_contributions bad WHERE bad.scan_id=? AND bad.state='quarantined')`, scanID, userID, scanID, userID, scanID)
	if err != nil {
		return nil, &scan, err
	}
	defer rows.Close()
	deals := make([]DealRecord, 0)
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, &scan, err
		}
		var value struct {
			DealRecord
			Facts json.RawMessage `json:"facts"`
		}
		if err := json.Unmarshal([]byte(encoded), &value); err != nil {
			return nil, &scan, err
		}
		item := value.DealRecord
		item.ScanID = scanID
		item.State = "current"
		if item.Availability == "" {
			if item.Stock > 0 {
				item.Availability = "available"
			} else {
				item.Availability = "unavailable"
			}
		}
		if scan.Source != "digikalajet" {
			quantity := int(item.Stock)
			item.StockQuantity = &quantity
		}
		var facts struct {
			VendorLogoURL       *string  `json:"vendorLogoUrl"`
			Benefit             *Benefit `json:"benefit"`
			ObservedAt          string   `json:"observedAt"`
			Provenance          []string `json:"provenance"`
			ObservationPriority int      `json:"observationPriority"`
		}
		if err := json.Unmarshal(value.Facts, &facts); err != nil {
			return nil, &scan, err
		}
		item.VendorLogoURL = facts.VendorLogoURL
		item.Benefit = facts.Benefit
		item.ObservedAt = facts.ObservedAt
		item.Provenance = facts.Provenance
		item.ObservationPriority = facts.ObservationPriority
		deals = append(deals, item)
	}
	return deals, &scan, rows.Err()
}
