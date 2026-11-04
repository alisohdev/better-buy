package products

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"golang.org/x/text/unicode/norm"
)

type Benefit struct {
	Kind       string  `json:"kind"`
	Identity   string  `json:"identity"`
	Applicable *bool   `json:"applicable"`
	Terms      *string `json:"terms"`
}

type DealRecord struct {
	Key                 string   `json:"key"`
	ScanID              string   `json:"scanId"`
	ProductVariationID  string   `json:"productVariationId"`
	VendorID            string   `json:"vendorId"`
	Title               string   `json:"title"`
	Image               *string  `json:"image"`
	VendorTitle         string   `json:"vendorTitle"`
	VendorCode          *string  `json:"vendorCode"`
	VendorLogoURL       *string  `json:"vendorLogoUrl,omitempty"`
	CategoryTitle       *string  `json:"categoryTitle"`
	PriceRials          float64  `json:"priceRials"`
	DiscountRials       float64  `json:"discountRials"`
	FinalPriceRials     float64  `json:"finalPriceRials"`
	DiscountRatio       float64  `json:"discountRatio"`
	Stock               float64  `json:"stock"`
	State               string   `json:"state"`
	Benefit             *Benefit `json:"benefit,omitempty"`
	ObservedAt          string   `json:"observedAt,omitempty"`
	Provenance          []string `json:"provenance,omitempty"`
	ObservationPriority int      `json:"observationPriority,omitempty"`
}

type VendorOffer struct {
	LogoURL             *string  `json:"logoUrl"`
	OfferKey            string   `json:"offerKey"`
	ProductVariationID  string   `json:"productVariationId"`
	VendorID            string   `json:"vendorId"`
	VendorTitle         string   `json:"vendorTitle"`
	VendorCode          *string  `json:"vendorCode"`
	PriceRials          float64  `json:"priceRials"`
	DiscountRials       float64  `json:"discountRials"`
	FinalPriceRials     float64  `json:"finalPriceRials"`
	DiscountRatio       float64  `json:"discountRatio"`
	Stock               float64  `json:"stock"`
	State               string   `json:"state"`
	Benefit             Benefit  `json:"benefit"`
	ObservedAt          string   `json:"observedAt,omitempty"`
	Provenance          []string `json:"provenance"`
	SourceMoneyUnit     string   `json:"sourceMoneyUnit"`
	OriginalAmountToman float64  `json:"originalAmountToman"`
	DiscountAmountToman float64  `json:"discountAmountToman"`
	FinalAmountToman    float64  `json:"finalAmountToman"`
}

type Group struct {
	Key                    string        `json:"key"`
	GroupKeyVersion        int           `json:"groupKeyVersion"`
	ScanID                 string        `json:"scanId"`
	Title                  string        `json:"title"`
	Image                  *string       `json:"image"`
	CategoryTitle          *string       `json:"categoryTitle"`
	PriceRials             float64       `json:"priceRials"`
	DiscountRials          float64       `json:"discountRials"`
	FinalPriceRials        float64       `json:"finalPriceRials"`
	DiscountRatio          float64       `json:"discountRatio"`
	State                  string        `json:"state"`
	Vendors                []VendorOffer `json:"vendors"`
	AllOffers              []VendorOffer `json:"-"`
	BestCurrentOffer       *VendorOffer  `json:"bestCurrentOffer"`
	CurrentStoreOfferCount int           `json:"currentStoreOfferCount"`
	ConditionalOffers      []VendorOffer `json:"conditionalOffers"`
	Diagnostics            []string      `json:"diagnostics"`
}

type ProductSummary struct {
	Key                    string       `json:"key"`
	GroupKeyVersion        int          `json:"groupKeyVersion"`
	ScanID                 string       `json:"scanId"`
	Title                  string       `json:"title"`
	Image                  *string      `json:"image"`
	CategoryTitle          *string      `json:"categoryTitle"`
	PriceRials             float64      `json:"priceRials"`
	DiscountRials          float64      `json:"discountRials"`
	FinalPriceRials        float64      `json:"finalPriceRials"`
	DiscountRatio          float64      `json:"discountRatio"`
	State                  string       `json:"state"`
	BestCurrentOffer       *VendorOffer `json:"bestCurrentOffer"`
	CurrentStoreOfferCount int          `json:"currentStoreOfferCount"`
	Diagnostics            []string     `json:"diagnostics"`
	ConditionalOfferCount  int          `json:"conditionalOfferCount"`
	CartQuantity           int          `json:"cartQuantity"`
	WishlistMatch          bool         `json:"wishlistMatch"`
}

