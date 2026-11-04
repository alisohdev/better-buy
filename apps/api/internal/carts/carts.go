package carts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

const searchBudget = 50_000

type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string { return e.Code }

type Line struct {
	Key           string  `json:"key"`
	Title         string  `json:"title"`
	Image         *string `json:"image"`
	CategoryTitle *string `json:"categoryTitle"`
	Quantity      int     `json:"quantity"`
}

type Offer struct {
	VendorID    string
	VendorCode  *string
	VendorTitle string
	LogoURL     *string
	PriceRials  float64
	Stock       float64
}

type offerLine struct {
	Line   Line
	Offers []Offer
}

type AssignedItem struct {
	Line
	PriceRials     float64 `json:"priceRials"`
	LineTotalRials float64 `json:"lineTotalRials"`
}

type StoreRecommendation struct {
	VendorID    string         `json:"vendorId"`
	VendorCode  *string        `json:"vendorCode"`
	VendorTitle string         `json:"vendorTitle"`
	LogoURL     *string        `json:"logoUrl"`
	Items       []AssignedItem `json:"items"`
	TotalRials  float64        `json:"totalRials"`
}

type MissingItem struct {
	Line
	Reason string `json:"reason"`
}

type Recommendation struct {
	Status       string                `json:"status"`
	Optimal      bool                  `json:"optimal"`
	Stores       []StoreRecommendation `json:"stores"`
	MissingItems []MissingItem         `json:"missingItems"`
	TotalRials   float64               `json:"totalRials"`
	SearchLimit  *int                  `json:"searchLimit,omitempty"`
}

type Response struct {
	Source         string         `json:"source"`
	LocationID     *string        `json:"locationId"`
	ScanID         *string        `json:"scanId"`
	ObservedAt     *string        `json:"observedAt"`
	Coverage       string         `json:"coverage"`
	Lines          []Line         `json:"lines"`
	Recommendation Recommendation `json:"recommendation"`
}

type Catalog interface {
	ProductGroups(context.Context, *scans.Queue, string, string) ([]products.Group, *scans.Record, error)
}

type Service struct {
	db      *sql.DB
	queue   *scans.Queue
	catalog Catalog
}

func New(db *sql.DB, queue *scans.Queue, catalog Catalog) *Service {
	return &Service{db: db, queue: queue, catalog: catalog}
}

func (s *Service) Read(ctx context.Context, userID, source string, locationID *string) (Response, error) {
	lines, err := s.lines(ctx, userID, source)
	if err != nil {
		return Response{}, err
	}
	response := Response{Source: source, Coverage: "legacy_unverified", Lines: lines, Recommendation: recommend(lines, nil, false)}
	location, err := s.location(ctx, userID, locationID)
	if err != nil {
		return Response{}, err
	}
	if location == nil {
		return response, nil
	}
	response.LocationID = stringPointer(location.ID)
	selected, err := s.currentScan(ctx, userID, source, *location)
	if err != nil {
		return Response{}, err
	}
	if selected == nil {
		return response, nil
	}
	groups, scan, err := s.catalog.ProductGroups(ctx, s.queue, userID, selected.ID)
	if err != nil {
		return Response{}, err
	}
	byKey := make(map[string]products.Group, len(groups))
	for _, group := range groups {
		byKey[group.Key] = group
	}
	offerLines := make([]offerLine, 0, len(lines))
	for _, line := range lines {
		offerLines = append(offerLines, offerLine{Line: line, Offers: groupOffers(byKey[line.Key])})
	}
	response.ScanID = stringPointer(scan.ID)
	observedAt := scan.CreatedAt
	if scan.FinishedAt != nil {
		observedAt = *scan.FinishedAt
	}
	response.ObservedAt = stringPointer(observedAt)
	if scan.Context != nil && scan.Context.Coverage == "complete" {
		response.Coverage = "supported_discount_feeds"
	}
	response.Recommendation = recommendOffers(offerLines, true)
	return response, nil
}

