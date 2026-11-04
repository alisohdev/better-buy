package providers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const snappCampaignPageSize = 100

func normalizedCampaignSource(scope CampaignScope) string {
	if scope.Source == "" {
		return "store_campaign"
	}
	return scope.Source
}

func campaignUnitID(scope CampaignScope) string {
	return fmt.Sprintf("snapp_campaign:%s:%d:%d", normalizedCampaignSource(scope), scope.VendorID, scope.CollectionID)
}

func campaignUnitDescriptor(scope CampaignScope) ([]byte, error) {
	return json.Marshal(struct {
		Kind            string        `json:"kind"`
		ContractVersion int           `json:"contractVersion"`
		Scope           CampaignScope `json:"scope"`
	}{"snapp_campaign", 1, scope})
}

func stableObservedAt(observedAt string, startedAt time.Time) (string, error) {
	if observedAt != "" {
		return observedAt, nil
	}
	if startedAt.IsZero() {
		return "", errors.New("scan start time is unavailable for observation")
	}
	return startedAt.UTC().Format(time.RFC3339Nano), nil
}

type campaignPage struct {
	Count int
	Rows  []map[string]any
}

func decodeObject(body []byte) (map[string]any, error) {
	if !json.Valid(body) {
		return nil, errors.New("response is not valid JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, errors.New("response is not a JSON object")
	}
	return value, nil
}

func object(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func number(value any) (float64, bool) {
	switch value := value.(type) {
	case json.Number:
		parsed, err := value.Float64()
		return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	case float64:
		return value, !math.IsNaN(value) && !math.IsInf(value, 0)
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	default:
		return 0, false
	}
}

func positiveID(value any) (int64, bool) {
	switch value := value.(type) {
	case json.Number:
		if integer, err := value.Int64(); err == nil && integer > 0 {
			return integer, true
		}
	case int64:
		return value, value > 0
	case int:
		return int64(value), value > 0
	}
	parsed, ok := number(value)
	if !ok || parsed <= 0 || parsed > math.MaxInt64 || math.Trunc(parsed) != parsed {
		return 0, false
	}
	return int64(parsed), true
}

func campaignURL(scope CampaignScope, page int, location scanLocation, deviceID string) string {
	var target *url.URL
	if scope.Source == "discounted_category" {
		target, _ = url.Parse("https://svc.snapp.market/express-search/product-list/vendor")
		query := target.Query()
		query.Set("vendor_code", scope.VendorCode)
		query.Set("category_id", strconv.FormatInt(scope.CollectionID, 10))
		query.Set("lat", strconv.FormatFloat(location.Latitude, 'f', -1, 64))
		query.Set("long", strconv.FormatFloat(location.Longitude, 'f', -1, 64))
		query.Set("filters", `["has_discount"]`)
		query.Set("page", strconv.Itoa(page))
		query.Set("pageSize", strconv.Itoa(snappCampaignPageSize))
		target.RawQuery = query.Encode()
	} else {
		target, _ = url.Parse(fmt.Sprintf("https://svc.snapp.market/express-search/product-list/%d/vendor/%s", scope.CollectionID, url.PathEscape(scope.VendorCode)))
		query := target.Query()
		query.Set("variable", strconv.FormatInt(scope.CollectionID, 10))
		query.Set("secondVariable", scope.VendorCode)
		query.Set("lat", strconv.FormatFloat(location.Latitude, 'f', -1, 64))
		query.Set("long", strconv.FormatFloat(location.Longitude, 'f', -1, 64))
		query.Set("filters", "[]")
		query.Set("page", strconv.Itoa(page))
		query.Set("page_size", strconv.Itoa(snappCampaignPageSize))
		target.RawQuery = query.Encode()
	}
	query := target.Query()
	query.Set("client", "PWA")
	query.Set("deviceType", "PWA")
	query.Set("appVersion", "1.403.1")
	query.Set("UDID", deviceID)
	target.RawQuery = query.Encode()
	return target.String()
}

func discoveryURL(path string, query url.Values, deviceID string) string {
	if query == nil {
		query = make(url.Values)
	}
	query.Set("client", "PWA")
	query.Set("deviceType", "PWA")
	query.Set("appVersion", "1.403.1")
	query.Set("UDID", deviceID)
	return "https://svc.snapp.market" + path + "?" + query.Encode()
}

func parseCampaignPage(body []byte, scope CampaignScope, terminalCount *int) (campaignPage, error) {
	root, err := decodeObject(body)
	if err != nil {
		return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign response format changed.", Status: 502}
	}
	if status, exists := root["status"]; exists {
		if code, ok := number(status); ok && code == 204 && scope.Source == "discounted_category" && terminalCount != nil {
			return campaignPage{Count: *terminalCount}, nil
		}
		if status != true {
			return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign response format changed.", Status: 502}
		}
	}
	if scope.Source == "discounted_category" && root["status"] != true {
		return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market category response format changed.", Status: 502}
	}
	data := object(root["data"])
	if data == nil {
		return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign page is missing data.", Status: 502}
	}
	countValue, ok := number(data["count"])
	if !ok || countValue < 0 || math.Trunc(countValue) != countValue || countValue > math.MaxInt {
		return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign count is invalid.", Status: 502}
	}
	if scope.Source == "discounted_category" {
		if owners, exists := root["vendor_id"]; exists {
			values, ok := owners.([]any)
			if !ok {
				return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market category ownership is invalid.", Status: 502}
			}
			for _, value := range values {
				ownerID, valid := positiveID(value)
				if !valid || ownerID != scope.VendorID {
					return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market category ownership changed.", Status: 502}
				}
			}
		}
	} else {
		if data["type"] != "default" {
			return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign type changed.", Status: 502}
		}
		id, valid := positiveID(data["id"])
		if !valid || id != scope.CollectionID {
			return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign ownership changed.", Status: 502}
		}
	}
	entries, ok := data["finalResult"].([]any)
	if !ok {
		return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign rows are invalid.", Status: 502}
	}
	rows := make([]map[string]any, 0, len(entries))
	for _, value := range entries {
		entry := object(value)
		if entry == nil || entry["type"] != "PRODUCT" || object(entry["data"]) == nil {
			return campaignPage{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign product row changed.", Status: 502}
		}
		rows = append(rows, object(entry["data"]))
	}
	return campaignPage{Count: int(countValue), Rows: rows}, nil
}

func (c *Collector) planSnappCampaigns(ctx context.Context, job *scanJob, guest *snappGuest, renewed *bool) ([]CampaignScope, error) {
	location := job.Location
	nearbyQuery := url.Values{
		"lat":  {strconv.FormatFloat(location.Latitude, 'f', -1, 64)},
		"long": {strconv.FormatFloat(location.Longitude, 'f', -1, 64)},
		"sort": {"lowest_delivery_price"}, "page": {"0"}, "page_size": {"20"},
		"is_home": {"false"}, "page_type": {"vendor_list"}, "extra-filter[vendor_collection]": {"-1"},
	}
	nearbyURL := discoveryURL("/express-vendor/general/vendors-list", nearbyQuery, job.DeviceID)
	response, err := c.snappRead(ctx, nearbyURL, job, guest, renewed)
	if err != nil {
		return nil, err
	}
	nearbyRoot, err := decodeObject(response.body)
	if err != nil || nearbyRoot["status"] != true {
		return nil, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market nearby store response changed.", Status: 502}
	}
	nearbyData := object(nearbyRoot["data"])
	if nearbyData == nil {
		return nil, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market nearby store response changed.", Status: 502}
	}
	count, ok := number(nearbyData["count"])
	entries, entriesOK := nearbyData["finalResult"].([]any)
	if !ok || count < 0 || math.Trunc(count) != count || !entriesOK {
		return nil, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market nearby store response changed.", Status: 502}
	}
	allEntries := append([]any(nil), entries...)
	fingerprint := make(map[string]struct{})
	lastFingerprint, _ := json.Marshal(entries)
	fingerprint[string(lastFingerprint)] = struct{}{}
	discovered := countVendors(entries)
	for page := 1; float64(discovered) < count; page++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		nearbyQuery.Set("page", strconv.Itoa(page))
		response, err := c.snappRead(ctx, discoveryURL("/express-vendor/general/vendors-list", nearbyQuery, job.DeviceID), job, guest, renewed)
		if err != nil {
			return nil, err
		}
		root, parseErr := decodeObject(response.body)
		data := object(root["data"])
		pageCount, countOK := number(data["count"])
		rows, rowsOK := data["finalResult"].([]any)
		if parseErr != nil || root["status"] != true || !countOK || pageCount != count || !rowsOK || len(rows) == 0 {
			return nil, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market nearby store list did not finish cleanly.", Status: 502}
		}
		encoded, _ := json.Marshal(rows)
		if _, exists := fingerprint[string(encoded)]; exists {
			return nil, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market repeated a nearby store page.", Status: 502}
		}
		fingerprint[string(encoded)] = struct{}{}
		allEntries = append(allEntries, rows...)
		discovered += countVendors(rows)
	}

	codes := make(map[string]struct{})
	for _, entryValue := range allEntries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		entry := object(entryValue)
		if entry == nil || entry["type"] != "VENDOR" {
			continue
		}
		store := object(entry["data"])
		if code, ok := store["code"].(string); ok && validVendorCode(code) {
			codes[code] = struct{}{}
		}
	}
	hint := object(nearbyData["single_super_mall"])
	hintCode, _ := hint["code"].(string)
	if validVendorCode(hintCode) {
		codes[hintCode] = struct{}{}
	}
	orderedCodes := make([]string, 0, len(codes))
	for code := range codes {
		orderedCodes = append(orderedCodes, code)
	}
	sort.Strings(orderedCodes)
	resolvedOwners := make(map[int64]string)
	scopes := make([]CampaignScope, 0)
	for _, code := range orderedCodes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		homeQuery := url.Values{"variable": {code}, "lat": {strconv.FormatFloat(location.Latitude, 'f', -1, 64)}, "long": {strconv.FormatFloat(location.Longitude, 'f', -1, 64)}}
		home, err := c.snappRead(ctx, discoveryURL("/express-home/vendor/"+url.PathEscape(code), homeQuery, job.DeviceID), job, guest, renewed)
		if err != nil {
			if omittedDiscoveryError(err) {
				continue
			}
			return nil, err
		}
		root, err := decodeObject(home.body)
		info := object(root["vendorInfo"])
		delivery := object(info["deliveryData"])
		vendorID, validID := positiveID(info["id"])
		resolvedCode, _ := info["code"].(string)
		title, _ := info["title"].(string)
		if err != nil || info == nil || !validID || resolvedCode != code || strings.TrimSpace(title) == "" {
			continue
		}
		if prior := resolvedOwners[vendorID]; prior != "" && prior != code {
			return nil, &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market store identities conflict.", Status: 502}
		}
		resolvedOwners[vendorID] = code
		if id, exists := delivery["id"]; exists {
			ownerID, ok := positiveID(id)
			if !ok || ownerID != vendorID {
				continue
			}
		}
		if detail := object(delivery["detail"]); detail != nil {
			if id, exists := detail["vendorId"]; exists {
				ownerID, ok := positiveID(id)
				if !ok || ownerID != vendorID {
					continue
				}
			}
		}
		isOutOfArea, _ := info["isOutOfArea"].(bool)
		delivers, _ := delivery["doesDeliver"].(bool)
		isExpress, isExpressPresent := delivery["isExpress"].(bool)
		scheduleOption, scheduleOptionPresent := delivery["scheduleOption"]
		noAvailableSlot := isExpressPresent && !isExpress && scheduleOptionPresent && scheduleOption == nil
		if isOutOfArea || !delivers || delivery["deliveryStatus"] == "NOT_OPEN" || noAvailableSlot {
			continue
		}
		candidateIDs := make(map[int64]struct{})
		if sections, ok := info["sections"].([]any); ok {
			for _, sectionValue := range sections {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				section := object(sectionValue)
				if section == nil || section["type"] != "product-list" || section["collection_type"] != "default" || section["config"] != nil || conditionalMetadata(section) {
					continue
				}
				if id, ok := positiveID(section["value"]); ok {
					candidateIDs[id] = struct{}{}
				}
			}
		}
		if code == hintCode {
			categoryQuery := url.Values{"vendorCode": {code}, "lat": {strconv.FormatFloat(location.Latitude, 'f', -1, 64)}, "long": {strconv.FormatFloat(location.Longitude, 'f', -1, 64)}}
			categoryResponse, readErr := c.snappRead(ctx, discoveryURL("/mobile/search/categories", categoryQuery, job.DeviceID), job, guest, renewed)
			if readErr == nil {
				categoryRoot, parseErr := decodeObject(categoryResponse.body)
				if parseErr == nil && categoryRoot["status"] == true {
					if items, ok := categoryRoot["items"].([]any); ok {
						for _, itemValue := range items {
							if err := ctx.Err(); err != nil {
								return nil, err
							}
							if id, ok := positiveID(object(itemValue)["id"]); ok {
								scopes = append(scopes, CampaignScope{VendorID: vendorID, VendorCode: code, VendorTitle: title, CollectionID: id, Source: "discounted_category"})
							}
						}
					}
				}
			} else if !omittedDiscoveryError(readErr) {
				return nil, readErr
			}
		}
		ordinary := make([]int64, 0, len(candidateIDs))
		for id := range candidateIDs {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			ordinary = append(ordinary, id)
		}
		sort.Slice(ordinary, func(a, b int) bool { return ordinary[a] < ordinary[b] })
		for _, id := range ordinary {
			scopes = append(scopes, CampaignScope{VendorID: vendorID, VendorCode: code, VendorTitle: title, CollectionID: id})
		}
	}

	validated := make([]CampaignScope, 0, len(scopes))
	seen := make(map[string]struct{})
scopeLoop:
	for _, scope := range scopes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		key := fmt.Sprintf("%s:%d:%d", scope.Source, scope.VendorID, scope.CollectionID)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		probeURL := campaignURL(scope, 0, location, job.DeviceID)
		probe, err := c.snappRead(ctx, probeURL, job, guest, renewed)
		if err != nil {
			if omittedDiscoveryError(err) {
				continue
			}
			return nil, err
		}
		first, err := parseCampaignPage(probe.body, scope, nil)
		if err != nil || len(first.Rows) > snappCampaignPageSize || (first.Count > len(first.Rows) && (len(first.Rows) == 0 || scope.Source == "" && len(first.Rows) != snappCampaignPageSize)) || (first.Count == 0 && len(first.Rows) != 0) || len(first.Rows) > first.Count {
			continue
		}
		if scope.Source == "discounted_category" {
			for _, row := range first.Rows {
				if err := ctx.Err(); err != nil {
					return nil, err
				}
				if !campaignProductMatchesCategory(row, scope.CollectionID) {
					continue scopeLoop
				}
			}
			size := len(first.Rows)
			if size == 0 {
				size = snappCampaignPageSize
			}
			scope.ExpectedPageSize = &size
		}
		validated = append(validated, scope)
	}
	sort.Slice(validated, func(a, b int) bool {
		if validated[a].VendorID != validated[b].VendorID {
			return validated[a].VendorID < validated[b].VendorID
		}
		sourceA, sourceB := normalizedCampaignSource(validated[a]), normalizedCampaignSource(validated[b])
		if sourceA != sourceB {
			return sourceA < sourceB
		}
		return validated[a].CollectionID < validated[b].CollectionID
	})
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return validated, nil
}

