package productlinks

import "testing"

func TestSafeHTTPS(t *testing.T) {
	for _, provider := range []string{"snappmarket", "okala"} {
		host := "snapp.market"
		if provider == "okala" {
			host = "www.okala.com"
		}
		if !SafeHTTPS(provider, "https://"+host+"/candidate") {
			t.Fatal("allowlisted HTTPS rejected")
		}
		for _, raw := range []string{
			"https://" + host, "https://" + host + "/", "http://" + host + "/candidate",
			"https://" + host + ".evil.test/product", "https://evil.test/product",
			"https://token@" + host + "/product", "https://" + host + ":8443/product",
			"https://" + host + "/product?guest_token=secret", "https://" + host + "/product#token",
			"https://" + host + "/%2fproduct", "javascript:alert(1)", "//" + host + "/product",
			"https://apigateway.okala.com/api/product", "https://svc.snapp.market/product",
			"https://" + host + "/product\\evil", "https://" + host + "/product\n",
		} {
			if SafeHTTPS(provider, raw) {
				t.Errorf("accepted unsafe URL %q", raw)
			}
		}
	}
}

func TestUnverifiedRoutesRemainNull(t *testing.T) {
	for _, provider := range []string{"snappmarket", "unknown"} {
		for _, product := range []string{"123", "456", "789"} {
			for _, store := range []string{"10", "20"} {
				for _, raw := range []string{"", "https://snapp.market/product/123", "https://www.okala.com/product/123"} {
					if got := Resolve(provider, Identity{ProductVariationID: product, VendorID: store}, raw); got != nil {
						t.Fatalf("unverified destination returned: %+v", got)
					}
				}
			}
		}
	}
	if Resolve("okala", Identity{}, "") != nil {
		t.Fatal("missing identity resolved")
	}
}

func TestOkalaOfferDestinationBindsStoreAndProduct(t *testing.T) {
	want := &Destination{
		URL:                "https://www.okala.com/store/2223/offer/87001",
		ProductVariationID: "87001",
		VendorID:           "2223",
	}
	if got := Resolve("okala", Identity{ProductVariationID: "87001", VendorID: "2223"}, ""); got == nil || *got != *want {
		t.Fatalf("destination = %+v, want %+v", got, want)
	}
	if got := Resolve("okala", Identity{ProductVariationID: "87001", VendorID: "2223"}, "https://okala.com/store/2223/offer/87001"); got == nil || got.URL != "https://okala.com/store/2223/offer/87001" {
		t.Fatalf("canonical route = %+v", got)
	}
	for _, identity := range []Identity{
		{ProductVariationID: "0", VendorID: "2223"},
		{ProductVariationID: "87001", VendorID: "0"},
		{ProductVariationID: "87001/other", VendorID: "2223"},
		{ProductVariationID: "87001", VendorID: "2223/other"},
	} {
		if got := Resolve("okala", identity, ""); got != nil {
			t.Errorf("unsafe identity resolved: %+v", got)
		}
	}
	if got := Resolve("okala", Identity{ProductVariationID: "87001", VendorID: "2223"}, "https://www.okala.com/store/111/offer/87001"); got != nil {
		t.Errorf("mismatched store route resolved: %+v", got)
	}
}
