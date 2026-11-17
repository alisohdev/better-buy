package providers

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSnappStreamsBaselineBeforeCampaignDiscovery(t *testing.T) {
	db := openJournalTestDB(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	claim := insertRunningJournalScan(t, db, "snapp-live-first", now, now)
	discoveryReached := false
	stop := errors.New("stop after inspecting discovery boundary")
	c := &Collector{db: db, client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		var body string
		switch {
		case r.URL.Path == "/oauth2/default/token":
			body = `{"status":true,"data":{"access_token":"fixture","expires_in":3600}}`
		case strings.HasPrefix(r.URL.Path, "/market-party/"):
			body = `{"status":true,"data":{"total_count":1,"vendors":[{"vendor_id":1,"products":[{"productVariationId":2,"vendorId":1,"vendorTitle":"Store","title":"Live product","price":1000,"discount":400,"discountRatio":40,"stock":2}]}]}}`
		case r.URL.Path == "/express-vendor/general/vendors-list":
			discoveryReached = true
			var count, pages, products int
			if err := db.QueryRow(`SELECT COUNT(*) FROM scan_live_offers WHERE scan_id=? AND offer_json IS NOT NULL`, claim.ScanID).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 1 {
				t.Fatalf("campaign discovery blocked first live product: got %d offers, want 1", count)
			}
			if err := db.QueryRow(`SELECT COUNT(*) FROM scan_pages WHERE scan_id=? AND complete=1`, claim.ScanID).Scan(&pages); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(`SELECT product_count FROM scans WHERE id=?`, claim.ScanID).Scan(&products); err != nil {
				t.Fatal(err)
			}
			if pages < 1 || products != 1 {
				t.Fatalf("visible progress missing before discovery: pages=%d products=%d", pages, products)
			}
			return nil, stop
		default:
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}}
	job, err := c.loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	job.EnrichmentEnabled = true
	_, _ = c.collectSnapp(context.Background(), &job)
	if !discoveryReached {
		t.Fatal("discovery never started")
	}
}
