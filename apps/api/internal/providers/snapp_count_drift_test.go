package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestSnappCampaignToleratesSmallCountMovement(t *testing.T) {
	for _, item := range []struct {
		name         string
		first, later int
		fail         bool
	}{
		{"shrink", 230, 227, false}, {"grow", 224, 227, false}, {"missing_rows", 230, 230, true}, {"large_jump", 230, 500, true},
	} {
		t.Run(item.name, func(t *testing.T) { testSnappCountMovement(t, item.first, item.later, item.fail) })
	}
}
func testSnappCountMovement(t *testing.T, first, later int, wantFailure bool) {
	db := openJournalTestDB(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	claim := insertRunningJournalScan(t, db, "count-drift", now, now)
	c := &Collector{db: db, client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		n, _ := strconv.Atoi(r.URL.Query().Get("page"))
		count := later
		if n == 0 {
			count = first
		}
		rows := []any{}
		for i := n * 100; i < (n+1)*100 && i < 227; i++ {
			rows = append(rows, map[string]any{"type": "PRODUCT", "data": map[string]any{"id": i + 1, "vendor_id": 1, "document_id": fmt.Sprintf("%d-1", i+1), "title": "Product", "price": 1000, "discount": 400, "discountRatio": 40, "stock": 2}})
		}
		b, _ := json.Marshal(map[string]any{"status": true, "data": map[string]any{"id": 2192, "type": "default", "count": count, "finalResult": rows}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(b))), Request: r}, nil
	})}}
	job, err := c.loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	scopes := []CampaignScope{{VendorID: 1, VendorCode: "store", VendorTitle: "Store", CollectionID: 2192}}
	if err := job.FreezeSnappManifest(context.Background(), scopes); err != nil {
		t.Fatal(err)
	}
	guest := snappGuest{token: "fixture", expiresAt: time.Now().Add(time.Hour)}
	renewed := false
	result, err := c.enrichSnappCampaigns(context.Background(), &job, scopes, map[string]snappVendor{}, scanResult{}, &guest, &renewed)
	if wantFailure {
		if err == nil {
			t.Fatal("incomplete feed passed validation")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deals) != 227 || result.Coverage != "incomplete" {
		t.Fatalf("deals=%d coverage=%s", len(result.Deals), result.Coverage)
	}
}

func TestSnappMixedStoreOffersUseVerifiedOwner(t *testing.T) {
	row := map[string]any{"id": float64(3), "vendor_id": float64(2), "document_id": "3-2", "title": "Product", "price": float64(1000), "discount": float64(400), "discountRatio": float64(40), "stock": float64(2)}
	scope := CampaignScope{VendorID: 1, VendorCode: "parent", VendorTitle: "Parent", CollectionID: 2192}
	stores := map[int64]CampaignScope{2: {VendorID: 2, VendorCode: "actual", VendorTitle: "Actual"}}
	contribution, _, unresolved, err := campaignProductForScope(row, scope, stores, 15, "2026-11-17T10:00:00Z", time.Now())
	if err != nil || unresolved || contribution.Offer == nil || contribution.Offer.VendorID != "2" || *contribution.Offer.VendorCode != "actual" {
		t.Fatalf("wrong owner: %+v %v", contribution, err)
	}
	contribution, _, unresolved, err = campaignProductForScope(row, scope, nil, 15, "2026-11-17T10:00:00Z", time.Now())
	if err != nil || !unresolved || contribution.Offer != nil {
		t.Fatal("unverified owner was exposed", err)
	}
}

func TestSnappCapturedMixedStorePage(t *testing.T) {
	data, err := os.ReadFile("testdata/snapp_mixed_store_rows.json")
	if err != nil {
		t.Fatal(err)
	}
	var rows []map[string]any
	if err = json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	scope := CampaignScope{VendorID: 117172, VendorCode: "0wqkoz", VendorTitle: "Verified store", CollectionID: 2192}
	accepted, unverified := 0, 0
	for _, row := range rows {
		value, _, unknown, err := campaignProductForScope(row, scope, nil, 15, "2026-11-17T10:00:00Z", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if unknown {
			unverified++
		}
		if value.Offer != nil {
			accepted++
		}
	}
	if accepted == 0 || unverified == 0 {
		t.Fatalf("accepted=%d unverified=%d", accepted, unverified)
	}
}