type ProductPage struct {
	Items           []ProductSummary `json:"items"`
	NextCursor      *string          `json:"nextCursor"`
	ObservedAt      string           `json:"observedAt"`
	CoverageSummary string           `json:"coverageSummary"`
	Baseline        struct {
		ScanID *string `json:"scanId"`
		Reason string  `json:"reason"`
	} `json:"baseline"`
}

type OfferPage struct {
	Items      []VendorOffer `json:"items"`
	NextCursor *string       `json:"nextCursor"`
}

type cursor struct {
	Version     int    `json:"v"`
	User        string `json:"user"`
	Scan        string `json:"scan"`
	Kind        string `json:"kind"`
	Query       string `json:"q"`
	Sort        string `json:"sort"`
	MinDiscount int    `json:"minDiscount"`
	Group       string `json:"group,omitempty"`
	Position    []any  `json:"position"`
}

type Service struct {
	db     *sql.DB
	boxKey string
}

func New(db *sql.DB, boxKey string) *Service { return &Service{db: db, boxKey: boxKey} }

func (s *Service) Deals(ctx context.Context, queue *scans.Queue, userID, scanID string) ([]DealRecord, *scans.Record, error) {
	current, err := queue.Get(ctx, userID, scanID)
	if err != nil {
		return nil, nil, err
	}
	if current.Status != "succeeded" {
		return nil, &current, &scans.Error{Code: "SCAN_NOT_PUBLISHED", Message: "Scan results are not available yet.", Status: 409}
	}
	currentDeals, err := s.readDeals(ctx, scanID, scanID)
	if err != nil {
		return nil, &current, err
	}
	baselineID, _, comparable := s.baseline(ctx, userID, current)
	if !comparable || baselineID == nil {
		for i := range currentDeals {
			currentDeals[i].State = "current"
		}
		return currentDeals, &current, nil
	}
	previousDeals, err := s.readDeals(ctx, *baselineID, scanID)
	if err != nil {
		return nil, &current, err
	}
	prev := make(map[string]struct{}, len(previousDeals))
	currentKeys := make(map[string]struct{}, len(currentDeals))
	for _, deal := range previousDeals {
		prev[deal.Key] = struct{}{}
	}
	for i := range currentDeals {
		currentKeys[currentDeals[i].Key] = struct{}{}
		if _, exists := prev[currentDeals[i].Key]; exists {
			currentDeals[i].State = "still_available"
		} else {
			currentDeals[i].State = "new"
		}
	}
	for _, deal := range previousDeals {
		if _, exists := currentKeys[deal.Key]; exists {
			continue
		}
		deal.State = "no_longer_present"
		deal.ScanID = scanID
		currentDeals = append(currentDeals, deal)
	}
	return currentDeals, &current, nil
}

