package providers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const digikalaBase = "https://api.digikalajet.ir"

type digikalaPager struct {
	CurrentPage int `json:"current_page"`
	TotalPages  int `json:"total_pages"`
	TotalItems  int `json:"total_items"`
	RowsOnPage  int `json:"rows_on_page"`
}

type digikalaPage struct {
	Status int `json:"status"`
	Data   struct {
		Result        []json.RawMessage `json:"result"`
		Pager         digikalaPager     `json:"pager"`
		AddCartSource string            `json:"add_cart_source"`
	} `json:"data"`
}

type digikalaBootstrap struct {
	Status int `json:"status"`
	Data   struct {
		ShopID      string `json:"shop_id"`
		Coordinates string `json:"coordinates_hash"`
		Shipment    struct {
			Default   string `json:"default"`
			Scheduled bool   `json:"is_scheduled_enabled"`
			OnDemand  bool   `json:"is_on_demand_enabled"`
		} `json:"shipment_type"`
	} `json:"data"`
}

var digikalaCarouselLink = regexp.MustCompile(`(?i)^/fresh/dynamic-carousel/([a-z0-9_-]+)/?$`)
var digikalaPostProcessLink = regexp.MustCompile(`(?i)^/post-process/([a-z0-9_-]+)/([a-z0-9_-]+)/?$`)
var digikalaDynamicPageLink = regexp.MustCompile(`(?i)^/v1/dynamic-pages/([a-z0-9_-]+)/?$`)

type digikalaDiscoveryNode struct {
	Kind string
	Type string
	ID   string
}

type digikalaCandidate struct {
	Deal            Deal
	AddCartSource   string
	CategoryAllowed bool
}

