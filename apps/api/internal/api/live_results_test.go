package api

import (
	"encoding/json"
	"fmt"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestLiveResultsTenantIsolationAndLifecycle(t *testing.T) {
	for _, source := range []string{"okala", "snappmarket", "digikalajet"} {
		t.Run(source, func(t *testing.T) { testLiveProvider(t, source) })
	}
}
func testLiveProvider(t *testing.T, source string) {
	db, cfg := analyticsTestDatabase(t)
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, cfg, queue)
	guest := func() *http.Cookie {
		r := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil)
		if r.Code != 200 {
			t.Fatal(r.Body.String())
		}
		return r.Result().Cookies()[0]
	}
	owner, other := guest(), guest()
	saved := analyticsTestRequest(handler, "POST", "/api/locations", `{"name":"Home","latitude":35.7,"longitude":51.4,"isDefault":true}`, owner)
	var loc struct {
		Data location `json:"data"`
	}
	if err := json.Unmarshal(saved.Body.Bytes(), &loc); err != nil {
		t.Fatal(err)
	}
	started := analyticsTestRequest(handler, "POST", "/api/scans", fmt.Sprintf(`{"locationId":%q,"source":%q,"threshold":15,"mode":"partial"}`, loc.Data.ID, source), owner)
	var run struct {
		Data scans.Record `json:"data"`
	}
	if err := json.Unmarshal(started.Body.Bytes(), &run); err != nil || started.Code != 202 {
		t.Fatal(started.Code, started.Body.String(), err)
	}
	id := run.Data.ID
	if _, err := db.Exec(`UPDATE scans SET status='running' WHERE id=?`, id); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 61; i++ {
		offer := fmt.Sprintf(`{"key":"1:%d","productVariationId":"%d","vendorId":"1","title":"Item %d","vendorTitle":"Store","priceRials":1000,"discountRials":400,"finalPriceRials":600,"discountRatio":40,"stock":2,"facts":{"observedAt":"2026-11-16T10:00:00Z","benefit":{"kind":"standard_discount","identity":"ordinary","applicable":true,"terms":null}}}`, i, i, i)
		if source == "okala" {
			if _, err := db.Exec(`INSERT INTO scan_live_offers VALUES(?,?,?,?,?)`, id, fmt.Sprintf("1:%d", i), offer, i, 1); err != nil {
				t.Fatal(err)
			}
		} else {
			if _, err := db.Exec(`INSERT INTO scan_campaign_contributions VALUES(?,'feed',?,'accepted',?)`, id, fmt.Sprintf("1:%d", i), `{"Offer":`+offer+`}`); err != nil {
				t.Fatal(err)
			}
		}
	}
	path := "/api/scans/" + id + "/preview"
	for _, check := range []struct {
		cookie *http.Cookie
		code   int
	}{{owner, 200}, {other, 404}, {nil, 401}} {
		r := analyticsTestRequest(handler, "GET", path, "", check.cookie)
		if r.Code != check.code {
			t.Fatalf("tenant boundary: got %d want %d: %s", r.Code, check.code, r.Body.String())
		}
	}
	first := analyticsTestRequest(handler, "GET", path, "", owner)
	var page struct {
		Data struct {
			Total    int               `json:"totalCount"`
			Items    []json.RawMessage `json:"items"`
			Next     *string           `json:"nextCursor"`
			Coverage string            `json:"coverageSummary"`
			Baseline struct {
				ID *string `json:"scanId"`
			} `json:"baseline"`
		} `json:"data"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Data.Total != 61 || len(page.Data.Items) != 50 || page.Data.Next == nil || page.Data.Coverage != "in_progress" || page.Data.Baseline.ID != nil {
		t.Fatalf("invalid live page %s", first.Body.String())
	}
	second := analyticsTestRequest(handler, "GET", path+"?cursor="+*page.Data.Next, "", owner)
	if err := json.Unmarshal(second.Body.Bytes(), &page); err != nil || len(page.Data.Items) != 11 {
		t.Fatalf("pagination: %s %v", second.Body.String(), err)
	}
	if source != "okala" {
		if _, err := db.Exec(`INSERT INTO scan_campaign_contributions VALUES(?,'conflicting-feed','1:1','quarantined',NULL)`, id); err != nil {
			t.Fatal(err)
		}
		filtered := analyticsTestRequest(handler, "GET", path, "", owner)
		if err := json.Unmarshal(filtered.Body.Bytes(), &page); err != nil || page.Data.Total != 60 {
			t.Fatalf("quarantined offer remained live: %s %v", filtered.Body.String(), err)
		}
	}
	if r := analyticsTestRequest(handler, "GET", "/api/scans/"+id+"/products?page=1", "", owner); r.Code != 409 {
		t.Fatal("live results became published history", r.Code)
	}
	if r := analyticsTestRequest(handler, "GET", path+"?minDiscount=0", "", owner); r.Code != 400 {
		t.Fatal("minimum bypass", r.Code)
	}
	if _, err := db.Exec(`UPDATE scans SET status='cancelled' WHERE id=?`, id); err != nil {
		t.Fatal(err)
	}
	if r := analyticsTestRequest(handler, "GET", path, "", owner); r.Code != 200 {
		t.Fatal("cancelled scan lost partial offers", r.Code)
	}
	metadata := analyticsTestRequest(handler, "GET", "/api/scans/"+id, "", owner)
	var cancelled struct {
		Data scans.Record `json:"data"`
	}
	if err := json.Unmarshal(metadata.Body.Bytes(), &cancelled); err != nil || cancelled.Data.DealCount < 1 {
		t.Fatalf("cancelled partial count lost: %s %v", metadata.Body.String(), err)
	}
	var product struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(page.Data.Items[0], &product); err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		cookie *http.Cookie
		code   int
	}{{owner, 200}, {other, 404}, {nil, 401}} {
		r := analyticsTestRequest(handler, "GET", "/api/scans/"+id+"/products/"+url.PathEscape(product.Key)+"/offers?preview=1", "", check.cookie)
		if r.Code != check.code {
			t.Fatalf("partial store offers: %d want %d: %s", r.Code, check.code, r.Body.String())
		}
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM scan_live_offers WHERE scan_id=?`, id).Scan(&count); err != nil || (source == "okala" && count != 61) {
		t.Fatal("cancelled preview not retained", count, err)
	}
	for _, remaining := range []int{1, 0} {
		for _, table := range []string{"scan_live_offers", "scan_campaign_contributions"} {
			if _, err := db.Exec(`DELETE FROM `+table+` WHERE scan_id=? AND (?=0 OR deal_key!='1:2')`, id, remaining); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := db.Exec(`UPDATE scans SET status='cancelled' WHERE id=?`, id); err != nil {
			t.Fatal(err)
		}
		if err := queue.MaintainRetention(t.Context(), time.Now()); err != nil {
			t.Fatal(err)
		}
		r := analyticsTestRequest(handler, "GET", path, "", owner)
		if err := json.Unmarshal(r.Body.Bytes(), &page); err != nil || page.Data.Total != remaining {
			t.Fatalf("cancelled count %d: %s %v", remaining, r.Body.String(), err)
		}
		metadata := analyticsTestRequest(handler, "GET", "/api/scans/"+id, "", owner)
		if err := json.Unmarshal(metadata.Body.Bytes(), &cancelled); err != nil || cancelled.Data.DealCount != remaining {
			t.Fatalf("cancelled metadata %d: %s %v", remaining, metadata.Body.String(), err)
		}
	}

}
