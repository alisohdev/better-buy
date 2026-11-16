package productlinks

import (
	"fmt"
	"net/url"
	"strconv"
)

// Okala's public offer route binds the offer to the store: /store/{store}/offer/{product}.
func resolveOkala(id Identity, canonicalURL string) *Destination {
	if !positiveDecimal(id.VendorID) || !positiveDecimal(id.ProductVariationID) {
		return nil
	}
	path := fmt.Sprintf("/store/%s/offer/%s", id.VendorID, id.ProductVariationID)
	destination := "https://www.okala.com" + path
	if canonicalURL != "" {
		parsed, err := url.Parse(canonicalURL)
		if err != nil || parsed.Path != path {
			return nil
		}
		destination = canonicalURL
	}
	return &Destination{URL: destination, ProductVariationID: id.ProductVariationID, VendorID: id.VendorID}
}

func positiveDecimal(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	return err == nil && parsed > 0
}