func (c *Collector) collectDigikalaFresh(ctx context.Context, job *scanJob) (scanResult, error) {
	if !job.ManifestFrozen {
		bootstrap, err := c.digikalaFetch(ctx, job, "/first-load/", url.Values{"ch": {"sd"}}, "bootstrap")
		if err != nil {
			return scanResult{}, err
		}
		var first digikalaBootstrap
		if err := json.Unmarshal(bootstrap, &first); err != nil || first.Status != 200 || first.Data.ShopID == "" || first.Data.Coordinates == "" {
			return scanResult{}, &Failure{Code: "DIGIKALA_CONTEXT_UNAVAILABLE", Message: "Fresh has no verified delivery context for this location.", Status: 422}
		}
		shipment := first.Data.Shipment.Default
		if shipment == "" {
			shipment = "scheduled"
		}
		if shipment != "scheduled" || !first.Data.Shipment.Scheduled {
			return scanResult{}, &Failure{Code: "DIGIKALA_SHIPMENT_UNAVAILABLE", Message: "Fresh scheduled delivery is unavailable for this location.", Status: 422}
		}
		home, err := c.digikalaFetch(ctx, job, "/fresh/v3/main-page/", url.Values{"ch": {"sd"}}, "homepage")
		if err != nil {
			return scanResult{}, err
		}
		feeds, err := c.discoverDigikalaGraph(ctx, job, home)
		if err != nil || len(feeds) == 0 {
			return scanResult{}, &Failure{Code: "DIGIKALA_DISCOVERY_INCOMPLETE", Message: "Fresh did not expose a verifiable campaign feed set.", Status: 502}
		}
		manifest := Manifest{Adapter: "digikala-fresh-supermarket", ContractVersion: 1, FeedKinds: []string{"fresh_campaign_carousels"}, DigikalaFeeds: feeds, Digikala: &DigikalaContext{Surface: "fresh_supermarket", Channel: "sd", ShipmentType: shipment, ShopID: first.Data.ShopID, CoordinatesHash: first.Data.Coordinates, CategoryPolicy: "grocery-consumables-v1"}}
		job.Context.Manifest = manifest
		job.Context.PolicyVersion = "grocery-consumables-v1"
		job.Context.Coverage = "pending"
		identity, _ := json.Marshal([]any{job.Input.Source, job.Context.Location, manifest, job.Threshold, "grocery-consumables-v1", 1, 1})
		digest := sha256.Sum256(identity)
		job.Context.ScopeHash = hex.EncodeToString(digest[:])
		encoded, _ := json.Marshal(job.Context)
		if err := job.journal.freezeDigikalaManifest(ctx, string(encoded)); err != nil {
			return scanResult{}, err
		}
		job.ManifestFrozen = true
	}
	if job.Context.Manifest.Adapter != "digikala-fresh-supermarket" || job.Context.Manifest.ContractVersion != 1 || len(job.Context.Manifest.DigikalaFeeds) == 0 || job.Context.Manifest.Digikala == nil || job.Context.Manifest.Digikala.Surface != "fresh_supermarket" || job.Context.Manifest.Digikala.Channel != "sd" || job.Context.Manifest.Digikala.ShipmentType != "scheduled" || job.Context.Manifest.Digikala.ShopID == "" || job.Context.Manifest.Digikala.CoordinatesHash == "" || job.Context.Manifest.Digikala.CategoryPolicy != "grocery-consumables-v1" {
		return scanResult{}, &Failure{Code: "SCAN_CONTRACT_UNSUPPORTED", Message: "The saved Fresh scan context is unsupported.", Status: 409}
	}
	deals := map[string]Deal{}
	observed := map[string]struct{}{}
	vendors := map[string]struct{}{}
	categoryCache := map[string]bool{}
	detailRequests := 0
	pageRequests := 0
	for _, feed := range job.Context.Manifest.DigikalaFeeds {
		if !validOpaqueCampaignID(feed.ID) || feed.Kind != "carousel" {
			return scanResult{}, &Failure{Code: "DIGIKALA_FEED_INVALID", Message: "Fresh campaign descriptor is invalid.", Status: 409}
		}
		seenPages := map[string]struct{}{}
		seenOffers := map[string]struct{}{}
		var totalPages, totalItems int
		movement := 0
		for page := 1; ; page++ {
			pageRequests++
			if page > 100 || pageRequests > 200 {
				return scanResult{}, &Failure{Code: "DIGIKALA_PAGE_BUDGET", Message: "Fresh campaign page budget was exhausted.", Status: 502}
			}
			query := url.Values{"ch": {"sd"}, "page": {strconv.Itoa(page)}, "sort": {"20"}}
			body, err := c.digikalaFetch(ctx, job, "/fresh/dynamic-carousel/"+url.PathEscape(feed.ID)+"/", query, "campaign:"+feed.ID+":"+strconv.Itoa(page))
			if err != nil {
				return scanResult{}, err
			}
			var result digikalaPage
			if err := json.Unmarshal(body, &result); err != nil || result.Status != 200 {
				return scanResult{}, &Failure{Code: "DIGIKALA_BAD_PAGE", Message: "Fresh returned an invalid campaign page.", Status: 502}
			}
			pager := result.Data.Pager
			if err := validateDigikalaPage(page, pager, len(result.Data.Result)); err != nil {
				return scanResult{}, &Failure{Code: "DIGIKALA_BAD_PAGINATION", Message: "Fresh campaign pagination metadata is inconsistent.", Status: 502}
			}
			if totalPages == 0 {
				totalPages, totalItems = pager.TotalPages, pager.TotalItems
			} else {
				movement, err = digikalaTotalMovement(totalItems, pager.TotalItems, movement, pager.RowsOnPage)
				if err != nil {
					return scanResult{}, err
				}
				totalPages, totalItems = pager.TotalPages, pager.TotalItems
			}
			fingerprint := pageFingerprint(result.Data.Result)
			if _, ok := seenPages[fingerprint]; ok {
				return scanResult{}, &Failure{Code: "DIGIKALA_REPEATED_PAGE", Message: "Fresh repeated a campaign page.", Status: 502}
			}
			seenPages[fingerprint] = struct{}{}
			unitID := "digikala:" + feed.Kind + ":" + feed.ID
			contrib := []campaignContribution{}
			candidates := []digikalaCandidate{}
			for _, raw := range result.Data.Result {
				identity, identityErr := digikalaOfferIdentity(raw)
				if identityErr != nil {
					return scanResult{}, identityErr
				}
				if identity != "" {
					if _, duplicate := seenOffers[identity]; duplicate {
						continue
					}
					seenOffers[identity] = struct{}{}
				}
				categoryID := digikalaCategoryID(raw)
				categoryAllowed, err := c.digikalaCategoryAllowed(ctx, job, categoryID, categoryCache)
				if err != nil {
					return scanResult{}, err
				}
				deal, eligible, err := normalizeDigikalaOffer(raw, feed.ID, result.Data.AddCartSource, time.Now().UTC(), categoryAllowed)
				if err != nil {
					return scanResult{}, err
				}
				if deal.Key == "" {
					continue
				}
				vendors[deal.VendorID] = struct{}{}
				observed[deal.Key] = struct{}{}
				if !eligible {
					continue
				}
				if deal.DiscountRatio < float64(job.Threshold) {
					continue
				}
				detailRequests++
				if detailRequests > 750 {
					return scanResult{}, &Failure{Code: "DIGIKALA_DETAIL_BUDGET", Message: "Fresh price revalidation budget was exhausted before coverage completed.", Status: 502}
				}
				candidates = append(candidates, digikalaCandidate{Deal: deal, AddCartSource: result.Data.AddCartSource, CategoryAllowed: categoryAllowed})
			}
			verified, verifyErr := parallelDigikala(ctx, candidates, 4, func(ctx context.Context, candidate digikalaCandidate) (Deal, error) {
				return c.digikalaDetail(ctx, job, candidate.Deal, candidate.AddCartSource, candidate.CategoryAllowed)
			})
			if verifyErr != nil {
				return scanResult{}, verifyErr
			}
			for index, detail := range verified {
				deal := candidates[index].Deal
				if detail.FinalPriceRials <= 0 || detail.DiscountRatio < float64(job.Threshold) || detail.Availability != "available" {
					continue
				}
				deals[deal.Key] = detail
				encoded, _ := json.Marshal([]any{detail.Key, detail.PriceRials, detail.DiscountRials, detail.FinalPriceRials, detail.Availability, detail.DiscountRatio})
				sig := sha256.Sum256(encoded)
				contrib = append(contrib, campaignContribution{DealKey: deal.Key, Signature: hex.EncodeToString(sig[:]), Offer: &detail})
			}
			meta, _ := json.Marshal(map[string]any{"contractVersion": 1, "reportedTotalPages": totalPages, "reportedTotalItems": totalItems, "rows": len(result.Data.Result), "fingerprint": fingerprint, "feed": feed.ID, "contextHash": job.Context.ScopeHash})
			desc, _ := json.Marshal(feed)
			if err := job.RecordPage(ctx, pageCheckpoint{UnitID: unitID, Descriptor: string(desc), Page: page, ResponseBody: body, Metadata: string(meta), Terminal: page == totalPages, TerminalNote: fmt.Sprintf("pages=%d items=%d", totalPages, totalItems), Contributions: contrib}); err != nil {
				return scanResult{}, err
			}
			if page == totalPages {
				break
			}
		}
		if len(seenOffers) < totalItems-movement || len(seenOffers) > totalItems+movement {
			return scanResult{}, &Failure{Code: "DIGIKALA_TOTAL_MISMATCH", Message: "Fresh campaign unique offer count did not match its reported total.", Status: 502}
		}
	}
	job.Context.Coverage = "complete"
	if err := job.Progress(ctx, len(vendors), len(observed)); err != nil {
		return scanResult{}, err
	}
	result := scanResult{VendorCount: len(vendors), ProductCount: len(observed), Coverage: "complete"}
	for _, deal := range deals {
		result.Deals = append(result.Deals, deal)
	}
	return result, nil
}