func (s *Service) Put(ctx context.Context, userID, source, groupKey, scanID string, quantity int) error {
	scan, err := s.queue.Get(ctx, userID, scanID)
	if err != nil {
		return err
	}
	if scan.Source != source {
		return &Error{Code: "NOT_FOUND", Status: 404}
	}
	if scan.Status != "succeeded" {
		return &Error{Code: "SCAN_NOT_PUBLISHED", Status: 409}
	}
	location, err := s.location(ctx, userID, &scan.LocationID)
	if err != nil {
		return err
	}
	if location == nil || scan.Context == nil || !sameLocation(scan.Context, *location) {
		return &Error{Code: "STALE_SCAN", Status: 409}
	}
	groups, _, err := s.catalog.ProductGroups(ctx, s.queue, userID, scanID)
	if err != nil {
		return err
	}
	var selected *products.Group
	for i := range groups {
		if groups[i].Key == groupKey {
			selected = &groups[i]
			break
		}
	}
	if selected == nil {
		return &Error{Code: "NOT_FOUND", Status: 404}
	}
	eligible := false
	for _, offer := range selected.Vendors {
		if offer.State != "no_longer_present" && offer.Stock >= 1 && offer.Benefit.Kind != "conditional" && offer.Benefit.Applicable != nil && *offer.Benefit.Applicable {
			eligible = true
			break
		}
	}
	if !eligible {
		return &Error{Code: "PRODUCT_UNAVAILABLE", Status: 409}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := s.db.ExecContext(ctx, `INSERT INTO provider_carts(user_id,source,group_key,title,image,category_title,quantity,origin_scan_id,created_at,updated_at)
		SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM provider_carts WHERE user_id=? AND source=? AND group_key=?) OR (SELECT COUNT(*) FROM provider_carts WHERE user_id=? AND source=?)<24
		ON CONFLICT(user_id,source,group_key) DO UPDATE SET title=excluded.title,image=excluded.image,category_title=excluded.category_title,quantity=excluded.quantity,origin_scan_id=excluded.origin_scan_id,updated_at=excluded.updated_at`,
		userID, source, groupKey, selected.Title, selected.Image, selected.CategoryTitle, quantity, scanID, now, now,
		userID, source, groupKey, userID, source)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return &Error{Code: "CART_LIMIT", Status: 409}
	}
	return nil
}

func (s *Service) Update(ctx context.Context, userID, source, groupKey string, quantity int) error {
	result, err := s.db.ExecContext(ctx, "UPDATE provider_carts SET quantity=?,updated_at=? WHERE user_id=? AND source=? AND group_key=?", quantity, time.Now().UTC().Format(time.RFC3339Nano), userID, source, groupKey)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err == nil && changed == 0 {
		return &Error{Code: "NOT_FOUND", Status: 404}
	}
	return err
}

func (s *Service) Delete(ctx context.Context, userID, source, groupKey string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM provider_carts WHERE user_id=? AND source=? AND group_key=?", userID, source, groupKey)
	return err
}

type location struct {
	ID                 string
	CoordinateRevision int
	Latitude           float64
	Longitude          float64
}

func (s *Service) location(ctx context.Context, userID string, locationID *string) (*location, error) {
	query := "SELECT id,coordinate_revision,latitude,longitude FROM locations WHERE user_id=? ORDER BY is_default DESC,created_at LIMIT 1"
	args := []any{userID}
	if locationID != nil {
		query = "SELECT id,coordinate_revision,latitude,longitude FROM locations WHERE user_id=? AND id=?"
		args = append(args, *locationID)
	}
	var found location
	err := s.db.QueryRowContext(ctx, query, args...).Scan(&found.ID, &found.CoordinateRevision, &found.Latitude, &found.Longitude)
	if errors.Is(err, sql.ErrNoRows) {
		if locationID != nil {
			return nil, &Error{Code: "NOT_FOUND", Status: 404}
		}
		return nil, nil
	}
	return &found, err
}

type scanCandidate struct {
	ID         string
	Context    sql.NullString
	FinishedAt sql.NullString
	CreatedAt  string
}

