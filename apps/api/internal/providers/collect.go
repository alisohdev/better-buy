package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Collector struct {
	client *http.Client
	db     *sql.DB
}

type apiFailure struct {
	Code      string
	Retryable bool
	Status    int
}

func (e *apiFailure) Error() string { return e.Code }

const maxRequestAttempts = 3

func New(db *sql.DB) *Collector {
	return &Collector{client: &http.Client{Timeout: 8 * time.Second}, db: db}
}

func (c *Collector) Collect(ctx context.Context, claim Claim) (Completed, error) {
	job, err := c.loadScanJob(ctx, claim)
	if err != nil {
		return Completed{}, err
	}
	var result scanResult
	var collectErr error
	switch job.Input.Source {
	case "snappmarket":
		result, collectErr = c.collectSnapp(ctx, &job)
	case "okala":
		result, collectErr = c.collectOkala(ctx, &job)
	default:
		return Completed{}, &Failure{Code: "PROVIDER_UNAVAILABLE", Message: "This retailer is not available for new scans.", Status: 409}
	}
	if collectErr != nil {
		return Completed{}, collectErr
	}
	return newCompleted(Summary{ScanID: job.ID, ScopeHash: job.Context.ScopeHash, VendorCount: result.VendorCount, ProductCount: result.ProductCount, Coverage: result.Coverage}, result.Deals), nil
}

type response struct {
	status     int
	body       []byte
	observedAt string
}

func (c *Collector) request(ctx context.Context, method, rawURL string, headers http.Header, payload []byte, provider string, attempts int, allow401 bool, reserve func(context.Context, string) error) (response, error) {
	if attempts < 1 {
		attempts = 1
	} else if attempts > maxRequestAttempts {
		attempts = maxRequestAttempts
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return response{}, err
		}
		if reserve != nil {
			parsed, err := url.Parse(rawURL)
			if err != nil {
				return response{}, err
			}
			operation := provider + ":" + method + ":" + parsed.EscapedPath()
			if parsed.RawQuery != "" {
				operation += "?" + parsed.RawQuery
			}
			if err := reserve(ctx, operation); err != nil {
				if ctxErr := ctx.Err(); ctxErr != nil {
					return response{}, ctxErr
				}
				return response{}, err
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, rawURL, bytes.NewReader(payload))
		if err != nil {
			return response{}, err
		}
		for key, values := range headers {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		resp, err := c.client.Do(req)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return response{}, ctxErr
			}
			lastErr = &Failure{Code: "NETWORK_ERROR", Message: provider + " could not be reached.", Status: 502, Retryable: true}
		} else {
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
			_ = resp.Body.Close()
			if ctxErr := ctx.Err(); ctxErr != nil {
				return response{}, ctxErr
			}
			if readErr != nil {
				lastErr = &Failure{Code: "UPSTREAM_ERROR", Message: provider + " response could not be read.", Status: 502, Retryable: true}
			} else if resp.StatusCode == http.StatusUnauthorized && allow401 {
				return response{status: resp.StatusCode, body: body}, nil
			} else if resp.StatusCode == http.StatusTooManyRequests {
				delay := retryAfter(resp.Header.Get("Retry-After"))
				lastErr = &Failure{Code: "RATE_LIMITED", Message: provider + " is temporarily limiting requests.", Status: 502, Retryable: true}
				if attempt+1 < attempts && delay <= 5*time.Second {
					if !sleep(ctx, max(delay, time.Duration(attempt+1)*time.Second)) {
						return response{}, ctx.Err()
					}
					continue
				}
				return response{}, lastErr
			} else if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
				return response{}, &Failure{Code: "UPSTREAM_FORBIDDEN", Message: "Access to " + provider + " was rejected.", Status: 502}
			} else if resp.StatusCode == http.StatusRequestTimeout || resp.StatusCode >= 500 {
				lastErr = &Failure{Code: "UPSTREAM_ERROR", Message: provider + " returned an unsuccessful response.", Status: 502, Retryable: true}
			} else if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				return response{}, &Failure{Code: "UPSTREAM_ERROR", Message: provider + " returned an unsuccessful response.", Status: 502}
			} else {
				return response{status: resp.StatusCode, body: body}, nil
			}
		}
		if attempt+1 < attempts {
			if !sleep(ctx, time.Duration(1<<attempt)*time.Second) {
				return response{}, ctx.Err()
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return response{}, err
	}
	if lastErr == nil {
		lastErr = errors.New("upstream request failed")
	} else {
		var providerErr *Failure
		if errors.As(lastErr, &providerErr) && providerErr.Retryable {
			terminal := *providerErr
			terminal.Retryable = false
			lastErr = &terminal
		}
	}
	return response{}, lastErr
}

