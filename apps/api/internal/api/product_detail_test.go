package api

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

func TestProductDetailRequiresOwningAccount(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	owner := analyticsTestUser(t, db, cfg, "owner", "owner@example.com", true)
	other := analyticsTestUser(t, db, cfg, "other", "other@example.com", true)
	for _, q := range []string{
		`INSERT INTO locations(id,user_id,name,latitude,longitude,created_at,updated_at) VALUES('location','owner','Home',35.7,51.4,'2026-01-01','2026-01-01')`,
		`INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at) VALUES('scan','owner','location',15,'snappmarket','full','succeeded','2026-01-01')`,
		`INSERT INTO scan_execution(scan_id,user_id,instance_id,device_id,queued_until,created_at) VALUES('scan','owner','instance','device','2026-01-01','2026-01-01')`,
		`INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,vendor_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json) VALUES('deal','scan','deal','product','vendor','Tea','Store',100,50,50,50,2,'{}')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	groups, _, err := products.New(db, cfg.BoxKey).ProductGroups(context.Background(), queue, "owner", "scan")
	if err != nil || len(groups) != 1 {
		t.Fatalf("groups=%v err=%v", groups, err)
	}
	handler := New(db, cfg, queue)
	path := "/api/scans/scan/product-detail?key=" + url.QueryEscape(groups[0].Key)
	if got := analyticsTestRequest(handler, "GET", path, "", owner); got.Code != http.StatusOK {
		t.Fatalf("owner status %d: %s", got.Code, got.Body.String())
	}
	if got := analyticsTestRequest(handler, "GET", path, "", other); got.Code == http.StatusOK {
		t.Fatalf("other account accessed product: %s", got.Body.String())
	}
	if got := analyticsTestRequest(handler, "GET", "/api/scans/scan/product-detail?key=missing", "", owner); got.Code != http.StatusNotFound {
		t.Fatalf("missing product status %d", got.Code)
	}
}