func (s *Service) currentScan(ctx context.Context, userID, source string, target location) (*scanCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,context_json,finished_at,created_at FROM scans WHERE user_id=? AND location_id=? AND source=? AND status='succeeded' ORDER BY finished_at DESC,created_at DESC,id DESC`, userID, target.ID, source)
	if err != nil {
		return nil, err
	}
	var candidates []scanCandidate
	for rows.Next() {
		var row scanCandidate
		if err := rows.Scan(&row.ID, &row.Context, &row.FinishedAt, &row.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		candidates = append(candidates, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for i := range candidates {
		var context scans.Context
		if !candidates[i].Context.Valid || json.Unmarshal([]byte(candidates[i].Context.String), &context) != nil {
			continue
		}
		if context.Location.Revision == target.CoordinateRevision && context.Location.Latitude == target.Latitude && context.Location.Longitude == target.Longitude {
			return &candidates[i], nil
		}
	}
	return nil, nil
}

func (s *Service) lines(ctx context.Context, userID, source string) ([]Line, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT group_key,title,image,category_title,quantity FROM provider_carts WHERE user_id=? AND source=? ORDER BY created_at,group_key", userID, source)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lines := make([]Line, 0)
	for rows.Next() {
		var line Line
		if err := rows.Scan(&line.Key, &line.Title, &line.Image, &line.CategoryTitle, &line.Quantity); err != nil {
			return nil, err
		}
		lines = append(lines, line)
	}
	return lines, rows.Err()
}

func sameLocation(context *scans.Context, target location) bool {
	return context.Location.Revision == target.CoordinateRevision && context.Location.Latitude == target.Latitude && context.Location.Longitude == target.Longitude
}

func groupOffers(group products.Group) []Offer {
	offers := make([]Offer, 0, len(group.AllOffers))
	for _, offer := range group.AllOffers {
		if offer.State == "no_longer_present" || offer.Benefit.Kind == "conditional" || offer.Benefit.Applicable == nil || !*offer.Benefit.Applicable {
			continue
		}
		offers = append(offers, Offer{VendorID: offer.VendorID, VendorCode: offer.VendorCode, VendorTitle: offer.VendorTitle, LogoURL: offer.LogoURL, PriceRials: offer.FinalPriceRials, Stock: offer.Stock})
	}
	return offers
}

func recommend(lines []Line, offers []offerLine, scanAvailable bool) Recommendation {
	if len(lines) == 0 {
		return Recommendation{Status: "empty", Optimal: true, Stores: []StoreRecommendation{}, MissingItems: []MissingItem{}}
	}
	if !scanAvailable {
		return Recommendation{Status: "no_scan", Optimal: false, Stores: []StoreRecommendation{}, MissingItems: []MissingItem{}}
	}
	return recommendOffers(offers, true)
}

func recommendOffers(lines []offerLine, scanAvailable bool) Recommendation {
	if len(lines) == 0 {
		return Recommendation{Status: "empty", Optimal: true, Stores: []StoreRecommendation{}, MissingItems: []MissingItem{}}
	}
	if !scanAvailable {
		return Recommendation{Status: "no_scan", Optimal: false, Stores: []StoreRecommendation{}, MissingItems: []MissingItem{}}
	}
	eligible := make([][]Offer, len(lines))
	missing := make([]MissingItem, 0)
	for i, line := range lines {
		byVendor := make(map[string]Offer)
		for _, offer := range line.Offers {
			if math.IsNaN(offer.PriceRials) || math.IsInf(offer.PriceRials, 0) || offer.PriceRials < 0 || math.IsNaN(offer.Stock) || math.IsInf(offer.Stock, 0) || offer.Stock < float64(line.Line.Quantity) {
				continue
			}
			prior, ok := byVendor[offer.VendorID]
			if !ok || offer.PriceRials < prior.PriceRials {
				byVendor[offer.VendorID] = offer
			}
		}
		for _, offer := range byVendor {
			eligible[i] = append(eligible[i], offer)
		}
		sort.Slice(eligible[i], func(a, b int) bool { return eligible[i][a].VendorID < eligible[i][b].VendorID })
		if len(eligible[i]) == 0 {
			reason := "missing_product"
			if len(line.Offers) > 0 {
				reason = "insufficient_quantity"
			}
			missing = append(missing, MissingItem{Line: line.Line, Reason: reason})
		}
	}
	available := make([]int, 0, len(lines))
	vendorSet := make(map[string]struct{})
	for i, offers := range eligible {
		if len(offers) == 0 {
			continue
		}
		available = append(available, i)
		for _, offer := range offers {
			vendorSet[offer.VendorID] = struct{}{}
		}
	}
	vendors := make([]string, 0, len(vendorSet))
	for vendor := range vendorSet {
		vendors = append(vendors, vendor)
	}
	sort.Strings(vendors)
	type solution struct {
		selected map[string]struct{}
		total    float64
		assigned map[int]Offer
	}
	var best *solution
	signature := func(selected map[string]struct{}) string {
		keys := make([]string, 0, len(selected))
		for key := range selected {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		return strings.Join(keys, "\x1f")
	}
	costFor := func(selected map[string]struct{}) (float64, map[int]Offer, bool) {
		assigned := make(map[int]Offer, len(available))
		var total float64
		for _, i := range available {
			var choice *Offer
			for j := range eligible[i] {
				offer := &eligible[i][j]
				if _, ok := selected[offer.VendorID]; !ok {
					continue
				}
				if choice == nil || offer.PriceRials < choice.PriceRials || (offer.PriceRials == choice.PriceRials && offer.VendorID < choice.VendorID) {
					choice = offer
				}
			}
			if choice == nil {
				return 0, nil, false
			}
			assigned[i] = *choice
			total += choice.PriceRials * float64(lines[i].Line.Quantity)
		}
		return total, assigned, true
	}
	coversAll := func(selected map[string]struct{}) bool {
		for _, i := range available {
			covered := false
			for _, offer := range eligible[i] {
				if _, ok := selected[offer.VendorID]; ok {
					covered = true
					break
				}
			}
			if !covered {
				return false
			}
		}
		return true
	}
	consider := func(selected map[string]struct{}) {
		total, assigned, ok := costFor(selected)
		if !ok {
			return
		}
		if best == nil || len(selected) < len(best.selected) || (len(selected) == len(best.selected) && (total < best.total || (total == best.total && signature(selected) < signature(best.selected)))) {
			cloned := make(map[string]struct{}, len(selected))
			for key := range selected {
				cloned[key] = struct{}{}
			}
			best = &solution{selected: cloned, total: total, assigned: assigned}
		}
	}
	greedy := make(map[string]struct{})
	for _, i := range available {
		choice := eligible[i][0]
		for _, offer := range eligible[i][1:] {
			if offer.PriceRials < choice.PriceRials || (offer.PriceRials == choice.PriceRials && offer.VendorID < choice.VendorID) {
				choice = offer
			}
		}
		greedy[choice.VendorID] = struct{}{}
	}
	if coversAll(greedy) {
		consider(greedy)
	}
	for _, vendor := range vendors {
		selected := map[string]struct{}{vendor: {}}
		if coversAll(selected) {
			consider(selected)
		}
	}
	if best == nil || len(best.selected) > 2 {
		for a := range vendors {
			for b := a + 1; b < len(vendors); b++ {
				selected := map[string]struct{}{vendors[a]: {}, vendors[b]: {}}
				if coversAll(selected) {
					consider(selected)
				}
			}
		}
	}
	nodes, limited := 0, false
	visited, selected := make(map[string]struct{}), make(map[string]struct{})
	var visit func()
	visit = func() {
		nodes++
		if nodes > searchBudget {
			limited = true
			return
		}
		key := signature(selected)
		if _, ok := visited[key]; ok {
			return
		}
		visited[key] = struct{}{}
		if coversAll(selected) {
			consider(selected)
			return
		}
		if best != nil && len(selected) >= len(best.selected) {
			return
		}
		pivot := -1
		var choices []string
		for _, i := range available {
			covered := false
			for _, offer := range eligible[i] {
				if _, ok := selected[offer.VendorID]; ok {
					covered = true
					break
				}
			}
			if covered {
				continue
			}
			candidates := make([]string, 0, len(eligible[i]))
			for _, offer := range eligible[i] {
				if _, ok := selected[offer.VendorID]; !ok {
					candidates = append(candidates, offer.VendorID)
				}
			}
			if pivot < 0 || len(candidates) < len(choices) {
				pivot, choices = i, candidates
			}
		}
		_ = pivot
		sort.Strings(choices)
		for _, vendor := range choices {
			selected[vendor] = struct{}{}
			visit()
			delete(selected, vendor)
			if limited {
				return
			}
		}
	}
	if best == nil || len(best.selected) > 2 {
		visit()
	}
	storeByVendor := make(map[string]*StoreRecommendation)
	if best != nil {
		for i, offer := range best.assigned {
			store := storeByVendor[offer.VendorID]
			if store == nil {
				store = &StoreRecommendation{VendorID: offer.VendorID, VendorCode: offer.VendorCode, VendorTitle: offer.VendorTitle, LogoURL: offer.LogoURL, Items: []AssignedItem{}}
				storeByVendor[offer.VendorID] = store
			}
			line := lines[i].Line
			lineTotal := offer.PriceRials * float64(line.Quantity)
			store.Items = append(store.Items, AssignedItem{Line: line, PriceRials: offer.PriceRials, LineTotalRials: lineTotal})
			store.TotalRials += lineTotal
		}
	}
	storeIDs := make([]string, 0, len(storeByVendor))
	for id := range storeByVendor {
		storeIDs = append(storeIDs, id)
	}
	sort.Strings(storeIDs)
	stores := make([]StoreRecommendation, 0, len(storeIDs))
	var total float64
	for _, id := range storeIDs {
		stores = append(stores, *storeByVendor[id])
		total += storeByVendor[id].TotalRials
	}
	status := "complete"
	if len(missing) > 0 {
		status = "partial"
	} else if limited {
		status = "search_limit"
	}
	recommendation := Recommendation{Status: status, Optimal: !limited, Stores: stores, MissingItems: missing, TotalRials: total}
	if limited {
		budget := searchBudget
		recommendation.SearchLimit = &budget
	}
	return recommendation
}

func stringPointer(value string) *string { return &value }
