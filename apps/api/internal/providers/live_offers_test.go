package providers

import (
	"context"
	"encoding/json"
	"testing"
)

func TestLiveOfferMergeIsIndependentOfArrivalOrder(t *testing.T) {
	c := &Collector{db: openJournalTestDB(t)}
	job := stressJob(t, c, "merge-live")
	old := liveObservation{Key: "1:1", ObservedNano: 10, CategoryID: 1, Offer: &Deal{Key: "1:1", Title: "old"}}
	newer := liveObservation{Key: "1:1", ObservedNano: 20, CategoryID: 1, Offer: &Deal{Key: "1:1", Title: "new"}}
	for _, order := range [][]liveObservation{{newer, old}, {old, newer}} {
		if _, err := c.db.Exec(`DELETE FROM scan_live_offers`); err != nil {
			t.Fatal(err)
		}
		for _, item := range order {
			if err := job.journal.publishLiveOffers(context.Background(), []liveObservation{item}); err != nil {
				t.Fatal(err)
			}
		}
		var value string
		if err := c.db.QueryRow(`SELECT offer_json FROM scan_live_offers`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		var offer Deal
		if err := json.Unmarshal([]byte(value), &offer); err != nil {
			t.Fatal(err)
		}
		if offer.Title != "new" || !newerLiveObservation(newer, old) {
			t.Fatal("merge lost latest observation")
		}
		if err := job.journal.publishLiveOffers(context.Background(), []liveObservation{{Key: "1:1", ObservedNano: 30, CategoryID: 2}}); err != nil {
			t.Fatal(err)
		}
		if err := job.journal.publishLiveOffers(context.Background(), []liveObservation{newer}); err != nil {
			t.Fatal(err)
		}
		var tombstones int
		if err := c.db.QueryRow(`SELECT COUNT(*) FROM scan_live_offers WHERE offer_json IS NULL`).Scan(&tombstones); err != nil || tombstones != 1 {
			t.Fatal("older observation revived removed offer", err)
		}
	}
}