func (c *Collector) collectSnapp(ctx context.Context, job *scanJob) (scanResult, error) {
	deviceID := job.DeviceID
	if deviceID == "" {
		return scanResult{}, errors.New("scan execution has no provider device id")
	}
	var guest snappGuest
	renewed := false
	var scopes []CampaignScope
	if job.EnrichmentEnabled {
		if job.ManifestFrozen {
			scopes = append(scopes, job.Context.Manifest.StoreCampaigns...)
		} else {
			var err error
			scopes, err = c.planSnappCampaigns(ctx, job, &guest, &renewed)
			if err != nil {
				return scanResult{}, err
			}
			if err := job.FreezeSnappManifest(ctx, scopes); err != nil {
				return scanResult{}, err
			}
		}
	}
	vendors := make(map[string]snappVendor)
	observedAt := make(map[string]string)
	fingerprints := make(map[string]struct{})
	totalCount := math.MaxInt
	for page := 0; len(vendors) < totalCount; page++ {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		values := url.Values{
			"deal_type": {"supermarket"}, "user_id": {"0"}, "isPro": {"false"},
			"page": {strconv.Itoa(page)}, "page_size": {"100"},
			"client": {"PWA"}, "deviceType": {"PWA"}, "appVersion": {"1.403.1"}, "UDID": {deviceID},
		}
		target := fmt.Sprintf("https://svc.snapp.market/market-party/%s/%s?%s", strconv.FormatFloat(job.Location.Latitude, 'f', -1, 64), strconv.FormatFloat(job.Location.Longitude, 'f', -1, 64), values.Encode())
		response, err := c.snappRead(ctx, target, job, &guest, &renewed)
		if err != nil {
			return scanResult{}, err
		}
		var body struct {
			Status bool `json:"status"`
			Data   struct {
				TotalCount int           `json:"total_count"`
				Vendors    []snappVendor `json:"vendors"`
			} `json:"data"`
		}
		if response.status == http.StatusNoContent || json.Unmarshal(response.body, &body) != nil || !body.Status || body.Data.TotalCount < 0 {
			return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market response format changed.", Status: 502}
		}
		totalCount = body.Data.TotalCount
		if len(body.Data.Vendors) == 0 {
			if len(vendors) < totalCount {
				return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market returned an incomplete vendor list.", Status: 502}
			}
			metadata, err := json.Marshal(map[string]any{"contractVersion": 1, "vendorCount": len(vendors), "terminal": true})
			if err != nil {
				return scanResult{}, err
			}
			if err := job.RecordPage(ctx, pageCheckpoint{UnitID: "market_party", Descriptor: `{"kind":"market_party","contractVersion":1}`, Page: page, ResponseBody: response.body, Metadata: string(metadata), Terminal: true, TerminalNote: "provider_total_reached"}); err != nil {
				return scanResult{}, err
			}
			break
		}
		ids := make([]string, 0, len(body.Data.Vendors))
		for _, vendor := range body.Data.Vendors {
			if err := ctx.Err(); err != nil {
				return scanResult{}, err
			}
			id, ok := scalarString(vendor.ID)
			if !ok || id == "" {
				return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market returned an invalid vendor identity.", Status: 502}
			}
			ids = append(ids, id)
			vendors[id] = vendor
			observedAt[id], err = stableObservedAt(response.observedAt, job.StartedAt())
			if err != nil {
				return scanResult{}, err
			}
		}
		fingerprint := strings.Join(ids, ",")
		if _, exists := fingerprints[fingerprint]; exists {
			return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market returned a repeated vendor page.", Status: 502}
		}
		fingerprints[fingerprint] = struct{}{}
		products := make(map[string]struct{})
		for vendorID, vendor := range vendors {
			if err := ctx.Err(); err != nil {
				return scanResult{}, err
			}
			for _, product := range vendor.Products {
				if err := ctx.Err(); err != nil {
					return scanResult{}, err
				}
				productID, productOK := scalarString(product.ProductVariationID)
				ownerID, ownerOK := scalarString(product.VendorID)
				if !productOK || !ownerOK || ownerID != vendorID || productID == "" {
					return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market returned an invalid product identity.", Status: 502}
				}
				products[vendorID+":"+productID] = struct{}{}
			}
		}
		if err := job.Progress(ctx, len(vendors), len(products)); err != nil {
			return scanResult{}, err
		}
		terminal := len(vendors) >= totalCount
		metadata, err := json.Marshal(map[string]any{"contractVersion": 1, "vendorCount": len(vendors), "productCount": len(products), "terminal": terminal})
		if err != nil {
			return scanResult{}, err
		}
		note := "page_collected"
		if terminal {
			note = "provider_total_reached"
		}
		observations := make([]scanObservation, 0)
		for _, vendor := range body.Data.Vendors {
			if err := ctx.Err(); err != nil {
				return scanResult{}, err
			}
			vendorID, _ := scalarString(vendor.ID)
			observations = append(observations, scanObservation{Kind: "vendor", Identity: vendorID})
			for _, product := range vendor.Products {
				if err := ctx.Err(); err != nil {
					return scanResult{}, err
				}
				productID, productOK := scalarString(product.ProductVariationID)
				ownerID, ownerOK := scalarString(product.VendorID)
				if productOK && ownerOK && productID != "" && ownerID == vendorID {
					observations = append(observations, scanObservation{Kind: "product", Identity: ownerID + ":" + productID})
				}
			}
		}
		if err := job.RecordPage(ctx, pageCheckpoint{UnitID: "market_party", Descriptor: `{"kind":"market_party","contractVersion":1}`, Page: page, ResponseBody: response.body, Metadata: string(metadata), Terminal: terminal, TerminalNote: note, Observations: observations}); err != nil {
			return scanResult{}, err
		}
	}
	if len(vendors) < totalCount {
		return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market returned an incomplete vendor list.", Status: 502}
	}
	if err := ctx.Err(); err != nil {
		return scanResult{}, err
	}
	result := normalizeSnapp(vendors, observedAt, job.Threshold)
	if err := ctx.Err(); err != nil {
		return scanResult{}, err
	}
	if len(scopes) == 0 {
		return result, nil
	}
	return c.enrichSnappCampaigns(ctx, job, scopes, vendors, result, &guest, &renewed)
}

