package carts

import "testing"

func TestRecommendationPreservesOriginalPriceForQuantity(t *testing.T) {
	result := recommendOffers([]offerLine{{Line: Line{Key: "tea", Quantity: 3}, Offers: []Offer{{VendorID: "shop", PriceRials: 80, OriginalPriceRials: 100, Stock: 5}}}}, true)
	if len(result.Stores) != 1 || len(result.Stores[0].Items) != 1 {
		t.Fatal(result)
	}
	item := result.Stores[0].Items[0]
	if item.OriginalPriceRials != 100 || item.PriceRials != 80 || item.LineTotalRials != 240 || result.TotalRials != 240 {
		t.Fatalf("incorrect price breakdown: %+v", item)
	}
}
