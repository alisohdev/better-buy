package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type okalaTestTransport func(*http.Request) (*http.Response, error)

func (f okalaTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestOkalaCollectsCatalogueBeyondCampaignAndCategoryCaps(t *testing.T) {
	db := openJournalTestDB(t)
	claim := insertRunningJournalScan(t, db, "okala-catalogue", time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339))
	calls := map[string]int{}
	var callsMu sync.Mutex
	product := func(id int, discount int) map[string]any {
		return map[string]any{"id": id, "storeId": 2223, "name": fmt.Sprintf("Product %d", id), "discountPercent": discount, "quantity": 2, "hasQuantity": true, "price": 1000, "okPrice": 600}
	}
	collector := &Collector{db: db, client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		key := r.URL.Path + "?" + r.URL.RawQuery
		callsMu.Lock()
		calls[key]++
		callsMu.Unlock()
		var body any
		switch r.URL.Path {
		case "/api/opex/v4/stores/nearby":
			body = map[string]any{"success": true, "data": map[string]any{"stores": []any{map[string]any{"storeId": 2223, "storeName": "Test store", "logoUrl": "https://example.com/store.png", "isActive": true, "isServes": true, "isExist": true}, map[string]any{"storeId": 2223, "isActive": true, "isServes": true, "isExist": true}, map[string]any{"storeId": 999, "isActive": false, "isServes": true, "isExist": true}}}}
		case "/api/unicorn/v3/categories/nearby":
			body = map[string]any{"success": true, "data": map[string]any{"categories": []any{map[string]any{"id": 1, "name": "All", "children": []any{map[string]any{"id": 2, "name": "Shampoo"}, map[string]any{"id": 3, "name": "Other"}}}}}}
		case "/api/unicorn/v2/products/store/2223":
			ps := []any{}
			switch r.URL.Query().Get("cId") {
			case "1":
				for i := 1; i <= 350; i++ {
					ps = append(ps, product(i, 40))
				}
			case "2":
				for i := 351; i <= 600; i++ {
					ps = append(ps, product(i, 34))
				}
			case "3":
				ps = []any{product(600, 34), product(601, 14), product(602, 40)}
				ps[2].(map[string]any)["quantity"] = 0
			default:
				t.Errorf("unexpected category %s", r.URL.RawQuery)
			}
			body = map[string]any{"success": true, "data": ps}
		default:
			t.Errorf("unexpected campaign request %s", r.URL)
			body = map[string]any{"success": false}
		}
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encoded))), Request: r}, nil
	})}}
	job, err := collector.loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	job.Threshold = 15
	result, err := collector.collectOkala(context.Background(), &job)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Deals) != 600 || result.ProductCount != 602 || result.VendorCount != 1 || result.Coverage != "complete" {
		t.Fatalf("catalogue result: deals=%d products=%d stores=%d coverage=%s", len(result.Deals), result.ProductCount, result.VendorCount, result.Coverage)
	}
	for _, deal := range result.Deals {
		if deal.VendorTitle != "Test store" {
			t.Fatalf("lost store title: %+v", deal)
		}
	}
	// A retry must replay the saved responses without issuing more upstream requests.
	before := 0
	for _, count := range calls {
		before += count
	}
	if _, err := collector.collectOkala(context.Background(), &job); err != nil {
		t.Fatal(err)
	}
	after := 0
	for _, count := range calls {
		after += count
	}
	if after != before {
		t.Fatalf("retry made %d additional requests", after-before)
	}
}

func TestOkalaUnavailableFeedKeepsOtherResultsAndMarksCoverageIncomplete(t *testing.T) {
	for _, scenario := range []string{"store-categories", "category-products"} {
		t.Run(scenario, func(t *testing.T) {
			db := openJournalTestDB(t)
			claim := insertRunningJournalScan(t, db, "okala-unavailable-"+scenario, time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339))
			collector := &Collector{db: db, client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
				var body string
				switch r.URL.Path {
				case "/api/opex/v4/stores/nearby":
					body = `{"success":true,"data":{"stores":[{"storeId":2223,"storeName":"Available","isActive":true,"isServes":true,"isExist":true},{"storeId":51680,"storeName":"Unavailable","isActive":true,"isServes":true,"isExist":true}]}}`
				case "/api/unicorn/v3/categories/nearby":
					if r.URL.Query().Get("sId") == "51680" {
						body = `{"data":null,"success":false,"tags":null,"errorMessage":null}`
					} else if scenario == "category-products" {
						body = `{"success":true,"data":{"categories":[{"id":1,"name":"Unavailable category"},{"id":2,"name":"Available category"}]}}`
					} else {
						body = `{"success":true,"data":{"categories":[{"id":2,"name":"Available category"}]}}`
					}
				case "/api/unicorn/v2/products/store/2223":
					if scenario == "category-products" && r.URL.Query().Get("cId") == "1" {
						body = `{"data":null,"success":false,"tags":null,"errorMessage":null}`
					} else {
						body = `{"success":true,"data":[{"id":7,"storeId":2223,"name":"Available product","discountPercent":40,"quantity":2,"hasQuantity":true,"price":1000,"okPrice":600}]}`
					}
				default:
					t.Fatalf("unexpected endpoint %s", r.URL)
				}
				return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}}
			job, err := collector.loadScanJob(context.Background(), claim)
			if err != nil {
				t.Fatal(err)
			}
			result, err := collector.collectOkala(context.Background(), &job)
			if err != nil {
				t.Fatal(err)
			}
			if result.Coverage != "incomplete" || len(result.Deals) != 1 || result.ProductCount != 1 {
				t.Fatalf("unexpected partial result: deals=%d products=%d coverage=%s", len(result.Deals), result.ProductCount, result.Coverage)
			}
			if scenario == "store-categories" && result.VendorCount != 1 {
				t.Fatalf("complete store count=%d, want 1", result.VendorCount)
			}
		})
	}
}

func TestOkalaRejectsTruncatedLeafAndInvalidCatalogue(t *testing.T) {
	for _, scenario := range []string{"saturated-leaf", "null-data", "wrong-store", "additional-pages"} {
		t.Run(scenario, func(t *testing.T) {
			db := openJournalTestDB(t)
			claim := insertRunningJournalScan(t, db, "okala-invalid", time.Now().UTC().Format(time.RFC3339), time.Now().UTC().Format(time.RFC3339))
			collector := &Collector{db: db, client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
				body := `{"success":true,"data":{"stores":[{"storeId":2223,"isActive":true,"isServes":true,"isExist":true}]}}`
				if strings.Contains(r.URL.Path, "categories") {
					body = `{"success":true,"data":{"categories":[{"id":1,"name":"Leaf"}]}}`
				}
				if strings.Contains(r.URL.Path, "products") {
					ps := []any{}
					if scenario == "saturated-leaf" {
						for i := 0; i < 350; i++ {
							ps = append(ps, map[string]any{"id": i + 1, "storeId": 2223})
						}
					}
					if scenario == "null-data" {
						ps = nil
					}
					if scenario == "wrong-store" {
						ps = append(ps, map[string]any{"id": 1, "storeId": 999})
					}
					encoded, _ := json.Marshal(map[string]any{"success": true, "data": ps, "hasNextPage": scenario == "additional-pages"})
					body = string(encoded)
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}}
			job, err := collector.loadScanJob(context.Background(), claim)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := collector.collectOkala(context.Background(), &job); err == nil {
				t.Fatal("incomplete catalogue reported success")
			}
		})
	}
}