func (c *Collector) acquireSnappGuest(ctx context.Context, deviceID string, reserve func(context.Context, string) error) (snappGuest, error) {
	query := url.Values{"client": {"PWA"}, "deviceType": {"PWA"}, "appVersion": {"1.403.1"}, "UDID": {deviceID}}
	target := "https://svc.snapp.market/oauth2/default/token?" + query.Encode()
	headers := snappHeaders()
	headers.Set("Content-Type", "application/json")
	body, _ := json.Marshal(map[string]any{"data": map[string]string{
		"device_uid": deviceID, "client_id": "snappfood_pwa", "client_secret": "snappfood_pwa_secret",
		"grant_type": "client_credentials", "scope": "mobile_v2 mobile_v1 webview",
	}})
	started := time.Now()
	response, err := c.request(ctx, http.MethodPost, target, headers, body, "Snapp Market", 1, true, reserve)
	if err != nil {
		return snappGuest{}, err
	}
	if response.status == http.StatusUnauthorized {
		return snappGuest{}, &Failure{Code: "GUEST_AUTH_REJECTED", Message: "Snapp Market did not accept automatic access.", Status: 502}
	}
	var payload struct {
		Status bool `json:"status"`
		Data   struct {
			AccessToken string  `json:"access_token"`
			ExpiresIn   float64 `json:"expires_in"`
		} `json:"data"`
	}
	if json.Unmarshal(response.body, &payload) != nil || !payload.Status || strings.TrimSpace(payload.Data.AccessToken) == "" || payload.Data.ExpiresIn <= 0 {
		return snappGuest{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market guest access response changed.", Status: 502}
	}
	guest := snappGuest{token: payload.Data.AccessToken, expiresAt: started.Add(time.Duration(payload.Data.ExpiresIn * float64(time.Second)))}
	if !guest.expiresAt.After(time.Now()) {
		return snappGuest{}, &Failure{Code: "GUEST_AUTH_REJECTED", Message: "Snapp Market guest access is too short-lived.", Status: 502}
	}
	return guest, nil
}

func (c *Collector) snappRead(ctx context.Context, target string, job *scanJob, guest *snappGuest, renewed *bool) (response, error) {
	cacheKey := discoveryRequestKey("snappmarket", http.MethodGet, target)
	cached, found, err := job.LoadDiscovery(ctx, cacheKey)
	if err != nil {
		return response{}, err
	}
	if found {
		status := http.StatusOK
		if payload, decodeErr := decodeObject(cached.Body); decodeErr == nil {
			if code, ok := number(payload["status"]); ok && code == http.StatusNoContent {
				status = http.StatusNoContent
			}
		}
		return response{status: status, body: cached.Body, observedAt: cached.ObservedAt}, nil
	}
	read := func(token string) (response, error) {
		headers := snappHeaders()
		headers.Set("Authorization", "Bearer "+token)
		return c.request(ctx, http.MethodGet, target, headers, nil, "Snapp Market", 3, true, job.ReserveRequest)
	}
	if guest.token == "" || !guest.expiresAt.After(time.Now()) {
		value, err := c.acquireSnappGuest(ctx, job.DeviceID, job.ReserveRequest)
		if err != nil {
			return response{}, err
		}
		*guest = value
	}
	value, err := read(guest.token)
	if err != nil {
		return response{}, err
	}
	if value.status == http.StatusUnauthorized && !*renewed {
		*renewed = true
		canRefresh := true
		canRefresh, err = job.ClaimGuest401Refresh(ctx)
		if err != nil {
			return response{}, err
		}
		if canRefresh {
			newGuest, err := c.acquireSnappGuest(ctx, job.DeviceID, job.ReserveRequest)
			if err != nil {
				return response{}, err
			}
			*guest = newGuest
			value, err = read(guest.token)
			if err != nil {
				return response{}, err
			}
		}
	}
	if value.status == http.StatusUnauthorized {
		return response{}, &Failure{Code: "GUEST_AUTH_REJECTED", Message: "Snapp Market rejected automatic access.", Status: 502}
	}
	if value.status == http.StatusNoContent {
		value.body = []byte(`{"status":204}`)
	}
	if json.Valid(value.body) {
		cached, err := job.SaveDiscovery(ctx, cacheKey, value.body)
		if err != nil {
			return response{}, err
		}
		value.observedAt = cached.ObservedAt
	}
	return value, nil
}

func discoveryRequestKey(provider, method, target string) string {
	return provider + ":" + method + ":" + target
}

type snappGuest struct {
	token     string
	expiresAt time.Time
}

type snappVendor struct {
	ID             any            `json:"vendor_id"`
	Products       []snappProduct `json:"products"`
	LogoURL        string         `json:"logoUrl"`
	StoreLogoURL   string         `json:"storeLogoUrl"`
	LogoURLSnake   string         `json:"logo_url"`
	StoreLogoSnake string         `json:"store_logo_url"`
	Logo           string         `json:"logo"`
}

type snappProduct struct {
	ProductVariationID any     `json:"productVariationId"`
	Price              float64 `json:"price"`
	DiscountRatio      float64 `json:"discountRatio"`
	Title              string  `json:"title"`
	Discount           float64 `json:"discount"`
	Image              *string `json:"image"`
	MainImage          *string `json:"main_image"`
	VendorCode         *string `json:"vendorCode"`
	VendorID           any     `json:"vendorId"`
	VendorTitle        string  `json:"vendorTitle"`
	CategoryTitle      *string `json:"menu_category_title"`
	Stock              float64 `json:"stock"`
	OutOfStock         bool    `json:"is_out_of_stock"`
}

func normalizeSnapp(vendors map[string]snappVendor, observedAt map[string]string, threshold int) scanResult {
	products := make(map[string]Deal)
	for vendorID, vendor := range vendors {
		logo := validHTTPURL(firstNonempty(vendor.LogoURL, vendor.StoreLogoURL, vendor.LogoURLSnake, vendor.StoreLogoSnake, vendor.Logo))
		for _, product := range vendor.Products {
			productID, ok := scalarString(product.ProductVariationID)
			if !ok {
				continue
			}
			ownerID, ok := scalarString(product.VendorID)
			if !ok || ownerID != vendorID {
				continue
			}
			key := ownerID + ":" + productID
			products[key] = Deal{Key: key, ProductVariationID: productID, VendorID: vendorID, Title: product.Title, Image: firstValidURLPointer(product.Image, product.MainImage), VendorTitle: product.VendorTitle, VendorCode: product.VendorCode, CategoryTitle: product.CategoryTitle, PriceRials: int64(product.Price), DiscountRials: int64(product.Discount), FinalPriceRials: max(int64(product.Price-product.Discount), 0), DiscountRatio: product.DiscountRatio, Stock: int(product.Stock), Facts: facts(logo, observedAt[vendorID], "snapp:market_party", 100)}
		}
	}
	deals := make([]Deal, 0, len(products))
	for _, deal := range products {
		if deal.DiscountRatio >= float64(threshold) && deal.Stock > 0 {
			deals = append(deals, deal)
		}
	}
	return scanResult{VendorCount: len(vendors), ProductCount: len(products), Deals: deals, Coverage: "complete"}
}

type okalaOfferStore struct {
	ID int64 `json:"id"`
}

type okalaOfferRequest struct {
	CarouselID int64             `json:"carouselId,omitempty"`
	Stores     []okalaOfferStore `json:"stores"`
	PageType   string            `json:"pageType,omitempty"`
}

func (c *Collector) collectOkala(ctx context.Context, job *scanJob) (scanResult, error) {
	coordinates := url.Values{"latitude": {strconv.FormatFloat(job.Location.Latitude, 'f', -1, 64)}, "longitude": {strconv.FormatFloat(job.Location.Longitude, 'f', -1, 64)}}
	nearby, err := c.okalaRequest(ctx, http.MethodGet, "/opex/v4/stores/nearby", coordinates, nil, job)
	if err != nil {
		return scanResult{}, err
	}
	var storeResponse struct {
		Success bool `json:"success"`
		Data    struct {
			Stores []struct {
				ID     int64 `json:"storeId"`
				Active bool  `json:"isActive"`
				Serves bool  `json:"isServes"`
				Exists bool  `json:"isExist"`
			} `json:"stores"`
		} `json:"data"`
	}
	if json.Unmarshal(nearby.body, &storeResponse) != nil || !storeResponse.Success {
		return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala store response format changed.", Status: 502}
	}
	storeIDs := make([]int64, 0)
	seenStores := make(map[int64]struct{})
	for _, store := range storeResponse.Data.Stores {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		if store.ID > 0 && store.Active && store.Serves && store.Exists {
			if _, exists := seenStores[store.ID]; !exists {
				seenStores[store.ID] = struct{}{}
				storeIDs = append(storeIDs, store.ID)
			}
		}
	}
	if len(storeIDs) == 0 {
		return scanResult{}, &Failure{Code: "NO_STORES", Message: "No active Okala stores serve this location.", Status: 502}
	}
	stores := make([]okalaOfferStore, 0, len(storeIDs))
	for _, storeID := range storeIDs {
		stores = append(stores, okalaOfferStore{ID: storeID})
	}
	campaignPayload, err := json.Marshal(okalaOfferRequest{Stores: stores, PageType: "HomePage"})
	if err != nil {
		return scanResult{}, err
	}
	campaignBody, err := c.okalaRequest(ctx, http.MethodPost, "/carousel/v4/offers", nil, campaignPayload, job)
	if err != nil {
		return scanResult{}, err
	}
	var campaignResponse struct {
		Success     bool `json:"success"`
		HasNextPage bool `json:"hasNextPage"`
		TotalPages  int  `json:"totalPages"`
		Carousels   []struct {
			Multi   bool   `json:"isMulti"`
			ID      int64  `json:"id"`
			EndTime string `json:"endTime"`
		} `json:"carousels"`
	}
	if json.Unmarshal(campaignBody.body, &campaignResponse) != nil || !campaignResponse.Success || campaignResponse.HasNextPage || campaignResponse.TotalPages > 1 {
		return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Okala campaigns have additional pages that are not available in this scan.", Status: 502}
	}
	campaignIDs := make([]int64, 0)
	expiries := make(map[int64]string)
	for _, campaign := range campaignResponse.Carousels {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		if !campaign.Multi || campaign.ID <= 0 {
			continue
		}
		if campaign.EndTime != "" {
			parsed, parseErr := time.Parse(time.RFC3339, campaign.EndTime)
			if parseErr == nil && !parsed.After(time.Now()) {
				continue
			}
		}
		campaignIDs = append(campaignIDs, campaign.ID)
		expiries[campaign.ID] = campaign.EndTime
	}
	rows := make(map[string]Deal)
	inspected := make(map[int64]struct{})
	productCount := 0
	for _, campaignID := range campaignIDs {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		detailPayload, err := json.Marshal(okalaOfferRequest{CarouselID: campaignID, Stores: stores})
		if err != nil {
			return scanResult{}, err
		}
		body, err := c.okalaRequest(ctx, http.MethodPost, "/carousel/v4/offers/multi-store", nil, detailPayload, job)
		if err != nil {
			return scanResult{}, err
		}
		var offers struct {
			Success     bool `json:"success"`
			HasNextPage bool `json:"hasNextPage"`
			TotalPages  int  `json:"totalPages"`
			Entities    []struct {
				StoreID        int64  `json:"storeId"`
				StoreName      string `json:"storeName"`
				LogoURL        string `json:"logoUrl"`
				StoreLogoURL   string `json:"storeLogoUrl"`
				LogoSnake      string `json:"logo_url"`
				StoreLogoSnake string `json:"store_logo_url"`
				Products       []struct {
					ID              any     `json:"id"`
					Name            string  `json:"name"`
					DiscountPercent float64 `json:"discountPercent"`
					Quantity        float64 `json:"quantity"`
					HasQuantity     bool    `json:"hasQuantity"`
					OkPrice         float64 `json:"okPrice"`
					Price           float64 `json:"price"`
					StoreName       string  `json:"storeName"`
					StoreID         int64   `json:"storeId"`
					ImageURL        *string `json:"imageUrl"`
					StoreTypeName   *string `json:"storeTypeName"`
				} `json:"products"`
			} `json:"entities"`
		}
		if json.Unmarshal(body.body, &offers) != nil || offers.Success == false && len(offers.Entities) == 0 || offers.HasNextPage || offers.TotalPages > 1 {
			return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Okala campaign has additional pages that are not available in this scan.", Status: 502}
		}
		observedAt, err := stableObservedAt(body.observedAt, job.StartedAt())
		if err != nil {
			return scanResult{}, err
		}
		for _, entity := range offers.Entities {
			if err := ctx.Err(); err != nil {
				return scanResult{}, err
			}
			if _, eligible := seenStores[entity.StoreID]; eligible {
				inspected[entity.StoreID] = struct{}{}
			}
			logo := validHTTPURL(firstNonempty(entity.LogoURL, entity.StoreLogoURL, entity.LogoSnake, entity.StoreLogoSnake))
			for _, product := range entity.Products {
				if err := ctx.Err(); err != nil {
					return scanResult{}, err
				}
				productCount++
				productID, ok := scalarString(product.ID)
				if !ok || productID == "" || product.StoreID <= 0 {
					return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala returned an invalid product identity.", Status: 502}
				}
				if product.DiscountPercent < float64(job.Threshold) || !product.HasQuantity || product.Quantity <= 0 {
					continue
				}
				storeName := product.StoreName
				if storeName == "" {
					storeName = entity.StoreName
				}
				key := fmt.Sprintf("%d:%s", product.StoreID, productID)
				rows[key] = Deal{Key: key, ProductVariationID: productID, VendorID: strconv.FormatInt(product.StoreID, 10), Title: product.Name, Image: firstValidURLPointer(product.ImageURL), VendorTitle: storeName, CategoryTitle: product.StoreTypeName, PriceRials: int64(product.Price), DiscountRials: max(int64(product.Price-product.OkPrice), 0), FinalPriceRials: int64(product.OkPrice), DiscountRatio: product.DiscountPercent, Stock: int(product.Quantity), Facts: facts(logo, observedAt, "okala:campaign:"+strconv.FormatInt(campaignID, 10), 50)}
			}
		}
		if err := job.Progress(ctx, len(inspected), productCount); err != nil {
			return scanResult{}, err
		}
		metadata, err := json.Marshal(map[string]any{"contractVersion": 1, "campaignId": campaignID, "vendorCount": len(inspected), "productCount": productCount, "terminal": true})
		if err != nil {
			return scanResult{}, err
		}
		unitID := "okala_campaign:" + strconv.FormatInt(campaignID, 10)
		descriptor := fmt.Sprintf(`{"kind":"okala_campaign","contractVersion":1,"campaignId":%d}`, campaignID)
		if err := job.RecordPage(ctx, pageCheckpoint{UnitID: unitID, Descriptor: descriptor, Page: 0, ResponseBody: body.body, Metadata: string(metadata), Terminal: true, TerminalNote: "campaign_response_complete"}); err != nil {
			return scanResult{}, err
		}
	}
	deals := make([]Deal, 0, len(rows))
	for _, deal := range rows {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		deals = append(deals, deal)
	}
	return scanResult{VendorCount: len(inspected), ProductCount: productCount, Deals: deals, Coverage: "complete"}, nil
}

func (c *Collector) okalaRequest(ctx context.Context, method, endpoint string, query url.Values, payload []byte, job *scanJob) (response, error) {
	target := "https://apigateway.okala.com/api" + endpoint
	if encodedQuery := query.Encode(); encodedQuery != "" {
		target += "?" + encodedQuery
	}
	cacheKey := discoveryRequestKey("okala", method, target)
	if method == http.MethodPost {
		cacheKey += fmt.Sprintf(":%x", sha256.Sum256(payload))
	}
	cached, found, err := job.LoadDiscovery(ctx, cacheKey)
	if err != nil {
		return response{}, err
	}
	if found {
		return response{status: http.StatusOK, body: cached.Body, observedAt: cached.ObservedAt}, nil
	}
	headers := make(http.Header)
	headers.Set("Accept", "application/json")
	headers.Set("Origin", "https://www.okala.com")
	headers.Set("Source", "okala")
	headers.Set("Ui-Version", "2.0")
	if method == http.MethodPost {
		headers.Set("Content-Type", "application/json")
	}
	reserve := job.ReserveRequest
	if method == http.MethodPost {
		// Distinguish logical requests that share a path, such as separate Okala campaigns.
		payloadKey := fmt.Sprintf(":%x", sha256.Sum256(payload))
		reserve = func(ctx context.Context, operation string) error {
			return job.ReserveRequest(ctx, operation+payloadKey)
		}
	}
	value, err := c.request(ctx, method, target, headers, payload, "Okala", 3, false, reserve)
	if err != nil {
		return response{}, err
	}
	if json.Valid(value.body) {
		cached, err := job.SaveDiscovery(ctx, cacheKey, value.body)
		if err != nil {
			return response{}, err
		}
		value.observedAt = cached.ObservedAt
	}
	return value, nil
}

func snappHeaders() http.Header {
	headers := make(http.Header)
	headers.Set("Accept", "application/json, text/plain, */*")
	headers.Set("Accept-Language", "fa-IR, fa;q=0.9,en;q=0.8")
	headers.Set("Origin", "https://snapp.market")
	headers.Set("Referer", "https://snapp.market/")
	headers.Set("User-Agent", "Mozilla/5.0 BetterBuy/1.0")
	return headers
}

func facts(logo *string, observedAt, provenance string, priority int) json.RawMessage {
	value := map[string]any{
		"benefit":    map[string]any{"kind": "standard_discount", "identity": "ordinary", "applicable": true, "terms": nil},
		"observedAt": observedAt, "provenance": []string{provenance}, "observationPriority": priority,
	}
	if logo != nil {
		value["vendorLogoUrl"] = *logo
	}
	encoded, _ := json.Marshal(value)
	return encoded
}

func scalarString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed), typed != ""
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return "", false
		}
		return strconv.FormatFloat(typed, 'f', -1, 64), true
	case json.Number:
		return typed.String(), true
	default:
		return "", false
	}
}

func validHTTPURL(value string) *string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return nil
	}
	result := parsed.String()
	return &result
}

func firstValidURLPointer(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			if parsed := validHTTPURL(*value); parsed != nil {
				return parsed
			}
		}
	}
	return nil
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func retryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds >= 0 {
		return time.Duration(seconds * float64(time.Second))
	}
	if at, err := http.ParseTime(value); err == nil {
		return max(time.Until(at), 0)
	}
	return 0
}

func sleep(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