func (s *Service) ProductPage(ctx context.Context, queue *scans.Queue, userID, scanID string, query url.Values) (ProductPage, error) {
	minDiscount, err := minimumDiscount(query)
	if err != nil {
		return ProductPage{}, err
	}
	deals, scan, err := s.Deals(ctx, queue, userID, scanID)
	if err != nil {
		return ProductPage{}, err
	}
	q := normalizeProductText(query.Get("q"))
	if len([]rune(query.Get("q"))) > 200 {
		return ProductPage{}, &scans.Error{Code: "INVALID_INPUT", Message: "Invalid product query.", Status: 400}
	}
	sortBy := query.Get("sort")
	if sortBy == "" {
		sortBy = "discount"
	}
	if sortBy != "discount" && sortBy != "wishlist" && sortBy != "price" && sortBy != "price_asc" && sortBy != "price_desc" && sortBy != "title" {
		return ProductPage{}, &scans.Error{Code: "INVALID_INPUT", Message: "Invalid product sort.", Status: 400}
	}
	limit := 50
	if raw := query.Get("limit"); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 1 || parsed > 100 {
			return ProductPage{}, &scans.Error{Code: "INVALID_INPUT", Message: "Invalid product page size.", Status: 400}
		}
		limit = parsed
	}
	position, err := decodeCursor(query.Get("cursor"), cursor{Version: 1, User: userID, Scan: scanID, Kind: "products", Query: q, Sort: sortBy, MinDiscount: minDiscount})
	if err != nil {
		return ProductPage{}, &scans.Error{Code: "INVALID_CURSOR", Message: "Invalid product cursor.", Status: 400}
	}
	groups := groupV2(scan.Source, deals, minDiscount)
	if q != "" {
		filtered := groups[:0]
		for _, group := range groups {
			text := normalizeProductText(strings.Join(append([]string{group.Title, stringValue(group.CategoryTitle)}, vendorTitles(group.Vendors)...), " "))
			if containsTokens(text, q) {
				filtered = append(filtered, group)
			}
		}
		groups = filtered
	}
	wishlistPhrases := s.wishlistPhrases(ctx, userID)
	cartQuantities, err := s.cartQuantities(ctx, userID, scan.Source)
	if err != nil {
		return ProductPage{}, err
	}
	sortGroups(groups, sortBy, wishlistPhrases, cartQuantities)
	if position > len(groups) {
		return ProductPage{}, &scans.Error{Code: "INVALID_CURSOR", Message: "Invalid product cursor.", Status: 400}
	}
	end := min(position+limit, len(groups))
	observedAt := scan.CreatedAt
	if scan.FinishedAt != nil {
		observedAt = *scan.FinishedAt
	}
	page := ProductPage{Items: make([]ProductSummary, 0, end-position), ObservedAt: observedAt, CoverageSummary: "legacy_unverified"}
	baselineID, reason, _ := s.baseline(ctx, userID, *scan)
	page.Baseline.ScanID = baselineID
	page.Baseline.Reason = reason
	if scan.Context != nil && scan.Context.Coverage == "complete" {
		page.CoverageSummary = "supported_discount_feeds"
	}
	for _, group := range groups[position:end] {
		page.Items = append(page.Items, ProductSummary{Key: group.Key, GroupKeyVersion: 2, ScanID: group.ScanID, Title: group.Title, Image: group.Image, CategoryTitle: group.CategoryTitle, PriceRials: group.PriceRials, DiscountRials: group.DiscountRials, FinalPriceRials: group.FinalPriceRials, DiscountRatio: group.DiscountRatio, State: group.State, BestCurrentOffer: group.BestCurrentOffer, CurrentStoreOfferCount: group.CurrentStoreOfferCount, Diagnostics: group.Diagnostics, ConditionalOfferCount: len(group.ConditionalOffers), CartQuantity: cartQuantities[group.Key], WishlistMatch: matchesWishlist(group.Title, wishlistPhrases)})
	}
	if end < len(groups) {
		next, err := encodeCursor(cursor{Version: 1, User: userID, Scan: scanID, Kind: "products", Query: q, Sort: sortBy, MinDiscount: minDiscount, Position: []any{end}})
		if err != nil {
			return ProductPage{}, err
		}
		page.NextCursor = &next
	}
	return page, nil
}

func (s *Service) ProductGroups(ctx context.Context, queue *scans.Queue, userID, scanID string) ([]Group, *scans.Record, error) {
	return s.productGroupsAtDiscount(ctx, queue, userID, scanID, discounts.Minimum)
}

func (s *Service) productGroupsAtDiscount(ctx context.Context, queue *scans.Queue, userID, scanID string, minDiscount int) ([]Group, *scans.Record, error) {
	deals, scan, err := s.Deals(ctx, queue, userID, scanID)
	if err != nil {
		return nil, scan, err
	}
	return groupV2(scan.Source, deals, minDiscount), scan, nil
}

func LegacyGroups(source string, deals []DealRecord) []map[string]any {
	buckets := make(map[string][]DealRecord)
	for _, deal := range deals {
		key := "v1:" + mustJSON([]any{normalizeDealGroupText(source), strings.TrimSpace(deal.ProductVariationID), normalizeDealGroupText(deal.Title), canonicalImage(deal.Image), normalizeDealGroupText(stringValue(deal.CategoryTitle)), deal.PriceRials, deal.DiscountRials, deal.FinalPriceRials, deal.DiscountRatio})
		buckets[key] = append(buckets[key], deal)
	}
	groups := make([]map[string]any, 0, len(buckets))
	for key, rows := range buckets {
		current := make([]DealRecord, 0)
		vendorsByID := make(map[string]DealRecord)
		for _, row := range rows {
			if row.State != "no_longer_present" {
				current = append(current, row)
			}
			previous, exists := vendorsByID[row.VendorID]
			if !exists || prefer(row, previous) > 0 {
				vendorsByID[row.VendorID] = row
			}
		}
		vendors := make([]map[string]any, 0, len(vendorsByID))
		ordered := make([]DealRecord, 0, len(vendorsByID))
		for _, row := range vendorsByID {
			ordered = append(ordered, row)
		}
		sort.Slice(ordered, func(i, j int) bool {
			a, b := normalizeDealGroupText(ordered[i].VendorTitle), normalizeDealGroupText(ordered[j].VendorTitle)
			if a != b {
				return a < b
			}
			return ordered[i].VendorID < ordered[j].VendorID
		})
		for _, row := range ordered {
			vendors = append(vendors, map[string]any{"offerKey": row.Key, "productVariationId": row.ProductVariationID, "vendorId": row.VendorID, "vendorTitle": row.VendorTitle, "vendorCode": row.VendorCode, "priceRials": row.PriceRials, "discountRials": row.DiscountRials, "finalPriceRials": row.FinalPriceRials, "discountRatio": row.DiscountRatio, "stock": row.Stock, "state": row.State})
		}
		representative := rows[0]
		for _, row := range rows {
			if prefer(row, representative) > 0 {
				representative = row
			}
		}
		state := "no_longer_present"
		if len(current) > 0 {
			state = "new"
			for _, row := range current {
				if row.State == "still_available" {
					state = "still_available"
					break
				}
			}
		}
		groups = append(groups, map[string]any{"key": key, "groupKeyVersion": 1, "scanId": representative.ScanID, "title": representative.Title, "image": representative.Image, "categoryTitle": representative.CategoryTitle, "priceRials": representative.PriceRials, "discountRials": representative.DiscountRials, "finalPriceRials": representative.FinalPriceRials, "discountRatio": representative.DiscountRatio, "state": state, "vendors": vendors})
	}
	sort.Slice(groups, func(i, j int) bool {
		a := groups[i]["discountRatio"].(float64)
		b := groups[j]["discountRatio"].(float64)
		if a != b {
			return a > b
		}
		return groups[i]["key"].(string) < groups[j]["key"].(string)
	})
	return groups
}