func (c *Collector) digikalaFetch(ctx context.Context, job *scanJob, path string, query url.Values, key string) ([]byte, error) {
	if saved, ok, err := job.LoadDiscovery(ctx, "digikala-fresh:"+key); err != nil {
		return nil, err
	} else if ok {
		return saved.Body, nil
	}
	query.Set("latitude", strconv.FormatFloat(job.Location.Latitude, 'f', -1, 64))
	query.Set("longitude", strconv.FormatFloat(job.Location.Longitude, 'f', -1, 64))
	query.Set("ch", "sd")
	endpoint := digikalaBase + path + "?" + query.Encode()
	header := http.Header{"Accept": {"application/json"}, "Channel": {"fresh"}, "Shipment-Type": {"scheduled"}, "Origin": {"https://www.digikala.com"}, "Referer": {"https://www.digikala.com/supermarket/"}}
	response, err := c.requestWithRedirectHost(ctx, http.MethodGet, endpoint, header, nil, "digikala-fresh", 2, false, job.ReserveRequest, "api.digikalajet.ir")
	if err != nil {
		return nil, err
	}
	if !json.Valid(response.body) {
		return nil, &Failure{Code: "DIGIKALA_BAD_RESPONSE", Message: "Fresh returned invalid JSON.", Status: 502}
	}
	var status struct {
		Status int `json:"status"`
		Data   struct {
			URL          string `json:"url"`
			RedirectURL  string `json:"redirect_url"`
			CanonicalURL string `json:"canonical_url"`
		} `json:"data"`
	}
	if json.Unmarshal(response.body, &status) != nil {
		return nil, &Failure{Code: "DIGIKALA_UPSTREAM_STATUS", Message: "Fresh rejected the scan request context.", Status: 502}
	}
	if status.Status >= 300 && status.Status < 400 {
		redirect := firstNonempty(status.Data.URL, status.Data.RedirectURL, status.Data.CanonicalURL)
		if redirect == "" || strings.Contains(key, "redirect:") {
			return nil, &Failure{Code: "DIGIKALA_REDIRECT_REJECTED", Message: "Fresh returned an unsupported campaign redirect.", Status: 502}
		}
		path, redirectQuery, ok := validatedDigikalaRedirect(redirect)
		if !ok {
			return nil, &Failure{Code: "DIGIKALA_REDIRECT_REJECTED", Message: "Fresh returned an off-surface or unsupported campaign redirect.", Status: 502}
		}
		for name, values := range redirectQuery {
			query[name] = values
		}
		return c.digikalaFetch(ctx, job, path, query, "redirect:"+key)
	}
	if status.Status != 200 {
		return nil, &Failure{Code: "DIGIKALA_UPSTREAM_STATUS", Message: "Fresh rejected the scan request context.", Status: 502}
	}
	saved, err := job.SaveDiscovery(ctx, "digikala-fresh:"+key, response.body)
	if err != nil {
		return nil, err
	}
	return saved.Body, nil
}

