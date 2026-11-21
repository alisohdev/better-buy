package products

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

type productFilters struct {
	Minimum    int
	Maximum    int
	Stores     []string
	Categories []string
}

func parseProductFilters(query url.Values) (productFilters, error) {
	minimum, err := minimumDiscount(query)
	if err != nil {
		return productFilters{}, err
	}
	filters := productFilters{Minimum: minimum}
	if query.Has("maxDiscount") {
		maximum, err := strconv.Atoi(query.Get("maxDiscount"))
		if err != nil || maximum < minimum || maximum > 100 {
			return productFilters{}, &scans.Error{Code: "INVALID_INPUT", Message: "Maximum discount must be between the minimum discount and 100 percent.", Status: 400}
		}
		filters.Maximum = maximum
	}
	for name, target := range map[string]*[]string{"store": &filters.Stores, "category": &filters.Categories} {
		for _, value := range query[name] {
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			*target = append(*target, value)
		}
		slices.Sort(*target)
		*target = slices.Compact(*target)
	}
	return filters, nil
}

func (f productFilters) signature() string {
	if f.Maximum == 0 && len(f.Stores) == 0 && len(f.Categories) == 0 {
		return ""
	}
	digest := sha256.Sum256([]byte(mustJSON(f)))
	return hex.EncodeToString(digest[:])
}

func (f productFilters) matches(row DealRecord) bool {
	return row.DiscountRatio >= float64(f.Minimum) &&
		(f.Maximum == 0 || row.DiscountRatio <= float64(f.Maximum)) &&
		(len(f.Stores) == 0 || slices.Contains(f.Stores, strings.TrimSpace(row.VendorTitle))) &&
		(len(f.Categories) == 0 || slices.Contains(f.Categories, strings.TrimSpace(stringValue(row.CategoryTitle))))
}

type productFacets struct {
	Stores     []string `json:"stores"`
	Categories []string `json:"categories"`
}

func scanProductFacets(deals []DealRecord) productFacets {
	stores := map[string]struct{}{}
	categories := map[string]struct{}{}
	for _, row := range deals {
		if row.DiscountRatio < discounts.Minimum || !validPrice(row) ||
			(row.State != "no_longer_present" && row.Availability != "available" && row.Stock <= 0) {
			continue
		}
		if store := strings.TrimSpace(row.VendorTitle); store != "" {
			stores[store] = struct{}{}
		}
		if category := strings.TrimSpace(stringValue(row.CategoryTitle)); category != "" {
			categories[category] = struct{}{}
		}
	}
	return productFacets{Stores: sortedKeys(stores), Categories: sortedKeys(categories)}
}