func (s *Service) OfferPage(ctx context.Context, queue *scans.Queue, userID, scanID, groupKey string, query url.Values) (OfferPage, error) {
	minDiscount, err := minimumDiscount(query)
	if err != nil {
		return OfferPage{}, err
	}
	limit := 20
	if raw := query.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 50 {
			return OfferPage{}, &scans.Error{Code: "INVALID_INPUT", Message: "Invalid offer page size.", Status: 400}
		}
		limit = parsed
	}
	sortBy := query.Get("sort")
	if sortBy == "" {
		sortBy = "discount"
	}
	q := normalizeProductText(query.Get("q"))
	if len([]rune(query.Get("q"))) > 200 {
		return OfferPage{}, &scans.Error{Code: "INVALID_INPUT", Message: "Invalid offer query.", Status: 400}
	}
	position, err := decodeCursor(query.Get("cursor"), cursor{Version: 1, User: userID, Scan: scanID, Kind: "offers", Query: q, Sort: sortBy, Group: groupKey, MinDiscount: minDiscount})
	if err != nil {
		return OfferPage{}, &scans.Error{Code: "INVALID_CURSOR", Message: "Invalid offer cursor.", Status: 400}
	}
	groups, _, err := s.productGroupsAtDiscount(ctx, queue, userID, scanID, minDiscount)
	if err != nil {
		return OfferPage{}, err
	}
	var group *Group
	for i := range groups {
		if groups[i].Key == groupKey {
			group = &groups[i]
			break
		}
	}
	if group == nil {
		return OfferPage{}, &scans.Error{Code: "NOT_FOUND", Message: "Product group not found.", Status: 404}
	}
	offers := append(append([]VendorOffer{}, group.Vendors...), group.ConditionalOffers...)
	if q != "" {
		filtered := offers[:0]
		for _, offer := range offers {
			if containsTokens(normalizeProductText(offer.VendorTitle), q) {
				filtered = append(filtered, offer)
			}
		}
		offers = filtered
	}
	sort.Slice(offers, func(i, j int) bool {
		a, b := offers[i], offers[j]
		ac, bc := 0, 0
		if a.Benefit.Kind == "conditional" || a.Benefit.Applicable == nil || !*a.Benefit.Applicable {
			ac = 1
		}
		if b.Benefit.Kind == "conditional" || b.Benefit.Applicable == nil || !*b.Benefit.Applicable {
			bc = 1
		}
		ap, bp := 0, 0
		if a.State == "no_longer_present" {
			ap = 1
		}
		if b.State == "no_longer_present" {
			bp = 1
		}
		if ac != bc {
			return ac < bc
		}
		if ap != bp {
			return ap < bp
		}
		if a.FinalPriceRials != b.FinalPriceRials {
			return a.FinalPriceRials < b.FinalPriceRials
		}
		if a.VendorID != b.VendorID {
			return a.VendorID < b.VendorID
		}
		return a.OfferKey < b.OfferKey
	})
	if position > len(offers) {
		return OfferPage{}, &scans.Error{Code: "INVALID_CURSOR", Message: "Invalid offer cursor.", Status: 400}
	}
	end := min(position+limit, len(offers))
	page := OfferPage{Items: append([]VendorOffer{}, offers[position:end]...)}
	if end < len(offers) {
		next, err := encodeCursor(cursor{Version: 1, User: userID, Scan: scanID, Kind: "offers", Query: q, Sort: sortBy, Group: groupKey, MinDiscount: minDiscount, Position: []any{end}})
		if err != nil {
			return OfferPage{}, err
		}
		page.NextCursor = &next
	}
	return page, nil
}

