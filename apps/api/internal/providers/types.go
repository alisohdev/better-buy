package providers

import "encoding/json"

type Deal struct {
	Key                string          `json:"key"`
	ProductVariationID string          `json:"productVariationId"`
	VendorID           string          `json:"vendorId"`
	Title              string          `json:"title"`
	Image              *string         `json:"image"`
	VendorTitle        string          `json:"vendorTitle"`
	VendorCode         *string         `json:"vendorCode"`
	CategoryTitle      *string         `json:"categoryTitle"`
	PriceRials         int64           `json:"priceRials"`
	DiscountRials      int64           `json:"discountRials"`
	FinalPriceRials    int64           `json:"finalPriceRials"`
	DiscountRatio      float64         `json:"discountRatio"`
	Stock              int             `json:"stock"`
	Facts              json.RawMessage `json:"facts"`
}

type CampaignScope struct {
	VendorID         int64  `json:"vendorId"`
	VendorCode       string `json:"vendorCode"`
	VendorTitle      string `json:"-"`
	CollectionID     int64  `json:"collectionId"`
	Source           string `json:"source,omitempty"`
	ExpectedPageSize *int   `json:"expectedPageSize,omitempty"`
	MaxPages         *int   `json:"maxPages,omitempty"`
	Bounded          *bool  `json:"bounded,omitempty"`
}

type Manifest struct {
	Adapter         string          `json:"adapter"`
	ContractVersion int             `json:"contractVersion"`
	FeedKinds       []string        `json:"feedKinds"`
	CollectionIDs   []int64         `json:"collectionIds,omitempty"`
	StoreIDs        []int64         `json:"storeIds,omitempty"`
	StoreCampaigns  []CampaignScope `json:"storeCampaigns,omitempty"`
}

type Context struct {
	Location struct {
		Name      string  `json:"name"`
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
		Revision  int     `json:"revision"`
	} `json:"location"`
	RequestedThreshold int      `json:"requestedThreshold"`
	EffectiveThreshold int      `json:"effectiveThreshold"`
	PolicyVersion      string   `json:"policyVersion"`
	Manifest           Manifest `json:"manifest"`
	ScopeHash          string   `json:"scopeHash"`
	EligibilityVersion int      `json:"eligibilityVersion"`
	OfferKeyVersion    int      `json:"offerKeyVersion"`
	Coverage           string   `json:"coverage"`
}

type Claim struct {
	ScanID      string
	UserID      string
	InstanceID  string
	OwnerBootID string
}

type Summary struct {
	ScanID       string
	ScopeHash    string
	VendorCount  int
	ProductCount int
	Coverage     string
}

type Completed struct {
	summary Summary
	offers  []Deal
}

func newCompleted(summary Summary, offers []Deal) Completed {
	return Completed{summary: summary, offers: cloneDeals(offers)}
}

func (c Completed) Summary() Summary {
	return c.summary
}

func (c Completed) Offers() []Deal {
	return cloneDeals(c.offers)
}

func cloneDeals(values []Deal) []Deal {
	cloned := make([]Deal, len(values))
	copy(cloned, values)
	for i := range cloned {
		cloned[i].Facts = append(json.RawMessage(nil), values[i].Facts...)
		if values[i].Image != nil {
			image := *values[i].Image
			cloned[i].Image = &image
		}
		if values[i].VendorCode != nil {
			code := *values[i].VendorCode
			cloned[i].VendorCode = &code
		}
		if values[i].CategoryTitle != nil {
			title := *values[i].CategoryTitle
			cloned[i].CategoryTitle = &title
		}
	}
	return cloned
}

type Failure struct {
	Code      string
	Message   string
	Status    int
	Retryable bool
}

func (f *Failure) Error() string {
	return f.Message
}
