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

func TestSnappCapturedBestDealsAndRootSections(t *testing.T) {
	body, err := os.ReadFile("testdata/snapp_hyperstar_sections.json")
	if err != nil {
		t.Fatal(err)
	}
	root, err := decodeObject(body)
	if err != nil {
		t.Fatal(err)
	}
	ids := snappStoreCampaignIDs(root)
	for _, id := range []int64{2192, 20853, 21115, 20724, 21417, 21416, 20086, 20531, 21280, 21412} {
		if !ids[id] {
			t.Errorf("missing collection %d", id)
		}
	}
	if ids[20552] {
		t.Fatal("hot_deals must not become ordinary offers")
	}
	data, err := os.ReadFile("testdata/snapp_best_deals_page.json")
	if err != nil {
		t.Fatal(err)
	}
	page, err := parseCampaignPage(data, CampaignScope{VendorID: 117172, VendorCode: "0wqkoz", CollectionID: 2192}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if page.Count != 2318 || len(page.Rows) != 10 {
		t.Fatalf("count=%d rows=%d", page.Count, len(page.Rows))
	}
}
func TestSnappCampaignDiscoveryRejectsConditionalSections(t *testing.T) {
	root, _ := decodeObject([]byte(`{"sections":[{"type":"product-list","collection_type":"default","value":1,"requires_pro":true},{"type":"product-list","collection_type":"default","value":2,"config":{}},{"type":"product-list","collection_type":"default","value":3,"config":null}]}`))
	ids := snappStoreCampaignIDs(root)
	if ids[1] || ids[2] || !ids[3] {
		t.Fatal(ids)
	}
}

func TestSnappDiscoversNonMallStoreAndPaginatesBestDeals(t *testing.T) {
	db := openJournalTestDB(t)
	now := time.Now().UTC().Format(time.RFC3339)
	claim := insertRunningJournalScan(t, db, "snapp-best-deals", now, now)
	categoryCalls := map[string]bool{}
	pages := map[int]bool{}
	collector := &Collector{db: db, client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		var body any
		switch r.URL.Path {
		case "/express-vendor/general/vendors-list":
			body = map[string]any{"status": true, "data": map[string]any{"count": 2, "single_super_mall": map[string]any{"code": "other"}, "finalResult": []any{map[string]any{"type": "VENDOR", "data": map[string]any{"code": "other"}}, map[string]any{"type": "VENDOR", "data": map[string]any{"code": "0wqkoz"}}}}}
		case "/express-home/vendor/0wqkoz", "/express-home/vendor/other":
			code := strings.TrimPrefix(r.URL.Path, "/express-home/vendor/")
			id := 117172
			if code == "other" {
				id = 1
			}
			body = map[string]any{"vendorInfo": map[string]any{"id": id, "code": code, "title": "Store", "deliveryData": map[string]any{"doesDeliver": true}}, "sections": []any{map[string]any{"type": "product-list", "collection_type": "default", "value": 123, "config": nil}}}
		case "/mobile/search/categories":
			categoryCalls[r.URL.Query().Get("vendorCode")] = true
			body = map[string]any{"status": true, "items": []any{map[string]any{"id": 731205}}}
		default:
			if strings.HasPrefix(r.URL.Path, "/express-search/product-list/") {
				id := 2192
				vendor := 117172
				count := 105
				if strings.Contains(r.URL.Path, "/123/") {
					id = 123
					count = 0
				}
				if strings.HasSuffix(r.URL.Path, "/other") {
					vendor = 1
					count = 0
				}
				if r.URL.Path == "/express-search/product-list/vendor" {
					id = 0
					count = 0
				}
				page, _ := strconv.Atoi(r.URL.Query().Get("page"))
				rows := []any{}
				if count > 0 {
					pages[page] = true
					for i := page * 100; i < (page+1)*100 && i < count; i++ {
						product := map[string]any{"id": i + 1, "vendor_id": vendor, "document_id": fmt.Sprintf("%d-%d", i+1, vendor), "title": "Product", "price": 1000, "discount": 400, "discountRatio": 40, "stock": 2}
						rows = append(rows, map[string]any{"type": "PRODUCT", "data": product})
					}
				}
				body = map[string]any{"status": true, "data": map[string]any{"id": id, "type": "default", "count": count, "finalResult": rows}}
			} else {
				t.Errorf("unexpected request path %s", r.URL.Path)
				body = map[string]any{"status": false}
			}
		}
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encoded))), Request: r}, nil
	})}}
	job, err := collector.loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	guest := snappGuest{token: "test", expiresAt: time.Now().Add(time.Hour)}
	renewed := false
	scopes, err := collector.planSnappCampaigns(context.Background(), &job, &guest, &renewed)
	if err != nil {
		t.Fatal(err)
	}
	var liveCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM scan_live_offers WHERE scan_id=? AND offer_json IS NOT NULL`, claim.ScanID).Scan(&liveCount); err != nil || liveCount == 0 {
		t.Fatalf("discovery products not streamed: %d %v", liveCount, err)
	}
	var observedCount int
	if err := db.QueryRow(`SELECT product_count FROM scans WHERE id=?`, claim.ScanID).Scan(&observedCount); err != nil || observedCount == 0 {
		t.Fatalf("examined product count stuck during discovery: %d %v", observedCount, err)
	}
	if err := job.Progress(context.Background(), 0, 0); err != nil {
		t.Fatal(err)
	}
	var replayCount int
	if err := db.QueryRow(`SELECT product_count FROM scans WHERE id=?`, claim.ScanID).Scan(&replayCount); err != nil || replayCount != observedCount {
		t.Fatalf("progress regressed: %d -> %d (%v)", observedCount, replayCount, err)
	}
	if !categoryCalls["other"] || !categoryCalls["0wqkoz"] {
		t.Fatalf("not all stores discovered: %v", categoryCalls)
	}
	found := false
	for _, scope := range scopes {
		if scope.VendorCode == "0wqkoz" && scope.CollectionID == 2192 {
			found = true
		}
	}
	if !found {
		t.Fatal("best-deals missing for non-mall store")
	}
	if err = job.FreezeSnappManifest(context.Background(), scopes); err != nil {
		t.Fatal(err)
	}
	result, err := collector.enrichSnappCampaigns(context.Background(), &job, scopes, map[string]snappVendor{}, scanResult{}, &guest, &renewed)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deals) != 105 || !pages[1] || !pages[2] {
		t.Fatalf("deals=%d pages=%v", len(result.Deals), pages)
	}
}