func (s *Service) readDeals(ctx context.Context, scanID, selectedScanID string) ([]DealRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT deal_key,product_variation_id,vendor_id,title,image,vendor_title,vendor_code,category_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json FROM deals WHERE scan_id=? ORDER BY discount_ratio DESC,final_price_rials`, scanID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]DealRecord, 0)
	for rows.Next() {
		var item DealRecord
		var image, vendorCode, category, facts sql.NullString
		if err := rows.Scan(&item.Key, &item.ProductVariationID, &item.VendorID, &item.Title, &image, &item.VendorTitle, &vendorCode, &category, &item.PriceRials, &item.DiscountRials, &item.FinalPriceRials, &item.DiscountRatio, &item.Stock, &facts); err != nil {
			return nil, err
		}
		item.ScanID = selectedScanID
		item.Image = nullString(image)
		item.VendorCode = nullString(vendorCode)
		item.CategoryTitle = nullString(category)
		item.State = "current"
		if facts.Valid {
			var value struct {
				VendorLogoURL       *string  `json:"vendorLogoUrl"`
				Benefit             *Benefit `json:"benefit"`
				ObservedAt          string   `json:"observedAt"`
				Provenance          []string `json:"provenance"`
				ObservationPriority int      `json:"observationPriority"`
			}
			if err := json.Unmarshal([]byte(facts.String), &value); err != nil {
				return nil, err
			}
			item.VendorLogoURL = value.VendorLogoURL
			item.Benefit = value.Benefit
			item.ObservedAt = value.ObservedAt
			item.Provenance = value.Provenance
			item.ObservationPriority = value.ObservationPriority
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *Service) baseline(ctx context.Context, userID string, scan scans.Record) (*string, string, bool) {
	if scan.Context == nil {
		return nil, "legacy_unverified", false
	}
	if scan.Context.Coverage != "complete" {
		return nil, "incomplete_coverage", false
	}
	c := scan.Context
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM scans WHERE user_id=? AND location_id=? AND threshold=? AND source=? AND status='succeeded' AND json_extract(context_json,'$.coverage')='complete' AND json_extract(context_json,'$.scopeHash')=? AND json_extract(context_json,'$.location.revision')=? AND json_extract(context_json,'$.location.latitude')=? AND json_extract(context_json,'$.location.longitude')=? AND json_extract(context_json,'$.eligibilityVersion')=? AND json_extract(context_json,'$.offerKeyVersion')=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 1`, userID, scan.LocationID, scan.Threshold, scan.Source, c.ScopeHash, c.Location.Revision, c.Location.Latitude, c.Location.Longitude, c.EligibilityVersion, c.OfferKeyVersion, scan.CreatedAt, scan.CreatedAt, scan.ID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "no_comparable_baseline", true
	}
	if err != nil {
		return nil, "no_comparable_baseline", false
	}
	return &id, "comparable", true
}

func (s *Service) wishlistPhrases(ctx context.Context, userID string) [][]string {
	rows, err := s.db.QueryContext(ctx, `SELECT tokens_json FROM wishlist_items WHERE user_id=?`, userID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var phrases [][]string
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			continue
		}
		var tokens []string
		if json.Unmarshal([]byte(raw), &tokens) != nil {
			continue
		}
		phrases = append(phrases, tokens)
	}
	return phrases
}

