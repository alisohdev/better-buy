package api_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/providers"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
	"github.com/alirezasoheili/better-buy/apps/api/internal/wishlist"
)

const discountUser = "discount-test-user"
const discountLocation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

type discountFixture struct {
	db       *sql.DB
	queue    *scans.Queue
	products *products.Service
	wishlist *wishlist.Service
}

func newDiscountFixture(t *testing.T) discountFixture {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "discounts.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.ApplyMigrations(ctx, db); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO locations(id,user_id,name,latitude,longitude,created_at,updated_at) VALUES(?,?,?,35.6892,51.3890,?,?)`, discountLocation, discountUser, "Home", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return discountFixture{db: db, queue: queue, products: products.New(db, "test-key"), wishlist: wishlist.New(db, "test-key")}
}

func (f discountFixture) scan(t *testing.T, id string, at time.Time) {
	t.Helper()
	if _, err := f.db.ExecContext(context.Background(), `INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at,finished_at) VALUES(?,?,?,15,'snappmarket','full','succeeded',?,?)`, id, discountUser, discountLocation, at.Format(time.RFC3339Nano), at.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.ExecContext(context.Background(), `INSERT INTO scan_execution(scan_id,user_id,instance_id,device_id,queued_until,created_at) VALUES(?,?,?,?,?,?)`, id, discountUser, "instance-"+id, "device-test", at.Format(time.RFC3339Nano), at.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
}

func (f discountFixture) offer(t *testing.T, scanID, key, productID, vendorID, title string, price, percent int, facts string) {
	t.Helper()
	if facts == "" {
		facts = "{}"
	}
	discount := price * percent / 100
	if _, err := f.db.ExecContext(context.Background(), `INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,vendor_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,2,?)`, scanID+":"+key, scanID, key, productID, vendorID, title, "Store "+vendorID, price, discount, price-discount, percent, facts); err != nil {
		t.Fatal(err)
	}
}

func requireScanCode(t *testing.T, err error, code string) {
	t.Helper()
	var failure *scans.Error
	if !errors.As(err, &failure) || failure.Code != code {
		t.Fatalf("error = %v, want %s", err, code)
	}
}

func TestProviderScansUseFifteenPercentAndAllowBothProviders(t *testing.T) {
	f := newDiscountFixture(t)
	ctx := context.Background()
	ids := make(map[string]string)
	for _, source := range []string{"snappmarket", "okala"} {
		record, err := f.queue.Enqueue(ctx, discountUser, scans.Input{LocationID: discountLocation, Source: source, Threshold: 80, Mode: "full"}, "")
		if err != nil {
			t.Fatal(err)
		}
		if record.Threshold != 15 || record.Context == nil || record.Context.EffectiveThreshold != 15 || record.Context.RequestedThreshold != 80 {
			t.Fatalf("%s collection thresholds = %+v", source, record)
		}
		ids[source] = record.ID
	}
	for source, id := range ids {
		_, err := f.queue.Enqueue(ctx, discountUser, scans.Input{LocationID: discountLocation, Source: source, Threshold: 15, Mode: "full"}, "")
		requireScanCode(t, err, "SCAN_IN_PROGRESS")
		history, err := f.queue.History(ctx, discountUser, "test-key", discountLocation, source, 50, "")
		if err != nil {
			t.Fatal(err)
		}
		if history.ActiveScan == nil || history.ActiveScan.ID != id {
			t.Fatalf("%s history active scan = %+v, want %s", source, history.ActiveScan, id)
		}
	}
	for _, percent := range []int{14, 81} {
		_, err := f.queue.Enqueue(ctx, discountUser, scans.Input{LocationID: discountLocation, Source: "okala", Threshold: percent, Mode: "full"}, "")
		requireScanCode(t, err, "INVALID_INPUT")
	}
}

type blockingDiscountCollector struct {
	started chan providers.Claim
}

func (c blockingDiscountCollector) Collect(ctx context.Context, claim providers.Claim) (providers.Completed, error) {
	c.started <- claim
	<-ctx.Done()
	return providers.Completed{}, ctx.Err()
}

func TestProviderCollectorsOverlapWithTwoSlotsAndRequeueOnShutdown(t *testing.T) {
	f := newDiscountFixture(t)
	ctx := context.Background()
	collector := blockingDiscountCollector{started: make(chan providers.Claim, 3)}
	queue, err := scans.NewQueue(f.db, collector, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	for _, source := range []string{"snappmarket", "okala"} {
		if _, err := queue.Enqueue(ctx, discountUser, scans.Input{LocationID: discountLocation, Source: source, Threshold: 15, Mode: "full"}, ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.ExecContext(ctx, `INSERT INTO locations SELECT id,'queued-user',name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision FROM locations WHERE user_id=?`, discountUser); err != nil {
		t.Fatal(err)
	}
	third, err := queue.Enqueue(ctx, "queued-user", scans.Input{LocationID: discountLocation, Source: "snappmarket", Threshold: 15, Mode: "full"}, "")
	if err != nil {
		t.Fatal(err)
	}
	workerContext, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	var runError error
	go func() {
		defer close(done)
		runError = queue.Run(workerContext)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("queue did not stop after cancellation")
		}
	})
	claims := make([]providers.Claim, 0, 2)
	for range 2 {
		select {
		case claim := <-collector.started:
			claims = append(claims, claim)
		case <-done:
			t.Fatalf("queue stopped before both collectors started: %v", runError)
		case <-time.After(5 * time.Second):
			t.Fatal("second provider did not start while the first collector was blocked")
		}
	}
	if claims[0].ScanID == claims[1].ScanID {
		t.Fatal("both collectors received the same job")
	}
	thirdRecord, err := queue.Get(ctx, "queued-user", third.ID)
	if err != nil || thirdRecord.Status != "queued" {
		t.Fatalf("third job exceeded two-worker bound: %+v, error %v", thirdRecord, err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("queue did not join collectors on shutdown")
	}
	if runError != nil {
		t.Fatal(runError)
	}
	for _, claim := range claims {
		var state string
		var failures int
		var owner sql.NullString
		if err := f.db.QueryRowContext(ctx, `SELECT state,worker_failures,owner_boot_id FROM vps_scan_jobs WHERE scan_id=?`, claim.ScanID).Scan(&state, &failures, &owner); err != nil {
			t.Fatal(err)
		}
		if state != "queued" || failures != 0 || owner.Valid {
			t.Fatalf("shutdown job = state:%s failures:%d owner:%v", state, failures, owner)
		}
	}
}

func TestProductDiscountFilterSelectsEligibleOffersAndBindsCursors(t *testing.T) {
	f := newDiscountFixture(t)
	ctx := context.Background()
	f.scan(t, "scan-filter", time.Now())
	f.offer(t, "scan-filter", "tea-low", "tea", "a", "Black tea", 100, 20, "")
	f.offer(t, "scan-filter", "tea-high", "tea", "b", "Black tea", 200, 50, "")
	f.offer(t, "scan-filter", "tea-higher", "tea", "c", "Black tea", 300, 60, "")
	f.offer(t, "scan-filter", "coffee", "coffee", "a", "Coffee", 100, 60, "")
	f.offer(t, "scan-filter", "rice", "rice", "a", "Rice", 100, 15, "")
	f.offer(t, "scan-filter", "sugar-old", "sugar", "a", "Sugar", 100, 60, `{"observedAt":"2026-01-01T00:00:00Z"}`)
	f.offer(t, "scan-filter", "sugar-new", "sugar", "a", "Sugar", 100, 20, `{"observedAt":"2026-01-02T00:00:00Z"}`)

	page, err := f.products.ProductPage(ctx, f.queue, discountUser, "scan-filter", url.Values{"minDiscount": {"50"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := productTitles(page.Items); !reflect.DeepEqual(got, []string{"Coffee", "Black tea"}) {
		t.Fatalf("50%% products = %v", got)
	}
	tea := page.Items[1]
	if tea.BestCurrentOffer == nil || tea.BestCurrentOffer.VendorID != "b" || tea.DiscountRatio != 50 || tea.FinalPriceRials != 100 || tea.CurrentStoreOfferCount != 2 {
		t.Fatalf("filtered tea = %+v", tea)
	}
	offers, err := f.products.OfferPage(ctx, f.queue, discountUser, "scan-filter", tea.Key, url.Values{"minDiscount": {"50"}})
	if err != nil || len(offers.Items) != 2 || offers.Items[0].VendorID != "b" {
		t.Fatalf("50%% offers = %+v, error %v", offers, err)
	}
	page, err = f.products.ProductPage(ctx, f.queue, discountUser, "scan-filter", url.Values{"minDiscount": {"15"}, "limit": {"1"}})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("first product page = %+v, error %v", page, err)
	}
	_, err = f.products.ProductPage(ctx, f.queue, discountUser, "scan-filter", url.Values{"minDiscount": {"50"}, "cursor": {*page.NextCursor}})
	requireScanCode(t, err, "INVALID_CURSOR")
	offers, err = f.products.OfferPage(ctx, f.queue, discountUser, "scan-filter", tea.Key, url.Values{"minDiscount": {"15"}, "limit": {"1"}})
	if err != nil || offers.NextCursor == nil {
		t.Fatalf("first offer page = %+v, error %v", offers, err)
	}
	_, err = f.products.OfferPage(ctx, f.queue, discountUser, "scan-filter", tea.Key, url.Values{"minDiscount": {"50"}, "cursor": {*offers.NextCursor}})
	requireScanCode(t, err, "INVALID_CURSOR")
	for _, value := range []string{"14", "81", "15.5", "", "no"} {
		_, err := f.products.ProductPage(ctx, f.queue, discountUser, "scan-filter", url.Values{"minDiscount": {value}})
		requireScanCode(t, err, "INVALID_INPUT")
	}
	page, err = f.products.ProductPage(ctx, f.queue, discountUser, "scan-filter", url.Values{"minDiscount": {"80"}})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("80%% page = %+v, error %v", page, err)
	}
}

func TestPersonalizedProductsRankWishlistThenOwnCartQuantity(t *testing.T) {
	f := newDiscountFixture(t)
	ctx := context.Background()
	f.scan(t, "scan-ranking", time.Now())
	f.offer(t, "scan-ranking", "tea", "tea", "a", "Black tea", 100, 20, "")
	f.offer(t, "scan-ranking", "coffee", "coffee", "a", "Coffee", 100, 70, "")
	f.offer(t, "scan-ranking", "rice", "rice", "a", "Rice", 100, 15, "")
	if _, err := f.wishlist.Add(ctx, discountUser, "Black tea", 15); err != nil {
		t.Fatal(err)
	}
	page, err := f.products.ProductPage(ctx, f.queue, discountUser, "scan-ranking", url.Values{})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Items {
		quantity := map[string]int{"Rice": 5, "Coffee": 2, "Black tea": 1}[item.Title]
		for _, user := range []string{discountUser, "another-user"} {
			if _, err := f.db.ExecContext(ctx, `INSERT INTO provider_carts(user_id,source,group_key,title,quantity,origin_scan_id,created_at,updated_at) VALUES(?,'snappmarket',?,?,?,?,?,?)`, user, item.Key, item.Title, quantity, "scan-ranking", "2026-01-01", "2026-01-01"); err != nil {
				t.Fatal(err)
			}
		}
	}
	page, err = f.products.ProductPage(ctx, f.queue, discountUser, "scan-ranking", url.Values{"sort": {"wishlist"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := productTitles(page.Items); !reflect.DeepEqual(got, []string{"Black tea", "Rice", "Coffee"}) {
		t.Fatalf("personalized ordering = %v", got)
	}
	if !page.Items[0].WishlistMatch || page.Items[1].WishlistMatch || page.Items[1].CartQuantity != 5 || page.Items[2].CartQuantity != 2 {
		t.Fatalf("personalized summary fields = %+v", page.Items)
	}
}

func TestWishlistDiscountPersistsAndIsScopedToOwner(t *testing.T) {
	f := newDiscountFixture(t)
	ctx := context.Background()
	items, err := f.wishlist.Add(ctx, discountUser, "Black tea", 80)
	if err != nil || len(items) != 1 || items[0].MinDiscount != 80 {
		t.Fatalf("add = %+v, error %v", items, err)
	}
	id := items[0].ID
	if _, err := f.wishlist.SetMinimumDiscount(ctx, discountUser, id, 15); err != nil {
		t.Fatal(err)
	}
	read, err := wishlist.New(f.db, "test-key").Read(ctx, discountUser, nil, true, false)
	if err != nil || read.Items[0].MinDiscount != 15 {
		t.Fatalf("persisted wishlist = %+v, error %v", read, err)
	}
	items, err = f.wishlist.Add(ctx, discountUser, "black tea", 60)
	if err != nil || len(items) != 1 || items[0].ID != id || items[0].MinDiscount != 60 {
		t.Fatalf("duplicate phrase = %+v, error %v", items, err)
	}
	_, err = f.wishlist.SetMinimumDiscount(ctx, "another-user", id, 40)
	var failure *wishlist.Error
	if !errors.As(err, &failure) || failure.Code != "NOT_FOUND" {
		t.Fatalf("another user's update = %v", err)
	}
	for _, percent := range []int{14, 81} {
		_, err = f.wishlist.SetMinimumDiscount(ctx, discountUser, id, percent)
		if !errors.As(err, &failure) || failure.Code != "INVALID_DISCOUNT" {
			t.Fatalf("discount %d = %v", percent, err)
		}
	}
	if _, err := f.db.ExecContext(ctx, `INSERT INTO wishlist_items(id,user_id,phrase,normalized_phrase,tokens_json,created_at) VALUES('legacy',?,'Rice','rice','["rice"]','2026-01-01T00:00:00Z')`, discountUser); err != nil {
		t.Fatal(err)
	}
	read, err = f.wishlist.Read(ctx, discountUser, nil, true, false)
	if err != nil || read.Items[0].MinDiscount != 15 {
		t.Fatalf("existing wishlist default = %+v, error %v", read, err)
	}
}

func TestNotificationsApplyEachWishlistDiscountBeforeSelectingProducts(t *testing.T) {
	f := newDiscountFixture(t)
	ctx := context.Background()
	for phrase, minimum := range map[string]int{"Tea": 50, "Coffee": 80, "Rice": 15} {
		if _, err := f.wishlist.Add(ctx, discountUser, phrase, minimum); err != nil {
			t.Fatal(err)
		}
	}
	at := time.Now().Add(time.Minute)
	f.scan(t, "scan-notifications", at)
	for i := range 4 {
		f.offer(t, "scan-notifications", fmt.Sprintf("low-%d", i), fmt.Sprintf("low-%d", i), "a", "Tea cheap", 10, 20, "")
	}
	f.offer(t, "scan-notifications", "tea-low", "tea", "a", "Tea selected", 100, 20, "")
	f.offer(t, "scan-notifications", "tea-high", "tea", "b", "Tea selected", 250, 60, "")
	f.offer(t, "scan-notifications", "coffee", "coffee", "a", "Coffee", 100, 60, "")
	f.offer(t, "scan-notifications", "rice", "rice", "a", "Rice", 100, 15, "")
	maintainer := wishlist.NewMaintainer(f.wishlist, f.queue, f.products, false, false, wishlist.PushConfig{})
	for range 2 {
		if err := maintainer.ProcessScan(ctx, discountUser, "scan-notifications", at); err != nil {
			t.Fatal(err)
		}
	}
	notifications, err := f.wishlist.Notifications(ctx, discountUser)
	if err != nil || len(notifications) != 1 {
		t.Fatalf("notifications = %+v, error %v", notifications, err)
	}
	matches := make(map[string]wishlist.Match)
	for _, match := range notifications[0].Matches {
		matches[match.Phrase] = match
	}
	if len(matches) != 2 || matches["Tea"].Title != "Tea selected" || matches["Tea"].DiscountPercent != 60 || matches["Tea"].Price != 100 || matches["Rice"].DiscountPercent != 15 {
		t.Fatalf("per-phrase eligible matches = %+v", matches)
	}
}

func productTitles(items []products.ProductSummary) []string {
	titles := make([]string, 0, len(items))
	for _, item := range items {
		titles = append(titles, item.Title)
	}
	return titles
}