func countVendors(entries []any) int {
	count := 0
	for _, entry := range entries {
		if object(entry)["type"] == "VENDOR" {
			count++
		}
	}
	return count
}

func validVendorCode(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') {
			return false
		}
	}
	return true
}

func conditionalMetadata(value map[string]any) bool {
	for _, key := range []string{"is_pro", "requires_pro", "isPro"} {
		if field, ok := value[key].(bool); ok && field {
			return true
		}
	}
	for _, key := range []string{"conditions", "terms", "benefit"} {
		if field, exists := value[key]; exists && field != nil {
			return true
		}
	}
	return false
}

func omittedDiscoveryError(err error) bool {
	var failure *Failure
	if !errors.As(err, &failure) {
		return false
	}
	switch failure.Code {
	case "UPSTREAM_CHANGED", "UPSTREAM_INVALID_JSON", "UPSTREAM_ERROR":
		return true
	default:
		return false
	}
}

func (c *Collector) enrichSnappCampaigns(ctx context.Context, job *scanJob, scopes []CampaignScope, baselineVendors map[string]snappVendor, baseline scanResult, guest *snappGuest, renewed *bool) (scanResult, error) {
	vendorIDs := make(map[string]struct{}, len(baselineVendors)+len(scopes))
	productKeys := make(map[string]struct{}, baseline.ProductCount)
	vendorTitles := make(map[int64]string)
	for _, scope := range scopes {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		if scope.VendorTitle != "" {
			vendorTitles[scope.VendorID] = scope.VendorTitle
			continue
		}
		if vendorTitles[scope.VendorID] != "" {
			continue
		}
		homeQuery := url.Values{"variable": {scope.VendorCode}, "lat": {strconv.FormatFloat(job.Location.Latitude, 'f', -1, 64)}, "long": {strconv.FormatFloat(job.Location.Longitude, 'f', -1, 64)}}
		home, err := c.snappRead(ctx, discoveryURL("/express-home/vendor/"+url.PathEscape(scope.VendorCode), homeQuery, job.DeviceID), job, guest, renewed)
		if err != nil {
			return scanResult{}, err
		}
		root, err := decodeObject(home.body)
		info := object(root["vendorInfo"])
		if err == nil && info != nil && info["code"] == scope.VendorCode {
			if title, ok := info["title"].(string); ok && strings.TrimSpace(title) != "" {
				vendorTitles[scope.VendorID] = title
			}
		}
	}
	for vendorID, vendor := range baselineVendors {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		vendorIDs[vendorID] = struct{}{}
		for _, product := range vendor.Products {
			if err := ctx.Err(); err != nil {
				return scanResult{}, err
			}
			productID, productOK := scalarString(product.ProductVariationID)
			ownerID, ownerOK := scalarString(product.VendorID)
			if productOK && ownerOK && ownerID == vendorID && productID != "" {
				productKeys[vendorID+":"+productID] = struct{}{}
			}
		}
	}

	for _, scope := range scopes {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		unitID := campaignUnitID(scope)
		descriptor, err := campaignUnitDescriptor(scope)
		if err != nil {
			return scanResult{}, err
		}
		var reportedCount int
		var rawCount int
		fingerprints := make(map[string]struct{})
		for pageNumber := 0; ; pageNumber++ {
			if err := ctx.Err(); err != nil {
				return scanResult{}, err
			}
			target := campaignURL(scope, pageNumber, job.Location, job.DeviceID)
			response, err := c.snappRead(ctx, target, job, guest, renewed)
			if err != nil {
				return scanResult{}, err
			}
			var previousCount *int
			if pageNumber > 0 {
				previousCount = &reportedCount
			}
			page, err := parseCampaignPage(response.body, scope, previousCount)
			if err != nil {
				return scanResult{}, err
			}
			if pageNumber == 0 {
				reportedCount = page.Count
			} else if page.Count != reportedCount {
				return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market campaign count changed during collection.", Status: 502}
			}
			pageSize := len(page.Rows)
			if pageSize == 0 {
				if rawCount != reportedCount {
					return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market campaign ended before its reported count.", Status: 502}
				}
				metadata, err := json.Marshal(map[string]any{"contractVersion": 1, "page": pageNumber, "reportedCount": reportedCount, "rawCount": rawCount, "pageSize": 0, "terminal": true})
				if err != nil {
					return scanResult{}, err
				}
				if err := job.RecordPage(ctx, pageCheckpoint{UnitID: unitID, Descriptor: string(descriptor), Page: pageNumber, ResponseBody: response.body, Metadata: string(metadata), Terminal: true, TerminalNote: "provider_total_reached"}); err != nil {
					return scanResult{}, err
				}
				break
			}
			if pageSize > snappCampaignPageSize || (scope.ExpectedPageSize != nil && pageSize > *scope.ExpectedPageSize) {
				return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market campaign page size changed.", Status: 502}
			}
			identities := make([]string, 0, pageSize)
			contributions := make([]campaignContribution, 0, pageSize)
			observations := make([]scanObservation, 0, pageSize+1)
			observations = append(observations, scanObservation{Kind: "vendor", Identity: strconv.FormatInt(scope.VendorID, 10)})
			for _, row := range page.Rows {
				if err := ctx.Err(); err != nil {
					return scanResult{}, err
				}
				vendorTitle := vendorTitles[scope.VendorID]
				if vendorTitle == "" {
					vendorTitle = scope.VendorCode
				}
				contribution, identity, err := campaignProduct(row, scope, vendorTitle, job.Threshold, response.observedAt, job.StartedAt())
				if err != nil {
					return scanResult{}, err
				}
				identities = append(identities, identity)
				contributions = append(contributions, contribution)
				observations = append(observations, scanObservation{Kind: "product", Identity: identity})
				productKeys[identity] = struct{}{}
			}
			sort.Strings(identities)
			encodedFingerprint, _ := json.Marshal(identities)
			if _, exists := fingerprints[string(encodedFingerprint)]; exists {
				return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market repeated a campaign page.", Status: 502}
			}
			fingerprints[string(encodedFingerprint)] = struct{}{}
			rawCount += pageSize
			if rawCount > reportedCount {
				return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Snapp Market campaign exceeded its reported count.", Status: 502}
			}
			metadata, err := json.Marshal(map[string]any{"contractVersion": 1, "page": pageNumber, "reportedCount": reportedCount, "rawCount": rawCount, "pageSize": pageSize, "terminal": false})
			if err != nil {
				return scanResult{}, err
			}
			if err := job.RecordPage(ctx, pageCheckpoint{UnitID: unitID, Descriptor: string(descriptor), Page: pageNumber, ResponseBody: response.body, Metadata: string(metadata), Contributions: contributions, Observations: observations}); err != nil {
				return scanResult{}, err
			}
			vendorIDs[strconv.FormatInt(scope.VendorID, 10)] = struct{}{}
			if err := job.Progress(ctx, len(vendorIDs), len(productKeys)); err != nil {
				return scanResult{}, err
			}
		}
		vendorIDs[strconv.FormatInt(scope.VendorID, 10)] = struct{}{}
	}

	contributions, err := job.CampaignContributions(ctx)
	if err != nil {
		return scanResult{}, err
	}
	quarantined, err := job.journal.hasCampaignQuarantines(ctx)
	if err != nil {
		return scanResult{}, err
	}
	merged := make(map[string]Deal, len(baseline.Deals)+len(contributions))
	for _, deal := range baseline.Deals {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		merged[deal.Key] = deal
	}
	for _, contribution := range contributions {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		if contribution.Offer == nil {
			continue
		}
		prior, found := merged[contribution.DealKey]
		if !found {
			merged[contribution.DealKey] = *contribution.Offer
			continue
		}
		merged[contribution.DealKey] = mergeObservation(prior, *contribution.Offer)
	}
	deals := make([]Deal, 0, len(merged))
	for _, deal := range merged {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		deals = append(deals, deal)
	}
	sort.Slice(deals, func(a, b int) bool {
		if deals[a].DiscountRatio != deals[b].DiscountRatio {
			return deals[a].DiscountRatio > deals[b].DiscountRatio
		}
		if deals[a].FinalPriceRials != deals[b].FinalPriceRials {
			return deals[a].FinalPriceRials < deals[b].FinalPriceRials
		}
		return deals[a].Key < deals[b].Key
	})
	coverage := baseline.Coverage
	if quarantined {
		coverage = "incomplete"
	}
	return scanResult{VendorCount: len(vendorIDs), ProductCount: len(productKeys), Deals: deals, Coverage: coverage}, nil
}