func (s *Service) cartQuantities(ctx context.Context, userID, source string) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT group_key,quantity FROM provider_carts WHERE user_id=? AND source=?`, userID, source)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	quantities := make(map[string]int)
	for rows.Next() {
		var key string
		var quantity int
		if err := rows.Scan(&key, &quantity); err != nil {
			return nil, err
		}
		quantities[key] = quantity
	}
	return quantities, rows.Err()
}

func groupV2(provider string, deals []DealRecord, minDiscount int) []Group {
	buckets := make(map[string][]DealRecord)
	variants := make(map[string]map[string]struct{})
	for _, row := range deals {
		title := normalizeDealGroupText(row.Title)
		identity := mustJSON([]string{provider, strings.TrimSpace(row.ProductVariationID), title})
		buckets[identity] = append(buckets[identity], row)
		key := strings.TrimSpace(row.ProductVariationID)
		if variants[key] == nil {
			variants[key] = map[string]struct{}{}
		}
		variants[key][title] = struct{}{}
	}
	groups := make([]Group, 0, len(buckets))
	for identity, rows := range buckets {
		g := buildGroup(provider, identity, rows, variants, minDiscount)
		if len(g.Vendors) > 0 || len(g.ConditionalOffers) > 0 {
			groups = append(groups, g)
		}
	}
	sort.Slice(groups, func(i, j int) bool { return compareProductDiscount(groups[i], groups[j]) < 0 })
	return groups
}

func buildGroup(provider, identity string, rows []DealRecord, variants map[string]map[string]struct{}, minDiscount int) Group {
	type observation struct {
		row        DealRecord
		provenance map[string]struct{}
	}
	observations := map[string]observation{}
	diagnostics := map[string]struct{}{}
	for _, row := range rows {
		if !validPrice(row) {
			diagnostics["PRICE_ANOMALY"] = struct{}{}
			continue
		}
		benefit := benefitFor(provider, row)
		id := mustJSON([]string{provider, row.VendorID, row.ProductVariationID, benefit.Kind, benefit.Identity})
		prev, exists := observations[id]
		sources := map[string]struct{}{}
		if exists {
			for v := range prev.provenance {
				sources[v] = struct{}{}
			}
			if prev.row.FinalPriceRials != row.FinalPriceRials || prev.row.PriceRials != row.PriceRials {
				diagnostics["OBSERVATION_CONFLICT"] = struct{}{}
			}
		}
		for _, source := range row.Provenance {
			sources[source] = struct{}{}
		}
		if !exists || prefer(row, prev.row) > 0 {
			observations[id] = observation{row: row, provenance: sources}
		} else {
			observations[id] = observation{row: prev.row, provenance: sources}
		}
	}
	all := make([]VendorOffer, 0, len(observations))
	rowsByKey := map[string]DealRecord{}
	for id, ob := range observations {
		row := ob.row
		if row.DiscountRatio < float64(minDiscount) {
			continue
		}
		rowsByKey[row.Key] = row
		prov := sortedKeys(ob.provenance)
		kind := "rial"
		amount := func(value float64) float64 { return math.Round(value / 10) }
		if provider == "snappmarket" {
			kind = "toman"
			amount = math.Round
		}
		benefit := benefitFor(provider, row)
		all = append(all, VendorOffer{LogoURL: row.VendorLogoURL, OfferKey: row.Key, ProductVariationID: row.ProductVariationID, VendorID: row.VendorID, VendorTitle: row.VendorTitle, VendorCode: row.VendorCode, PriceRials: row.PriceRials, DiscountRials: row.DiscountRials, FinalPriceRials: row.FinalPriceRials, DiscountRatio: row.DiscountRatio, Stock: row.Stock, State: row.State, Benefit: benefit, ObservedAt: row.ObservedAt, Provenance: prov, SourceMoneyUnit: kind, OriginalAmountToman: amount(row.PriceRials), DiscountAmountToman: amount(row.DiscountRials), FinalAmountToman: amount(row.FinalPriceRials)})
		_ = id
	}
	conditional := make([]VendorOffer, 0)
	vendors := make([]VendorOffer, 0)
	for _, offer := range all {
		cond := offer.Benefit.Kind == "conditional" || offer.Benefit.Applicable == nil || !*offer.Benefit.Applicable
		if cond {
			if offer.State == "no_longer_present" || offer.Stock > 0 {
				conditional = append(conditional, offer)
			}
		} else if offer.State == "no_longer_present" || offer.Stock > 0 {
			vendors = append(vendors, offer)
		}
	}
	sort.Slice(conditional, func(i, j int) bool { return compareOfferPrice(conditional[i], conditional[j]) < 0 })
	sort.Slice(vendors, func(i, j int) bool { return compareOfferPrice(vendors[i], vendors[j]) < 0 })
	current := make([]VendorOffer, 0)
	for _, v := range vendors {
		if v.State != "no_longer_present" {
			current = append(current, v)
		}
	}
	var best *VendorOffer
	if len(current) > 0 {
		best = &current[0]
	}
	var representative DealRecord
	if best != nil {
		for _, row := range rows {
			if row.Key == best.OfferKey {
				representative = row
				break
			}
		}
	} else if len(vendors) > 0 {
		representative = rowsByKey[vendors[0].OfferKey]
	} else if len(conditional) > 0 {
		representative = rowsByKey[conditional[0].OfferKey]
	} else if len(rows) > 0 {
		representative = rows[0]
	}
	if len(variants[strings.TrimSpace(representative.ProductVariationID)]) > 1 {
		diagnostics["VARIANT_ID_CONFLICT"] = struct{}{}
	}
	present := current
	if len(present) == 0 {
		for _, o := range conditional {
			if o.State != "no_longer_present" {
				present = append(present, o)
			}
		}
	}
	state := "no_longer_present"
	if len(present) > 0 {
		state = "new"
		for _, o := range present {
			if o.State == "still_available" {
				state = "still_available"
				break
			}
			if o.State == "current" {
				state = "current"
			}
		}
	}
	var price, discount, final, ratio float64
	if best != nil {
		price, discount, final, ratio = best.PriceRials, best.DiscountRials, best.FinalPriceRials, best.DiscountRatio
	} else {
		price, discount, final, ratio = representative.PriceRials, representative.DiscountRials, representative.FinalPriceRials, representative.DiscountRatio
	}
	identityValue := []string{provider, strings.TrimSpace(representative.ProductVariationID), normalizeDealGroupText(representative.Title)}
	digest := sha256.Sum256([]byte(mustJSON(identityValue)))
	return Group{Key: "v2:" + hex.EncodeToString(digest[:]), GroupKeyVersion: 2, ScanID: representative.ScanID, Title: representative.Title, Image: representative.Image, CategoryTitle: representative.CategoryTitle, PriceRials: price, DiscountRials: discount, FinalPriceRials: final, DiscountRatio: ratio, State: state, Vendors: vendors, AllOffers: all, BestCurrentOffer: best, CurrentStoreOfferCount: uniqueVendors(current), ConditionalOffers: conditional, Diagnostics: sortedKeys(diagnostics)}
}

func prefer(a, b DealRecord) int {
	if a.State != b.State {
		ar, br := stateRank(a.State), stateRank(b.State)
		if ar != br {
			return ar - br
		}
	}
	ta, tb := parseDate(a.ObservedAt), parseDate(b.ObservedAt)
	if !ta.Equal(tb) {
		if ta.After(tb) {
			return 1
		}
		return -1
	}
	if a.ObservationPriority != b.ObservationPriority {
		return a.ObservationPriority - b.ObservationPriority
	}
	ap, bp := strings.Join(sortedSlice(a.Provenance), "|"), strings.Join(sortedSlice(b.Provenance), "|")
	if ap != bp {
		if ap > bp {
			return 1
		}
		return -1
	}
	if a.Key != b.Key {
		if a.Key < b.Key {
			return 1
		}
		return -1
	}
	aa, bb := mustJSON([]float64{a.PriceRials, a.DiscountRials, a.FinalPriceRials, a.DiscountRatio}), mustJSON([]float64{b.PriceRials, b.DiscountRials, b.FinalPriceRials, b.DiscountRatio})
	return strings.Compare(aa, bb)
}
func stateRank(state string) int {
	if state == "no_longer_present" {
		return 0
	}
	return 1
}
func parseDate(value string) time.Time { at, _ := time.Parse(time.RFC3339Nano, value); return at }
func benefitFor(provider string, row DealRecord) Benefit {
	if row.Benefit != nil {
		return *row.Benefit
	}
	kind := "standard_discount"
	if provider == "snappmarket" {
		kind = "market_party"
	}
	yes := true
	return Benefit{Kind: kind, Identity: "ordinary", Applicable: &yes}
}
func validPrice(row DealRecord) bool {
	values := []float64{row.PriceRials, row.DiscountRials, row.FinalPriceRials, row.DiscountRatio}
	for _, v := range values {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	if row.PriceRials <= 0 || row.DiscountRials < 0 || row.DiscountRials > row.PriceRials || row.FinalPriceRials != row.PriceRials-row.DiscountRials {
		return false
	}
	return math.Abs(row.DiscountRatio-(row.DiscountRials/row.PriceRials)*100) <= 1
}
func compareOfferPrice(a, b VendorOffer) int {
	if a.FinalPriceRials < b.FinalPriceRials {
		return -1
	}
	if a.FinalPriceRials > b.FinalPriceRials {
		return 1
	}
	if a.VendorID < b.VendorID {
		return -1
	}
	if a.VendorID > b.VendorID {
		return 1
	}
	return strings.Compare(a.OfferKey, b.OfferKey)
}
func compareProductDiscount(a, b Group) int {
	if a.BestCurrentOffer == nil || b.BestCurrentOffer == nil {
		if a.BestCurrentOffer != nil {
			return -1
		}
		if b.BestCurrentOffer != nil {
			return 1
		}
		return strings.Compare(a.Key, b.Key)
	}
	x, y := a.BestCurrentOffer, b.BestCurrentOffer
	if x.DiscountRatio != y.DiscountRatio {
		return cmpFloatDesc(x.DiscountRatio, y.DiscountRatio)
	}
	if x.DiscountRials != y.DiscountRials {
		return cmpFloatDesc(x.DiscountRials, y.DiscountRials)
	}
	if x.FinalPriceRials != y.FinalPriceRials {
		return cmpFloat(x.FinalPriceRials, y.FinalPriceRials)
	}
	return strings.Compare(a.Key, b.Key)
}
func cmpFloat(a, b float64) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}
func cmpFloatDesc(a, b float64) int { return cmpFloat(b, a) }
func uniqueVendors(offers []VendorOffer) int {
	seen := map[string]struct{}{}
	for _, o := range offers {
		seen[o.VendorID] = struct{}{}
	}
	return len(seen)
}
func sortedKeys(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for key := range values {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}
func sortedSlice(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}
func mustJSON(value any) string { bytes, _ := json.Marshal(value); return string(bytes) }
func normalizeDealGroupText(value string) string {
	value = norm.NFKC.String(value)
	value = strings.NewReplacer("ي", "ی", "ى", "ی", "ك", "ک", "\u200c", " ").Replace(value)
	return strings.Join(strings.Fields(value), " ")
}

func canonicalImage(value *string) any {
	if value == nil {
		return nil
	}
	normalized := normalizeDealGroupText(*value)
	if normalized == "" {
		return nil
	}
	parsed, err := url.Parse(normalized)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		parsed.Scheme = strings.ToLower(parsed.Scheme)
		parsed.Host = strings.ToLower(parsed.Host)
		if parsed.Scheme == "https" && parsed.Port() == "443" || parsed.Scheme == "http" && parsed.Port() == "80" {
			parsed.Host = parsed.Hostname()
		}
		parsed.Fragment = ""
		return parsed.String()
	}
	return normalized
}
func normalizeProductText(value string) string {
	value = normalizeDealGroupText(value)
	var out strings.Builder
	for _, r := range value {
		switch {
		case r >= '۰' && r <= '۹':
			out.WriteRune(r - '۰' + '0')
		case r >= '٠' && r <= '٩':
			out.WriteRune(r - '٠' + '0')
		default:
			out.WriteRune(r)
		}
	}
	return strings.ToLower(out.String())
}

func NormalizeSearchText(value string) string { return normalizeProductText(value) }

func containsTokens(value, query string) bool {
	for _, token := range strings.Fields(query) {
		if !strings.Contains(value, token) {
			return false
		}
	}
	return true
}
func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
func vendorTitles(values []VendorOffer) []string {
	result := make([]string, 0, len(values))
	for _, v := range values {
		result = append(result, v.VendorTitle)
	}
	return result
}
func sortGroups(groups []Group, sortBy string, wishlist [][]string, cartQuantities map[string]int) {
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		if sortBy == "title" {
			return normalizeProductText(a.Title) < normalizeProductText(b.Title)
		}
		if sortBy == "price" || sortBy == "price_asc" {
			if a.FinalPriceRials != b.FinalPriceRials {
				return a.FinalPriceRials < b.FinalPriceRials
			}
		}
		if sortBy == "price_desc" {
			if a.FinalPriceRials != b.FinalPriceRials {
				return a.FinalPriceRials > b.FinalPriceRials
			}
		}
		if sortBy == "wishlist" {
			am, bm := matchesWishlist(a.Title, wishlist), matchesWishlist(b.Title, wishlist)
			if am != bm {
				return am
			}
			if cartQuantities[a.Key] != cartQuantities[b.Key] {
				return cartQuantities[a.Key] > cartQuantities[b.Key]
			}
		}
		return compareProductDiscount(a, b) < 0
	})
}
func matchesWishlist(title string, phrases [][]string) bool {
	n := normalizeProductText(title)
	for _, tokens := range phrases {
		if len(tokens) > 0 && containsTokens(n, strings.Join(tokens, " ")) {
			return true
		}
	}
	return false
}
func decodeCursor(value string, context cursor) (int, error) {
	if value == "" {
		return 0, nil
	}
	if len(value) > 2000 {
		return 0, errors.New("cursor too long")
	}
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, err
	}
	var decoded cursor
	if json.Unmarshal(bytes, &decoded) != nil || decoded.Version != 1 || decoded.User != context.User || decoded.Scan != context.Scan || decoded.Kind != context.Kind || decoded.Query != context.Query || decoded.Sort != context.Sort || decoded.Group != context.Group || decoded.MinDiscount != context.MinDiscount || len(decoded.Position) != 1 {
		return 0, errors.New("invalid cursor")
	}
	n, ok := decoded.Position[0].(float64)
	if !ok || n < 0 || math.Trunc(n) != n {
		return 0, errors.New("invalid cursor")
	}
	return int(n), nil
}

func minimumDiscount(query url.Values) (int, error) {
	if !query.Has("minDiscount") {
		return discounts.Minimum, nil
	}
	percent, err := strconv.Atoi(query.Get("minDiscount"))
	if err != nil || !discounts.Valid(percent) {
		return 0, &scans.Error{Code: "INVALID_INPUT", Message: "Minimum discount must be between 15 and 80 percent.", Status: 400}
	}
	return percent, nil
}
func encodeCursor(value cursor) (string, error) {
	bytes, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
