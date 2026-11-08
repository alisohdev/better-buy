package providers

import (
	"encoding/json"
	"testing"
	"time"
)

func TestNormalizeDigikalaFreshUsesRialsAndBooleanAvailability(t *testing.T) {
	raw := json.RawMessage(`{"id":64083928,"title":"beans","media":"https://img.example/item.jpg","shop":{"id":"shop-opaque","title":"Fresh shop","activity_type":"all_mart","status":"active","is_in_range":true,"working_status":{"is_open":true}},"category":{"id":86,"title":"beans"},"price":{"price":350000,"discount":87500,"discount_percentage":25,"aggregated_price":500000},"stock":{"has_stock":true,"is_running_low":false},"badges":{"is_bundled":false,"is_kalabarg":false,"is_yasna":false}}`)
	deal, eligible, err := normalizeDigikalaOffer(raw, "summer_hero_v2", "product_custom_listing", time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC), true)
	if err != nil || !eligible {
		t.Fatalf("normalization failed: eligible=%v err=%v", eligible, err)
	}
	if deal.PriceRials != 350000 || deal.DiscountRials != 87500 || deal.FinalPriceRials != 262500 {
		t.Fatalf("unexpected rial arithmetic: %+v", deal)
	}
	if deal.Availability != "available" || deal.StockQuantity != nil || deal.Stock != 0 {
		t.Fatalf("boolean stock was represented as a quantity: %+v", deal)
	}
	if deal.ProductVariationID != "64083928" || deal.VendorID != "shop-opaque" || deal.Key != "digikalajet:fresh:shop-opaque:64083928:summer_hero_v2" {
		t.Fatalf("identity lost opaque campaign or shop context: %+v", deal)
	}
}

func TestNormalizeDigikalaFreshExcludesUnknownCategoryAndBenefits(t *testing.T) {
	raw := json.RawMessage(`{"id":"product-x","title":"toy","shop":{"id":"shop-x","title":"shop","activity_type":"supermarket","status":"active","is_in_range":true,"working_status":{"is_open":true}},"category":{"id":3138,"title":"toy"},"price":{"price":1000,"discount":500},"stock":{"has_stock":true},"badges":{"is_bundled":false}}`)
	deal, eligible, err := normalizeDigikalaOffer(raw, "x", "source", time.Now(), false)
	if err != nil || eligible || deal.Key == "" {
		t.Fatalf("category exclusion should retain identity but exclude the offer: deal=%+v eligible=%v err=%v", deal, eligible, err)
	}
	var facts map[string]any
	if err := json.Unmarshal(deal.Facts, &facts); err != nil {
		t.Fatal(err)
	}
	if facts["availability"] != "available" {
		t.Fatalf("expected availability evidence in facts, got %v", facts)
	}
	raw = json.RawMessage(`{"id":2,"title":"bundle","shop":{"id":"shop-x","title":"shop","activity_type":"supermarket","status":"active","is_in_range":true,"working_status":{"is_open":true}},"category":{"id":12,"title":"food"},"price":{"price":1000,"discount":500},"stock":{"has_stock":true},"badges":{"is_bundled":true}}`)
	_, eligible, err = normalizeDigikalaOffer(raw, "x", "source", time.Now(), true)
	if err != nil || eligible {
		t.Fatalf("conditional bundle must not be published as an ordinary price: eligible=%v err=%v", eligible, err)
	}
}

func TestValidateDigikalaPaginationAndPageIdentity(t *testing.T) {
	if err := validateDigikalaPage(5, digikalaPager{CurrentPage: 5, TotalPages: 5, TotalItems: 93, RowsOnPage: 20}, 13); err != nil {
		t.Fatalf("valid short terminal page rejected: %v", err)
	}
	for _, test := range []struct {
		name  string
		page  int
		pager digikalaPager
		rows  int
	}{
		{"wrong page", 2, digikalaPager{CurrentPage: 1, TotalPages: 2, TotalItems: 20, RowsOnPage: 20}, 20},
		{"zero pages", 1, digikalaPager{CurrentPage: 1, TotalPages: 0, RowsOnPage: 20}, 20},
		{"too many rows", 1, digikalaPager{CurrentPage: 1, TotalPages: 1, RowsOnPage: 5}, 6},
		{"page beyond end", 3, digikalaPager{CurrentPage: 3, TotalPages: 2, RowsOnPage: 20}, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			if validateDigikalaPage(test.page, test.pager, test.rows) == nil {
				t.Fatal("invalid page metadata accepted")
			}
		})
	}
	rows := []json.RawMessage{json.RawMessage(`{"id":1}`)}
	if pageFingerprint(rows) != pageFingerprint(rows) {
		t.Fatal("page fingerprint is not stable")
	}
	if first, _ := digikalaOfferIdentity(json.RawMessage(`{"id":"product-x","shop":{"id":"store-y"}}`)); first != "store-y:product-x" {
		t.Fatalf("opaque identity not preserved: %s", first)
	}
}

func TestDiscoverDigikalaFreshOpaqueCampaignLinks(t *testing.T) {
	home := []byte(`{"status":200,"data":{"components":[{"component_type":"fresh-static-amazing-carousel","data":{}},{"component_type":"fresh-dynamic-carousel","process_mode":"deferred","data":{"carousel_id":"flash_2026_v3"}},{"component_type":"marketing-banner","data":{"link":{"url":"/fresh/dynamic-carousel/seasonal_hero/"}}}]}}`)
	feeds, err := discoverDigikalaFeeds(home)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, feed := range feeds {
		got[feed.ID] = true
	}
	for _, id := range []string{"static_amazing", "flash_2026_v3", "seasonal_hero"} {
		if !got[id] {
			t.Errorf("discovered feed set missing %q: %#v", id, feeds)
		}
	}
}

func TestDigikalaCategoryAncestryPolicy(t *testing.T) {
	for _, test := range []struct {
		root, leaf string
		want       bool
	}{
		{"12", "86", true}, {"144", "146", true}, {"144", "27", false},
		{"3126", "3128", true}, {"3126", "3131", false}, {"3131", "3131", false},
		{"99", "3106", true}, {"99", "3132", false},
	} {
		if got := digikalaCategoryPolicy(test.root, test.leaf); got != test.want {
			t.Errorf("policy(%q,%q)=%v want %v", test.root, test.leaf, got, test.want)
		}
	}
}

func TestDigikalaRedirectAllowlist(t *testing.T) {
	path, query, ok := validatedDigikalaRedirect("https://api.digikalajet.ir/fresh/dynamic-carousel/amazing/?sort=20&page=2")
	if !ok || path != "/fresh/dynamic-carousel/amazing/" || query.Get("sort") != "20" || query.Get("page") != "2" {
		t.Fatalf("valid campaign redirect rejected or lost context: %q %v %v", path, query, ok)
	}
	for _, raw := range []string{"https://evil.example/fresh/dynamic-carousel/amazing/", "http://api.digikalajet.ir/fresh/dynamic-carousel/amazing/", "https://api.digikalajet.ir/fresh/dynamic-carousel/amazing/?token=x", "https://api.digikalajet.ir/shop/1/product/2/"} {
		if _, _, ok := validatedDigikalaRedirect(raw); ok {
			t.Errorf("unsupported redirect accepted: %s", raw)
		}
	}
}
