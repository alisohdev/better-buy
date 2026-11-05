package wishlist

import (
	"net/url"
	"strings"
	"testing"
)

func TestFeaturedMatchRanksDiscountPriceAndKeys(t *testing.T) {
	matches := []Match{
		{ProductKey: "legacy", DiscountPercent: 99},
		{ProductKey: "b", VendorID: "b", VendorTitle: "Store B", DiscountPercent: 60, Price: 100},
		{ProductKey: "a", VendorID: "b", VendorTitle: "Store B", DiscountPercent: 60, Price: 100},
		{ProductKey: "a", VendorID: "a", VendorTitle: "Store A", DiscountPercent: 60, Price: 100},
		{ProductKey: "cheap", VendorID: "a", VendorTitle: "Store A", DiscountPercent: 50, Price: 1},
	}
	got, ok := featuredMatch(matches)
	if !ok || got.ProductKey != "a" || got.VendorID != "a" {
		t.Fatalf("unexpected selection: %+v, %v", got, ok)
	}
	if _, ok := featuredMatch(matches[:1]); ok {
		t.Fatal("legacy match unexpectedly had a product destination")
	}
}

func TestProductPushContainsSelectedStoreAndEscapedProductLink(t *testing.T) {
	match := Match{Title: "پنیر", Source: "snappmarket", ProductKey: "پنیر & ۱", VendorID: "1", VendorTitle: "دریانی", DiscountPercent: 50}
	body := productPushBody(match, 2)
	for _, part := range []string{"پنیر", "50", "اسنپ‌مارکت", "دریانی", "2 پیشنهاد دیگر"} {
		if !strings.Contains(body, part) {
			t.Fatalf("body %q missing %q", body, part)
		}
	}
	u, err := url.Parse(productDetailURL("scan", match.ProductKey))
	if err != nil {
		t.Fatal(err)
	}
	if u.Path != "/" || u.Query().Get("page") != "product" || u.Query().Get("scan") != "scan" || u.Query().Get("product") != match.ProductKey {
		t.Fatalf("bad link: %s", u)
	}
}