func validatedDigikalaRedirect(raw string) (string, url.Values, bool) {
	path, allowed := digikalaInternalPath(raw)
	if !allowed {
		return "", nil, false
	}
	if len(digikalaCarouselLink.FindStringSubmatch(path)) != 2 && len(digikalaPostProcessLink.FindStringSubmatch(path)) != 3 && len(digikalaDynamicPageLink.FindStringSubmatch(path)) != 2 {
		return "", nil, false
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", nil, false
	}
	values := url.Values{}
	allow := map[string]bool{"page": true, "sort": true, "sourcePage": true, "irsi": true, "ch": true}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return "", nil, false
	}
	for key, list := range query {
		if !allow[key] {
			return "", nil, false
		}
		values[key] = append([]string(nil), list...)
	}
	return path, values, true
}

func parallelDigikala[T, R any](ctx context.Context, items []T, concurrency int, work func(context.Context, T) (R, error)) ([]R, error) {
	if len(items) == 0 {
		return []R{}, nil
	}
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > len(items) {
		concurrency = len(items)
	}
	workCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make([]R, len(items))
	jobs := make(chan int)
	var workers sync.WaitGroup
	var once sync.Once
	var firstErr error
	for range concurrency {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-workCtx.Done():
					return
				case index, ok := <-jobs:
					if !ok {
						return
					}
					value, err := work(workCtx, items[index])
					if err != nil {
						once.Do(func() { firstErr = err; cancel() })
						return
					}
					results[index] = value
				}
			}
		}()
	}
