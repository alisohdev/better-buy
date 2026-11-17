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

func TestSnappDiscoveryCountersAreDistinctAndClaimAware(t *testing.T) {
	db := openJournalTestDB(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	claim := insertRunningJournalScan(t, db, "discovery-counts", now, now)
	c := &Collector{db: db}
	job, err := c.loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	observations := []scanObservation{{Kind: "vendor", Identity: "1"}, {Kind: "product", Identity: "1:1"}, {Kind: "product", Identity: "1:1"}, {Kind: "product", Identity: "1:2"}}
	for i := 0; i < 2; i++ {
		if err := job.journal.recordDiscoveryObservations(context.Background(), observations); err != nil {
			t.Fatal(err)
		}
	}
	if err := job.Progress(context.Background(), 0, 1); err != nil {
		t.Fatal(err)
	}
	var products, vendors int
	if err := db.QueryRow(`SELECT product_count,vendor_count FROM scans WHERE id=?`, claim.ScanID).Scan(&products, &vendors); err != nil || products != 2 || vendors != 1 {
		t.Fatalf("products=%d vendors=%d err=%v", products, vendors, err)
	}
	if _, err := db.Exec(`UPDATE scans SET status='cancelled' WHERE id=?`, claim.ScanID); err != nil {
		t.Fatal(err)
	}
	if err := job.journal.recordDiscoveryObservations(context.Background(), []scanObservation{{Kind: "product", Identity: "1:3"}}); err == nil {
		t.Fatal("stopped collector updated progress")
	}
}
