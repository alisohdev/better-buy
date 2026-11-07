// Package productlinks resolves only evidence-backed provider destinations.
package productlinks

import (
	"net/url"
	"strings"
)

type Identity struct {
	ProductVariationID string
	VendorID           string
	VendorCode         *string
}
type Destination struct {
	URL                string `json:"url"`
	ProductVariationID string `json:"productVariationId"`
	VendorID           string `json:"vendorId"`
}

// SafeHTTPS checks transport and host safety, not product/store route semantics.
// Queries remain closed until their public context semantics are verified.
func SafeHTTPS(provider, raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || strings.ContainsAny(raw, "\\\r\n\t") {
		return false
	}
	host := strings.ToLower(u.Host)
	allowed := false
	switch provider {
	case "snappmarket":
		allowed = host == "snapp.market" || host == "www.snapp.market"
	case "okala":
		allowed = host == "okala.com" || host == "www.okala.com"
	}
	return allowed && u.Path != "" && u.Path != "/" && !strings.Contains(u.EscapedPath(), "%")
}

func Resolve(provider string, id Identity, canonicalURL string) *Destination {
	if id.ProductVariationID == "" || id.VendorID == "" {
		return nil
	}
	if canonicalURL != "" && !SafeHTTPS(provider, canonicalURL) {
		return nil
	}
	switch provider {
	case "snappmarket":
		return resolveSnappMarket(id, canonicalURL)
	case "okala":
		return resolveOkala(id, canonicalURL)
	default:
		return nil
	}
}