send:
	for index := range items {
		select {
		case <-workCtx.Done():
			break send
		case jobs <- index:
		}
	}
	close(jobs)
	workers.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

func discoverDigikalaFeeds(home []byte) ([]DigikalaFeed, error) {
	var root any
	if json.Unmarshal(home, &root) != nil {
		return nil, fmt.Errorf("invalid Fresh homepage")
	}
	set := map[string]DigikalaFeed{}
	var walk func(any)
	walk = func(value any) {
		switch node := value.(type) {
		case map[string]any:
			if typ, ok := node["component_type"].(string); ok {
				id := ""
				switch typ {
				case "fresh-static-amazing-carousel":
					id = "static_amazing"
				case "fresh-shop-heavy-discount-carousel":
					id = "heavy_discount"
				}
				if data, ok := node["data"].(map[string]any); ok {
					if id == "" && strings.Contains(strings.ToLower(typ), "carousel") {
						for _, field := range []string{"carousel_id", "carouselId", "campaign_id", "campaignId"} {
							if raw, exists := data[field]; exists {
								if value, ok := scalarString(raw); ok && validOpaqueCampaignID(value) {
									id = value
									break
								}
							}
						}
					}
				}
				if id != "" {
					set[id] = DigikalaFeed{ID: id, Kind: "carousel"}
				}
			}
			for key, child := range node {
				if key == "url" || key == "link" {
					if link, ok := child.(string); ok {
						path, allowed := digikalaInternalPath(link)
						if !allowed {
							walk(child)
							continue
						}
						if match := digikalaCarouselLink.FindStringSubmatch(path); len(match) == 2 {
							set[match[1]] = DigikalaFeed{ID: match[1], Kind: "carousel"}
						}
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range node {
				walk(child)
			}
		}
	}
	walk(root)
	feeds := make([]DigikalaFeed, 0, len(set))
	for _, feed := range set {
		feeds = append(feeds, feed)
	}
	sort.Slice(feeds, func(i, j int) bool { return feeds[i].ID < feeds[j].ID })
	return feeds, nil
}

func digikalaInternalPath(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", false
	}
	if parsed.Host != "" && (parsed.Scheme != "https" || (parsed.Host != "www.digikala.com" && parsed.Host != "api.digikalajet.ir")) {
		return "", false
	}
	if parsed.Scheme != "" && parsed.Scheme != "https" {
		return "", false
	}
	if parsed.User != nil || parsed.Fragment != "" {
		return "", false
	}
	return parsed.Path, true
}

func (c *Collector) discoverDigikalaGraph(ctx context.Context, job *scanJob, home []byte) ([]DigikalaFeed, error) {
	feeds, err := discoverDigikalaFeeds(home)
	if err != nil {
		return nil, err
	}
	feedSet := map[string]DigikalaFeed{}
	for _, feed := range feeds {
		feedSet[feed.ID] = feed
	}
	queue := digikalaDiscoveryNodes(home)
	seen := map[string]bool{}
	requests := 0
	for depth := 0; depth < 3 && len(queue) > 0; depth++ {
		next := []digikalaDiscoveryNode{}
		for _, node := range queue {
			key := node.Kind + ":" + node.Type + ":" + node.ID
			if seen[key] {
				continue
			}
			seen[key] = true
			if requests >= 30 {
				return nil, fmt.Errorf("Fresh discovery request budget reached")
			}
			requests++
			path := ""
			switch node.Kind {
			case "post_process":
				path = "/post-process/" + url.PathEscape(node.Type) + "/" + url.PathEscape(node.ID) + "/"
			case "dynamic_page":
				path = "/v1/dynamic-pages/" + url.PathEscape(node.ID) + "/"
			default:
				continue
			}
			body, fetchErr := c.digikalaFetch(ctx, job, path, url.Values{"ch": {"sd"}}, "discovery:"+key)
			if fetchErr != nil {
				return nil, fetchErr
			}
			childFeeds, _ := discoverDigikalaFeeds(body)
			for _, feed := range childFeeds {
				feedSet[feed.ID] = feed
			}
			next = append(next, digikalaDiscoveryNodes(body)...)
		}
		queue = next
	}
	out := make([]DigikalaFeed, 0, len(feedSet))
	for _, feed := range feedSet {
		out = append(out, feed)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func digikalaDiscoveryNodes(body []byte) []digikalaDiscoveryNode {
	var root any
	if json.Unmarshal(body, &root) != nil {
		return nil
	}
	set := map[string]digikalaDiscoveryNode{}
	add := func(node digikalaDiscoveryNode) {
		if validOpaqueCampaignID(node.ID) && (node.Kind == "dynamic_page" || (node.Kind == "post_process" && validOpaqueCampaignID(node.Type))) {
			set[node.Kind+":"+node.Type+":"+node.ID] = node
		}
	}
	var walk func(any)
	walk = func(value any) {
		switch node := value.(type) {
		case map[string]any:
			if typ, ok := node["component_type"].(string); ok {
				if mode, _ := node["process_mode"].(string); strings.EqualFold(mode, "deferred") {
					if data, ok := node["data"].(map[string]any); ok {
						for _, field := range []string{"component_id", "componentId", "id"} {
							if raw, exists := data[field]; exists {
								if id, ok := scalarString(raw); ok {
									add(digikalaDiscoveryNode{Kind: "post_process", Type: typ, ID: id})
									break
								}
							}
						}
					}
				}
			}
			for field, child := range node {
				if field == "url" || field == "endpoint" || field == "api" || field == "api_url" || field == "request_url" {
					if raw, ok := child.(string); ok {
						if path, allowed := digikalaInternalPath(raw); allowed {
							if m := digikalaPostProcessLink.FindStringSubmatch(path); len(m) == 3 {
								add(digikalaDiscoveryNode{Kind: "post_process", Type: m[1], ID: m[2]})
							}
							if m := digikalaDynamicPageLink.FindStringSubmatch(path); len(m) == 2 {
								add(digikalaDiscoveryNode{Kind: "dynamic_page", ID: m[1]})
							}
						}
					}
				}
				walk(child)
			}
		case []any:
			for _, child := range node {
				walk(child)
			}
		}
	}
	walk(root)
	out := make([]digikalaDiscoveryNode, 0, len(set))
	for _, node := range set {
		out = append(out, node)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind+out[i].Type+out[i].ID < out[j].Kind+out[j].Type+out[j].ID })
	return out
}

func validOpaqueCampaignID(value string) bool {
	return len(value) > 0 && len(value) <= 100 && regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(value)
}

func pageFingerprint(rows []json.RawMessage) string {
	h := sha256.New()
	for _, row := range rows {
		h.Write(row)
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

func validateDigikalaPage(page int, pager digikalaPager, actualRows int) error {
	if page < 1 || pager.CurrentPage != page || pager.TotalPages < 1 || pager.TotalPages > 100 || page > pager.TotalPages || pager.TotalItems < 0 || pager.RowsOnPage < 0 || actualRows < 0 || actualRows > pager.RowsOnPage || (actualRows > 0 && pager.RowsOnPage == 0) {
		return fmt.Errorf("invalid Fresh page metadata")
	}
	return nil
}

// Fresh is a live catalog, not a snapshot. Bound cumulative churn to one page;
// larger movement still fails closed, as do missing pages and repeated bodies.
func digikalaTotalMovement(previous, current, movement, pageSize int) (int, error) {
	delta := current - previous
	if delta < 0 {
		delta = -delta
	}
	movement += delta
	if movement > pageSize {
		return movement, &Failure{Code: "DIGIKALA_PAGINATION_DRIFT", Message: "Fresh catalog changed too much during the scan; retry it.", Status: 502}
	}
	return movement, nil
}

func normalizeDigikalaOffer(raw json.RawMessage, feedID, addCartSource string, observed time.Time, categoryAllowed bool) (Deal, bool, error) {
	var row struct {
		ID    json.RawMessage `json:"id"`
		Title string          `json:"title"`
		Media string          `json:"media"`
		Shop  struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Activity string `json:"activity_type"`
			Status   string `json:"status"`
			InRange  bool   `json:"is_in_range"`
			Open     struct {
				IsOpen bool `json:"is_open"`
			} `json:"working_status"`
		} `json:"shop"`
		Category struct {
			ID    json.RawMessage `json:"id"`
			Title string          `json:"title"`
		} `json:"category"`
		Price struct {
			Price    int64   `json:"price"`
			Discount int64   `json:"discount"`
			Percent  float64 `json:"discount_percentage"`
		} `json:"price"`
		Stock struct {
			Has bool `json:"has_stock"`
		} `json:"stock"`
		Badges  map[string]bool `json:"badges"`
		AddCart string          `json:"add_cart_source"`
		Expiry  *string         `json:"end_time"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return Deal{}, false, &Failure{Code: "DIGIKALA_BAD_PRODUCT", Message: "Fresh returned an invalid product.", Status: 502}
	}
	id := strings.Trim(string(row.ID), `"`)
	catID := strings.Trim(string(row.Category.ID), `"`)
	if id == "" || row.Shop.ID == "" || row.Title == "" || row.Price.Price <= 0 || row.Price.Discount < 0 || row.Price.Discount >= row.Price.Price {
		return Deal{}, false, nil
	}
	// The numeric IDs are a versioned, research-backed consumable allowlist.
	// Unknown, broad, and unresolved supermarket categories remain excluded.
	categoryEligible := categoryAllowed
	if row.Badges["is_bundled"] || row.Badges["is_kalabarg"] || row.Badges["is_yasna"] {
		categoryEligible = false
	}
	if row.Shop.Status != "active" || !row.Shop.InRange || !row.Shop.Open.IsOpen || (row.Shop.Activity != "supermarket" && row.Shop.Activity != "all_mart") {
		return Deal{}, false, nil
	}
	if row.Expiry != nil {
		if expiry, err := time.Parse(time.RFC3339, *row.Expiry); err == nil && !expiry.After(observed) {
			return Deal{}, false, nil
		}
	}
	category := row.Category.Title
	image := firstValidURLPointer(&row.Media)
	availability := "unavailable"
	stock := 0
	if row.Stock.Has {
		availability = "available"
	}
	ctx := map[string]any{"surface": "fresh_supermarket", "campaignId": feedID, "addCartSource": row.AddCart, "categoryId": catID, "availability": availability, "merchantActivity": row.Shop.Activity, "inRange": row.Shop.InRange, "working": row.Shop.Open.IsOpen, "observedAt": observed.Format(time.RFC3339Nano)}
	factsJSON, _ := json.Marshal(ctx)
	key := strings.Join([]string{"digikalajet", "fresh", row.Shop.ID, id, feedID}, ":")
	deal := Deal{Key: key, ProductVariationID: id, VendorID: row.Shop.ID, Title: row.Title, Image: image, VendorTitle: row.Shop.Title, CategoryTitle: stringPointer(category), PriceRials: row.Price.Price, DiscountRials: row.Price.Discount, FinalPriceRials: row.Price.Price - row.Price.Discount, DiscountRatio: float64(row.Price.Discount) / float64(row.Price.Price) * 100, Stock: stock, Availability: availability, Facts: factsJSON}
	if !row.Stock.Has {
		deal.Stock = 0
	}
	return deal, categoryEligible, nil
}

func digikalaOfferIdentity(raw json.RawMessage) (string, error) {
	var row struct {
		ID   json.RawMessage `json:"id"`
		Shop struct {
			ID string `json:"id"`
		} `json:"shop"`
	}
	if err := json.Unmarshal(raw, &row); err != nil {
		return "", &Failure{Code: "DIGIKALA_BAD_PRODUCT", Message: "Fresh returned an invalid product identity.", Status: 502}
	}
	id := strings.Trim(string(row.ID), `"`)
	if id == "" || row.Shop.ID == "" {
		return "", nil
	}
	return row.Shop.ID + ":" + id, nil
}

func digikalaCategoryID(raw json.RawMessage) string {
	var row struct {
		Category struct {
			ID json.RawMessage `json:"id"`
		} `json:"category"`
	}
	_ = json.Unmarshal(raw, &row)
	return strings.Trim(string(row.Category.ID), `"`)
}

func (c *Collector) digikalaCategoryAllowed(ctx context.Context, job *scanJob, categoryID string, cache map[string]bool) (bool, error) {
	if allowed, ok := cache[categoryID]; ok {
		return allowed, nil
	}
	if categoryID == "" {
		cache[categoryID] = false
		return false, nil
	}
	body, err := c.digikalaFetch(ctx, job, "/v2/category/"+url.PathEscape(categoryID)+"/", url.Values{"ch": {"sd"}}, "category:"+categoryID)
	if err != nil {
		return false, err
	}
	var payload struct {
		Status int `json:"status"`
		Data   struct {
			Root struct {
				ID json.RawMessage `json:"id"`
			} `json:"root_category"`
			Category struct {
				ID json.RawMessage `json:"id"`
			} `json:"category"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &payload) != nil || payload.Status != 200 {
		return false, &Failure{Code: "DIGIKALA_CATEGORY_UNRESOLVED", Message: "Fresh category ancestry could not be validated.", Status: 502}
	}
	root := strings.Trim(string(payload.Data.Root.ID), `"`)
	leaf := strings.Trim(string(payload.Data.Category.ID), `"`)
	allowed := digikalaCategoryPolicy(root, leaf)
	cache[categoryID] = allowed
	return allowed, nil
}

func digikalaCategoryPolicy(root, leaf string) bool {
	switch root {
	case "4", "5", "7", "8", "9", "10", "11", "12", "14":
		return true
	case "3126":
		return leaf == "3128" || leaf == "3129"
	case "144":
		return leaf == "145" || leaf == "146" || leaf == "22"
	}
	switch leaf {
	case "18", "3106", "3109", "3111", "3137":
		return true
	}
	return false
}

func (c *Collector) digikalaDetail(ctx context.Context, job *scanJob, listing Deal, addCartSource string, categoryAllowed bool) (Deal, error) {
	query := url.Values{"ch": {"sd"}, "addCartSource": {addCartSource}, "viewSource": {"shop_product"}}
	body, err := c.digikalaFetch(ctx, job, "/shop/"+url.PathEscape(listing.VendorID)+"/product/"+url.PathEscape(listing.ProductVariationID)+"/", query, "detail:"+listing.VendorID+":"+listing.ProductVariationID+":"+addCartSource)
	if err != nil {
		return Deal{}, err
	}
	var response struct {
		Status int `json:"status"`
		Data   struct {
			Product json.RawMessage `json:"product"`
		} `json:"data"`
	}
	if json.Unmarshal(body, &response) != nil || response.Status != 200 {
		return Deal{}, &Failure{Code: "DIGIKALA_BAD_DETAIL", Message: "Fresh product detail could not be validated.", Status: 502}
	}
	detail, eligible, err := normalizeDigikalaOffer(response.Data.Product, "detail", addCartSource, time.Now().UTC(), categoryAllowed)
	if err != nil {
		return Deal{}, err
	}
	if !eligible || detail.VendorID != listing.VendorID || detail.ProductVariationID != listing.ProductVariationID {
		return Deal{}, nil
	}
	detail.Key = listing.Key
	if facts, err := digikalaDetailFacts(detail.Facts, listing, addCartSource); err == nil {
		detail.Facts = facts
	}
	return detail, nil
}

func digikalaDetailFacts(existing json.RawMessage, listing Deal, addCartSource string) (json.RawMessage, error) {
	var facts map[string]any
	if json.Unmarshal(existing, &facts) != nil {
		facts = map[string]any{}
	}
	facts["campaignId"] = strings.TrimPrefix(listing.Key, "digikalajet:fresh:")
	facts["addCartSource"] = addCartSource
	return json.Marshal(facts)
}