func campaignProductMatchesCategory(row map[string]any, categoryID int64) bool {
	value, exists := row["root_category_id"]
	if !exists {
		return true
	}
	productCategoryID, ok := positiveID(value)
	return ok && productCategoryID == categoryID
}

func campaignProduct(row map[string]any, scope CampaignScope, vendorTitle string, threshold int, observedAt string, startedAt time.Time) (campaignContribution, string, error) {
	changed := func(field string) error {
		return &Failure{Code: "UPSTREAM_CHANGED", Message: "Snapp Market campaign product changed: " + field, Status: 502}
	}
	id, valid := positiveID(row["id"])
	if !valid {
		return campaignContribution{}, "", changed("id")
	}
	vendorID, valid := positiveID(row["vendor_id"])
	if !valid || vendorID != scope.VendorID {
		return campaignContribution{}, "", changed("vendor_id ownership")
	}
	subVendorID := row["sub_vendor_id"]
	documentID, _ := row["document_id"].(string)
	if subVendorID == nil && documentID != fmt.Sprintf("%d-%d", id, scope.VendorID) {
		return campaignContribution{}, "", changed("document_id ownership")
	}
	title, _ := row["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" {
		return campaignContribution{}, "", changed("title")
	}
	price, priceOK := number(row["price"])
	discount, discountOK := number(row["discount"])
	if !priceOK || !discountOK || price <= 0 || discount < 0 || price > math.MaxInt64 || discount > math.MaxInt64 {
		return campaignContribution{}, "", changed("price / discount")
	}
	ratioValue, ratioPresent := row["discountRatio"]
	if !ratioPresent {
		return campaignContribution{}, "", changed("discountRatio")
	}
	ratio := float64(0)
	if ratioValue != nil {
		var ok bool
		ratio, ok = number(ratioValue)
		if !ok || ratio < 0 || ratio > 100 {
			return campaignContribution{}, "", changed("discountRatio")
		}
	} else if discount > 0 {
		return campaignContribution{}, "", changed("discountRatio is null for a positive discount")
	}
	if discount > price || math.Abs(ratio-(discount/price)*100) > 1 {
		return campaignContribution{}, "", changed("price / discount / discountRatio agreement")
	}
	if value, exists := row["vendor_code"]; exists && value != scope.VendorCode {
		return campaignContribution{}, "", changed("vendor_code ownership")
	}
	if value, exists := row["vendorCode"]; exists && value != scope.VendorCode {
		return campaignContribution{}, "", changed("vendorCode ownership")
	}
	if nested, exists := row["vendor"]; exists && nested != nil {
		if nestedVendor := object(nested); nestedVendor != nil {
			if value, exists := nestedVendor["id"]; exists {
				owner, ok := positiveID(value)
				if !ok || owner != scope.VendorID {
					return campaignContribution{}, "", changed("vendor.id ownership")
				}
			}
			if value, exists := nestedVendor["code"]; exists && value != scope.VendorCode {
				return campaignContribution{}, "", changed("vendor.code ownership")
			}
		}
	}
	if scope.Source == "discounted_category" && !campaignProductMatchesCategory(row, scope.CollectionID) {
		return campaignContribution{}, "", changed("category product ownership")
	}
	identity := strconv.FormatInt(scope.VendorID, 10) + ":" + strconv.FormatInt(id, 10)
	stockValue, stockKnown := number(row["stock"])
	if stockKnown && (stockValue < 0 || stockValue > math.MaxInt || math.Trunc(stockValue) != stockValue) {
		return campaignContribution{}, "", changed("stock")
	}
	for _, key := range []string{"no_stock", "is_out_of_stock"} {
		if value, exists := row[key]; exists {
			if _, ok := value.(bool); !ok {
				return campaignContribution{}, "", changed(key)
			}
		}
	}
	noStock, _ := row["no_stock"].(bool)
	outOfStock, _ := row["is_out_of_stock"].(bool)
	conditional := conditionalMetadata(row)
	var exclusion string
	switch {
	case subVendorID != nil:
		exclusion = "UNVERIFIED_SUB_VENDOR_OWNERSHIP"
	case !stockKnown:
		exclusion = "UNKNOWN_STOCK"
	case noStock || outOfStock || stockValue <= 0:
		exclusion = "OUT_OF_STOCK"
	case conditional:
		exclusion = "UNVERIFIED_CONDITIONAL_BENEFIT"
	case ratio < float64(threshold):
		exclusion = "BELOW_THRESHOLD"
	}
	observedAt, err := stableObservedAt(observedAt, startedAt)
	if err != nil {
		return campaignContribution{}, "", err
	}
	provenance := fmt.Sprintf("snapp:%s:%d:%d", scope.Source, scope.VendorID, scope.CollectionID)
	if scope.Source == "" {
		provenance = fmt.Sprintf("snapp:store_campaign:%d:%d", scope.VendorID, scope.CollectionID)
	}
	var offer *Deal
	if exclusion == "" {
		var image *string
		if images, ok := row["images"].([]any); ok && len(images) > 0 {
			if main, ok := object(images[0])["main"].(string); ok {
				image = validHTTPURL(main)
			}
		}
		var categoryTitle *string
		if category, ok := row["menu_category_title"].(string); ok {
			categoryTitle = &category
		}
		factsJSON, _ := json.Marshal(map[string]any{
			"benefit":    map[string]any{"kind": "standard_discount", "identity": "ordinary", "applicable": true, "terms": nil},
			"observedAt": observedAt, "provenance": []string{provenance}, "observationPriority": 50,
		})
		offer = &Deal{Key: identity, ProductVariationID: strconv.FormatInt(id, 10), VendorID: strconv.FormatInt(scope.VendorID, 10), Title: title, Image: image, VendorTitle: vendorTitle, VendorCode: stringPointer(scope.VendorCode), CategoryTitle: categoryTitle, PriceRials: int64(price), DiscountRials: int64(discount), FinalPriceRials: max(int64(price-discount), 0), DiscountRatio: ratio, Stock: int(stockValue), Facts: factsJSON}
	}
	var normalizedStock any
	if stockKnown {
		normalizedStock = stockValue
	}
	signatureFields := []any{price, discount, ratio, normalizedStock, row["no_stock"], row["is_out_of_stock"], title, row["is_pro"], row["requires_pro"], row["isPro"], row["conditions"], row["terms"], row["benefit"]}
	if subVendorID != nil {
		signatureFields = append(signatureFields, []any{"UNVERIFIED_SUB_VENDOR_OWNERSHIP", subVendorID, row["document_id"]})
	}
	signatureJSON, err := json.Marshal(signatureFields)
	if err != nil {
		return campaignContribution{}, "", err
	}
	signatureDigest := sha256.Sum256(signatureJSON)
	return campaignContribution{DealKey: identity, Signature: hex.EncodeToString(signatureDigest[:]), Offer: offer}, identity, nil
}

func stringPointer(value string) *string {
	return &value
}

func mergeObservation(prior, incoming Deal) Deal {
	priorFacts := factsMap(prior.Facts)
	incomingFacts := factsMap(incoming.Facts)
	priorTime := observationTime(priorFacts["observedAt"])
	incomingTime := observationTime(incomingFacts["observedAt"])
	chooseIncoming := incomingTime.After(priorTime)
	if incomingTime.Equal(priorTime) {
		priorPriority, _ := number(priorFacts["observationPriority"])
		incomingPriority, _ := number(incomingFacts["observationPriority"])
		chooseIncoming = incomingPriority > priorPriority
		if incomingPriority == priorPriority {
			chooseIncoming = firstProvenance(incomingFacts) < firstProvenance(priorFacts)
		}
	}
	winner := prior
	winnerFacts, loserFacts := priorFacts, incomingFacts
	if chooseIncoming {
		winner = incoming
		winnerFacts, loserFacts = incomingFacts, priorFacts
	}
	provenance := make(map[string]struct{})
	for _, source := range provenanceValues(winnerFacts) {
		provenance[source] = struct{}{}
	}
	for _, source := range provenanceValues(loserFacts) {
		provenance[source] = struct{}{}
	}
	mergedSources := make([]string, 0, len(provenance))
	for source := range provenance {
		mergedSources = append(mergedSources, source)
	}
	sort.Strings(mergedSources)
	winnerFacts["provenance"] = mergedSources
	winner.Facts, _ = json.Marshal(winnerFacts)
	return winner
}

func factsMap(encoded json.RawMessage) map[string]any {
	if len(encoded) == 0 {
		return make(map[string]any)
	}
	value, err := decodeObject(encoded)
	if err != nil {
		return make(map[string]any)
	}
	return value
}

func provenanceValues(facts map[string]any) []string {
	values, _ := facts["provenance"].([]any)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if source, ok := value.(string); ok {
			result = append(result, source)
		}
	}
	return result
}

func firstProvenance(facts map[string]any) string {
	values := provenanceValues(facts)
	if len(values) == 0 {
		return ""
	}
	sort.Strings(values)
	return values[0]
}

func observationTime(value any) time.Time {
	text, _ := value.(string)
	parsed, _ := time.Parse(time.RFC3339Nano, text)
	return parsed
}
