package products

import (
	"encoding/json"
	"testing"
)

func TestLegacyDestinationCompatibility(t *testing.T) {
	var deal DealRecord
	if err := json.Unmarshal([]byte(`{"productVariationId":"123","vendorId":"10","stock":1}`), &deal); err != nil {
		t.Fatal(err)
	}
	if deal.ProductDestination != nil {
		t.Fatal("legacy deal acquired a destination")
	}
	for _, value := range []any{deal, VendorOffer{ProductVariationID: "123", VendorID: "10"}} {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["productDestination"]) != "null" {
			t.Fatalf("destination must be explicit null: %s", raw)
		}
	}
}
