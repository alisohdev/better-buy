package wishlist

import (
	"fmt"
	"net/url"
)

func productDetailURL(scanID, productKey string) string {
	return "/?page=product&scan=" + url.QueryEscape(scanID) + "&product=" + url.QueryEscape(productKey)
}

func productPushBody(match Match, additional int) string {
	source := match.Source
	switch source {
	case "snappmarket":
		source = "اسنپ‌مارکت"
	case "okala":
		source = "اکالا"
	case "digikalajet":
		source = "دیجی‌کالا جت"
	}
	text := fmt.Sprintf("%s با %g درصد تخفیف در %s، فروشگاه %s", match.Title, match.DiscountPercent, source, match.VendorTitle)
	if additional > 0 {
		text += fmt.Sprintf(" · %d پیشنهاد دیگر", additional)
	}
	return text
}

// featuredMatch chooses a deterministic highest-discount offer from a scan.
// Older notification records lack a product key and cannot link to a product.
func featuredMatch(matches []Match) (Match, bool) {
	var best Match
	found := false
	for _, match := range matches {
		if match.ProductKey == "" || match.VendorID == "" || match.VendorTitle == "" {
			continue
		}
		if !found || match.DiscountPercent > best.DiscountPercent ||
			(match.DiscountPercent == best.DiscountPercent && (match.Price < best.Price ||
				(match.Price == best.Price && (match.ProductKey < best.ProductKey ||
					(match.ProductKey == best.ProductKey && match.VendorID < best.VendorID))))) {
			best, found = match, true
		}
	}
	return best, found
}
