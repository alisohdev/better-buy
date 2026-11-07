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
	for _, provider := range []string{"snappmarket", "okala", "unknown"} {
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
