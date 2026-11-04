package wishlist

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

const (
	reconcileInterval   = time.Minute
	scheduleInterval    = time.Minute
	maintenanceInterval = 5 * time.Minute
	jobBudget           = 8
	jobFreshness        = 2 * time.Hour
	tickRetention       = 14 * 24 * time.Hour
)

type PushConfig struct {
	PublicKey  string
	PrivateKey string
	Subject    string
}

type Maintainer struct {
	store            *Service
	queue            *scans.Queue
	catalog          ProductCatalog
	scheduleEnabled  bool
	rateLimitCleanup bool
	push             PushConfig
	client           *http.Client
}

func NewMaintainer(store *Service, queue *scans.Queue, catalog ProductCatalog, scheduleEnabled, rateLimitCleanup bool, push PushConfig) *Maintainer {
	return &Maintainer{
		store:            store,
		queue:            queue,
		catalog:          catalog,
		scheduleEnabled:  scheduleEnabled,
		rateLimitCleanup: rateLimitCleanup,
		push:             push,
		client: &http.Client{
			Timeout:       5 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

func (m *Maintainer) Run(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var nextReconcile, nextSchedule, nextMaintenance time.Time
	for {
		now := time.Now().UTC()
		if !now.Before(nextReconcile) {
			bucket := now.Truncate(reconcileInterval)
			m.runMaintenanceTick(ctx, "scan-reconciliation", bucket, m.queue.Reconcile)
			nextReconcile = now.Add(reconcileInterval)
		}
		if m.scheduleEnabled && !now.Before(nextSchedule) {
			if err := m.runSchedule(ctx, now); err != nil && ctx.Err() == nil {
				slog.Error("wishlist schedule failed", "error", err)
			}
			nextSchedule = now.Add(scheduleInterval)
		}
		if !now.Before(nextMaintenance) {
			bucket := now.Truncate(maintenanceInterval)
			m.runMaintenanceTick(ctx, "wishlist-notifications", bucket, func(ctx context.Context) error {
				if err := m.processPendingNotifications(ctx, now); err != nil {
					return err
				}
				return m.drainPushDeliveries(ctx, now, nil)
			})
			m.runMaintenanceTick(ctx, "okala-offer-cache", bucket, func(ctx context.Context) error {
				return m.cleanupOkalaOfferCache(ctx, now)
			})
			if m.rateLimitCleanup {
				m.runMaintenanceTick(ctx, "rate-limit-cleanup", bucket, func(ctx context.Context) error {
					return m.cleanupRateLimits(ctx, now)
				})
			}
			m.runMaintenanceTick(ctx, "vps-tick-cleanup", bucket, func(ctx context.Context) error {
				_, err := m.store.db.ExecContext(ctx, `DELETE FROM vps_maintenance_ticks WHERE updated_at < ?`, isoTime(now.Add(-tickRetention)))
				return err
			})
			nextMaintenance = now.Add(maintenanceInterval)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (m *Maintainer) runMaintenanceTick(ctx context.Context, task string, scheduledAt time.Time, operation func(context.Context) error) {
	timestamp := isoTime(scheduledAt)
	nowText := isoTime(time.Now())
	if _, err := m.store.db.ExecContext(ctx, `INSERT OR IGNORE INTO vps_maintenance_ticks(task,scheduled_at,state,updated_at) VALUES(?,?,'running',?)`, task, timestamp, nowText); err != nil {
		slog.Error("maintenance tick claim failed", "task", task, "error", err)
		return
	}
	var state string
	if err := m.store.db.QueryRowContext(ctx, `SELECT state FROM vps_maintenance_ticks WHERE task=? AND scheduled_at=?`, task, timestamp).Scan(&state); err != nil {
		slog.Error("maintenance tick read failed", "task", task, "error", err)
		return
	}
	if state == "complete" {
		return
	}
	if _, err := m.store.db.ExecContext(ctx, `UPDATE vps_maintenance_ticks SET state='running',updated_at=? WHERE task=? AND scheduled_at=?`, nowText, task, timestamp); err != nil {
		slog.Error("maintenance tick start failed", "task", task, "error", err)
		return
	}
	if err := operation(ctx); err != nil {
		_, _ = m.store.db.ExecContext(context.Background(), `UPDATE vps_maintenance_ticks SET state='failed',updated_at=? WHERE task=? AND scheduled_at=?`, isoTime(time.Now()), task, timestamp)
		slog.Error("maintenance task failed", "task", task, "error", err)
		return
	}
	if _, err := m.store.db.ExecContext(context.Background(), `UPDATE vps_maintenance_ticks SET state='complete',updated_at=? WHERE task=? AND scheduled_at=?`, isoTime(time.Now()), task, timestamp); err != nil {
		slog.Error("maintenance tick completion failed", "task", task, "error", err)
	}
}

func (m *Maintainer) cleanupOkalaOfferCache(ctx context.Context, now time.Time) error {
	nowText := isoTime(now)
	_, err := m.store.db.ExecContext(ctx, `DELETE FROM okala_offer_cache WHERE request_key IN (
		SELECT request_key FROM okala_offer_cache
		WHERE (reusable_until IS NOT NULL AND reusable_until<=?) OR (lease_until IS NOT NULL AND lease_until<=?)
		ORDER BY updated_at LIMIT 100
	)`, nowText, nowText)
	if err != nil {
		return err
	}
	return nil
}

func (m *Maintainer) cleanupRateLimits(ctx context.Context, now time.Time) error {
	if _, err := m.store.db.ExecContext(ctx, `DELETE FROM api_rate_limits WHERE rowid IN (
		SELECT rowid FROM api_rate_limits WHERE window_start < ? ORDER BY window_start LIMIT 1000
	)`, now.Add(-24*time.Hour).UnixMilli()); err != nil {
		return err
	}
	return nil
}

func (m *Maintainer) ProcessScan(ctx context.Context, userID, scanID string, now time.Time) error {
	return m.store.notifyScan(ctx, m.queue, m.catalog, userID, scanID, now)
}

func (m *Maintainer) DrainForScan(ctx context.Context, userID, scanID string, now time.Time) error {
	return m.drainPushDeliveries(ctx, now, &deliveryScope{userID: userID, scanID: scanID})
}

func (s *Service) notifyScan(ctx context.Context, queue *scans.Queue, catalog ProductCatalog, userID, scanID string, at time.Time) error {
	scan, err := queue.Get(ctx, userID, scanID)
	if err != nil {
		return err
	}
	if scan.Status != "succeeded" || (scan.Source != "snappmarket" && scan.Source != "okala") {
		return nil
	}
	token, err := newID()
	if err != nil {
		return err
	}
	now := at.UTC()
	nowText := isoTime(now)
	leaseUntil := isoTime(now.Add(2 * time.Minute))
	var claimed string
	err = s.db.QueryRowContext(ctx, `INSERT INTO wishlist_scan_receipts(scan_id,lease_token,lease_until) VALUES(?,?,?)
		ON CONFLICT(scan_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
		WHERE completed=0 AND lease_until<=? RETURNING scan_id`, scanID, token, leaseUntil, nowText).Scan(&claimed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	completed := false
	defer func() {
		if !completed {
			_, _ = s.db.ExecContext(context.Background(), "DELETE FROM wishlist_scan_receipts WHERE scan_id=? AND lease_token=? AND completed=0", scanID, token)
		}
	}()
	groups, _, err := catalog.ProductGroups(ctx, queue, userID, scanID)
	if err != nil {
		return err
	}
	items, err := s.scanWishlistItems(ctx, userID, scan.CreatedAt)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return s.completeReceipt(ctx, scanID, token, &completed)
	}
	scope, err := scanScope(scan)
	if err != nil {
		return err
	}
	matches := make([]Match, 0)
	observations := make([]seenObservation, 0)
	for _, item := range items {
		var tokens []string
		if err := json.Unmarshal([]byte(item.tokens), &tokens); err != nil {
			return err
		}
		type candidate struct {
			product products.Group
			offer   products.VendorOffer
		}
		candidates := make([]candidate, 0)
		for _, group := range groups {
			if !hasAllTokens(products.NormalizeSearchText(group.Title), tokens) {
				continue
			}
			for _, offer := range group.Vendors {
				if offer.State != "no_longer_present" && offer.Stock > 0 && offer.DiscountRatio >= float64(item.minDiscount) {
					candidates = append(candidates, candidate{product: group, offer: offer})
					break
				}
			}
		}
		sort.Slice(candidates, func(i, j int) bool {
			if candidates[i].offer.FinalPriceRials != candidates[j].offer.FinalPriceRials {
				return candidates[i].offer.FinalPriceRials < candidates[j].offer.FinalPriceRials
			}
			return candidates[i].product.Key < candidates[j].product.Key
		})
		if len(candidates) > 3 {
			candidates = candidates[:3]
		}
		for _, candidate := range candidates {
			product, offer := candidate.product, candidate.offer
			observations = append(observations, seenObservation{wishlistID: item.id, productID: offer.ProductVariationID, price: offer.FinalPriceRials})
			var previous sql.NullFloat64
			err := s.db.QueryRowContext(ctx, "SELECT price FROM wishlist_seen WHERE user_id=? AND wishlist_id=? AND scope=? AND product_id=?", userID, item.id, scope, offer.ProductVariationID).Scan(&previous)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if previous.Valid && offer.FinalPriceRials >= previous.Float64 {
				continue
			}
			matches = append(matches, Match{Phrase: item.phrase, Title: product.Title, Price: offer.FinalAmountToman, DiscountPercent: offer.DiscountRatio, URL: "/?scan=" + url.QueryEscape(scanID), Source: scan.Source})
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stillOwned int
	err = tx.QueryRowContext(ctx, "SELECT 1 FROM wishlist_scan_receipts WHERE scan_id=? AND lease_token=? AND completed=0", scanID, token).Scan(&stillOwned)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(matches) > 0 {
		phrases := make([]string, 0)
		seenPhrases := make(map[string]struct{})
		for _, match := range matches {
			if _, ok := seenPhrases[match.Phrase]; ok {
				continue
			}
			seenPhrases[match.Phrase] = struct{}{}
			phrases = append(phrases, match.Phrase)
		}
		body := strings.Join(phrases, "، ")
		notificationID := "wishlist:" + scanID
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO wishlist_notifications(id,user_id,scan_id,location_id,title,body,matches_json,created_at)
			SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wishlist_scan_receipts WHERE scan_id=? AND lease_token=? AND completed=0)`,
			notificationID, userID, scanID, scan.LocationID, "پیشنهادهای فهرست علاقه‌مندی شما", body, mustJSON(matches), nowText, scanID, token)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO wishlist_push_deliveries(notification_id,subscription_id,user_id,next_attempt_at)
			SELECT ?,id,user_id,? FROM push_subscriptions WHERE user_id=? AND EXISTS(SELECT 1 FROM wishlist_scan_receipts WHERE scan_id=? AND lease_token=? AND completed=0)`, notificationID, nowText, userID, scanID, token)
		if err != nil {
			return err
		}
	}
	for _, observation := range observations {
		_, err = tx.ExecContext(ctx, `INSERT INTO wishlist_seen(user_id,wishlist_id,scope,product_id,price)
			SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM wishlist_scan_receipts WHERE scan_id=? AND lease_token=? AND completed=0)
			AND EXISTS(SELECT 1 FROM wishlist_items WHERE id=? AND user_id=?)
			ON CONFLICT(user_id,wishlist_id,scope,product_id) DO UPDATE SET price=excluded.price`,
			userID, observation.wishlistID, scope, observation.productID, observation.price, scanID, token, observation.wishlistID, userID)
		if err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "UPDATE wishlist_scan_receipts SET completed=1 WHERE scan_id=? AND lease_token=?", scanID, token); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	completed = true
	return nil
}

type wishlistItem struct {
	id          string
	phrase      string
	tokens      string
	created     string
	minDiscount int
}

type seenObservation struct {
	wishlistID string
	productID  string
	price      float64
}

func (s *Service) scanWishlistItems(ctx context.Context, userID, scanCreated string) ([]wishlistItem, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,phrase,tokens_json,created_at,min_discount FROM wishlist_items WHERE user_id=? ORDER BY created_at,id LIMIT 30", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scanAt, err := time.Parse(time.RFC3339Nano, scanCreated)
	if err != nil {
		return nil, err
	}
	items := make([]wishlistItem, 0)
	for rows.Next() {
		var item wishlistItem
		if err := rows.Scan(&item.id, &item.phrase, &item.tokens, &item.created, &item.minDiscount); err != nil {
			return nil, err
		}
		createdAt, err := time.Parse(time.RFC3339Nano, item.created)
		if err != nil {
			return nil, err
		}
		if !createdAt.After(scanAt) {
			items = append(items, item)
		}
	}
	return items, rows.Err()
}

func (s *Service) completeReceipt(ctx context.Context, scanID, token string, completed *bool) error {
	result, err := s.db.ExecContext(ctx, "UPDATE wishlist_scan_receipts SET completed=1 WHERE scan_id=? AND lease_token=?", scanID, token)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err == nil && changed > 0 {
		*completed = true
	}
	return err
}

func scanScope(scan scans.Record) (string, error) {
	var revision, latitude, longitude any
	if scan.Context != nil {
		revision = scan.Context.Location.Revision
		latitude = scan.Context.Location.Latitude
		longitude = scan.Context.Location.Longitude
	}
	value, err := json.Marshal([]any{scan.Source, scan.LocationID, revision, latitude, longitude})
	return string(value), err
}

func (m *Maintainer) processPendingNotifications(ctx context.Context, now time.Time) error {
	nowText := isoTime(now)
	cutoff := isoTime(now.Add(-24 * time.Hour))
	rows, err := m.store.db.QueryContext(ctx, `SELECT s.id,s.user_id FROM scans s WHERE s.status='succeeded' AND s.source IN ('snappmarket','okala') AND s.finished_at>=?
		AND EXISTS(SELECT 1 FROM wishlist_items wi WHERE wi.user_id=s.user_id AND wi.created_at<=s.created_at)
		AND NOT EXISTS(SELECT 1 FROM wishlist_scan_receipts r WHERE r.scan_id=s.id AND (r.completed=1 OR r.lease_until>?))
		ORDER BY s.finished_at,s.id LIMIT 2`, cutoff, nowText)
	if err != nil {
		return err
	}
	type pendingScan struct{ id, userID string }
	pending := make([]pendingScan, 0, 2)
	for rows.Next() {
		var scan pendingScan
		if err := rows.Scan(&scan.id, &scan.userID); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, scan)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, scan := range pending {
		if err := m.store.notifyScan(ctx, m.queue, m.catalog, scan.userID, scan.id, now); err != nil {
			slog.Error("wishlist scan notification processing failed", "scanId", scan.id, "error", err)
		}
	}
	return nil
}

func (m *Maintainer) drainPushDeliveries(ctx context.Context, now time.Time, scope *deliveryScope) error {
	if m.push.PublicKey == "" || m.push.PrivateKey == "" || m.push.Subject == "" {
		return nil
	}
	nowText := isoTime(now)
	query := `SELECT d.notification_id,d.subscription_id,d.user_id,d.attempts,s.encrypted_subscription,n.title,n.body
		FROM wishlist_push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id AND s.user_id=d.user_id
		JOIN wishlist_notifications n ON n.id=d.notification_id AND n.user_id=d.user_id
		WHERE d.delivered_at IS NULL AND d.attempts<5 AND d.next_attempt_at<=? AND (d.lease_until IS NULL OR d.lease_until<=?)`
	args := []any{nowText, nowText}
	if scope != nil {
		query += " AND d.user_id=? AND n.scan_id=?"
		args = append(args, scope.userID, scope.scanID)
	}
	query += " ORDER BY d.next_attempt_at LIMIT 5"
	rows, err := m.store.db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	deliveries := make([]delivery, 0, 5)
	for rows.Next() {
		var item delivery
		if err := rows.Scan(&item.notificationID, &item.subscriptionID, &item.userID, &item.attempts, &item.encrypted, &item.title, &item.body); err != nil {
			rows.Close()
			return err
		}
		deliveries = append(deliveries, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range deliveries {
		if err := m.deliver(ctx, now, item); err != nil {
			slog.Error("push notification delivery failed", "notificationId", item.notificationID, "error", err)
		}
	}
	return nil
}

type deliveryScope struct{ userID, scanID string }

type delivery struct {
	notificationID string
	subscriptionID string
	userID         string
	attempts       int
	encrypted      string
	title          string
	body           string
}

func (m *Maintainer) deliver(ctx context.Context, now time.Time, item delivery) error {
	token, err := newID()
	if err != nil {
		return err
	}
	nowText := isoTime(now)
	leaseUntil := isoTime(now.Add(2 * time.Minute))
	var claimed string
	err = m.store.db.QueryRowContext(ctx, `UPDATE wishlist_push_deliveries SET lease_token=?,lease_until=?,attempts=attempts+1
		WHERE notification_id=? AND subscription_id=? AND delivered_at IS NULL AND attempts<5 AND (lease_until IS NULL OR lease_until<=?) RETURNING notification_id`, token, leaseUntil, item.notificationID, item.subscriptionID, nowText).Scan(&claimed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var subscription pushSubscription
	clear, err := decrypt(item.encrypted, m.store.boxKey, "push:"+item.userID+":"+item.subscriptionID)
	if err == nil {
		err = json.Unmarshal(clear, &subscription)
	}
	if err == nil && !validSubscription(subscription) {
		err = errors.New("stored push subscription is invalid")
	}
	if err == nil {
		body := item.body
		if len([]rune(body)) > 250 {
			body = string([]rune(body)[:250])
		}
		payload, marshalErr := json.Marshal(map[string]string{
			"id":    item.notificationID,
			"title": item.title,
			"body":  body,
			"url":   "/?notification=" + url.QueryEscape(item.notificationID),
		})
		if marshalErr != nil {
			err = marshalErr
		} else {
			requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			response, sendErr := webpush.SendNotificationWithContext(requestCtx, payload, &webpush.Subscription{Endpoint: subscription.Endpoint, Keys: webpush.Keys{P256dh: subscription.Keys.P256DH, Auth: subscription.Keys.Auth}}, &webpush.Options{
				HTTPClient: m.client, Subscriber: m.push.Subject, VAPIDPublicKey: m.push.PublicKey, VAPIDPrivateKey: m.push.PrivateKey, TTL: 3600, Urgency: webpush.UrgencyNormal,
			})
			cancel()
			err = sendErr
			if response != nil {
				_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
				_ = response.Body.Close()
				if response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound {
					_, deleteErr := m.store.db.ExecContext(ctx, "DELETE FROM push_subscriptions WHERE id=? AND user_id=?", item.subscriptionID, item.userID)
					return deleteErr
				}
				if response.StatusCode < 200 || response.StatusCode >= 300 {
					err = fmt.Errorf("push endpoint returned status %d", response.StatusCode)
				}
			}
		}
	}
	if err == nil {
		_, err = m.store.db.ExecContext(ctx, "UPDATE wishlist_push_deliveries SET delivered_at=?,lease_token=NULL,lease_until=NULL WHERE notification_id=? AND subscription_id=? AND lease_token=?", nowText, item.notificationID, item.subscriptionID, token)
		return err
	}
	delay := time.Duration(300_000*math.Pow(2, float64(item.attempts))) * time.Millisecond
	_, updateErr := m.store.db.ExecContext(ctx, "UPDATE wishlist_push_deliveries SET next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE notification_id=? AND subscription_id=? AND lease_token=?", isoTime(now.Add(delay)), item.notificationID, item.subscriptionID, token)
	if updateErr != nil {
		return updateErr
	}
	return err
}

func decrypt(value, secret, aad string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(boxKey(secret))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < gcm.NonceSize()+gcm.Overhead() {
		return nil, errors.New("encrypted subscription is truncated")
	}
	return gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], []byte(aad))
}

func hasAllTokens(title string, tokens []string) bool {
	for _, token := range tokens {
		if token != "" && !strings.Contains(title, token) {
			return false
		}
	}
	return len(tokens) > 0
}

func isoTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func mustJSON(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}
