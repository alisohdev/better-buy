package wishlist

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string { return e.Code }

type Item struct {
	ID          string `json:"id"`
	Phrase      string `json:"phrase"`
	MinDiscount int    `json:"minDiscount"`
	CreatedAt   string `json:"createdAt"`
}

type Match struct {
	Phrase          string  `json:"phrase"`
	Title           string  `json:"title"`
	Price           float64 `json:"price"`
	DiscountPercent float64 `json:"discountPercent"`
	URL             string  `json:"url"`
	Source          string  `json:"source"`
}

type Notification struct {
	ID         string  `json:"id"`
	ScanID     string  `json:"scanId"`
	LocationID string  `json:"locationId"`
	Title      string  `json:"title"`
	Body       string  `json:"body"`
	Matches    []Match `json:"matches"`
	CreatedAt  string  `json:"createdAt"`
	ReadAt     *string `json:"readAt"`
}

type Snapshot struct {
	Items             []Item  `json:"items"`
	DefaultLocationID *string `json:"defaultLocationId"`
	PushPublicKey     *string `json:"pushPublicKey"`
	ScheduleEnabled   bool    `json:"scheduleEnabled"`
	DevScanEnabled    bool    `json:"devScanEnabled"`
}

type pushSubscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
	ExpirationTime *int64 `json:"expirationTime"`
}

type Service struct {
	db     *sql.DB
	boxKey string
}

type ProductCatalog interface {
	ProductGroups(context.Context, *scans.Queue, string, string) ([]products.Group, *scans.Record, error)
}

func New(db *sql.DB, boxKey string) *Service { return &Service{db: db, boxKey: boxKey} }

func (s *Service) Read(ctx context.Context, userID string, publicKey *string, scheduleEnabled, devEnabled bool) (Snapshot, error) {
	items, err := s.items(ctx, userID)
	if err != nil {
		return Snapshot{}, err
	}
	var location sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT p.default_location_id FROM wishlist_preferences p JOIN locations l ON l.id=p.default_location_id AND l.user_id=p.user_id WHERE p.user_id=?`, userID).Scan(&location)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Snapshot{}, err
	}
	var locationID *string
	if location.Valid {
		locationID = &location.String
	}
	return Snapshot{Items: items, DefaultLocationID: locationID, PushPublicKey: publicKey, ScheduleEnabled: scheduleEnabled, DevScanEnabled: devEnabled}, nil
}

func (s *Service) Add(ctx context.Context, userID, phrase string, minDiscount int) ([]Item, error) {
	phrase = strings.TrimSpace(phrase)
	if !discounts.Valid(minDiscount) {
		return nil, &Error{Code: "INVALID_DISCOUNT", Status: 400}
	}
	if runeLen(phrase) < 2 || runeLen(phrase) > 120 {
		return nil, &Error{Code: "INVALID_INPUT", Status: 400}
	}
	normalized := products.NormalizeSearchText(phrase)
	tokens := strings.Fields(normalized)
	if runeLen(normalized) < 2 || len(tokens) == 0 {
		return nil, &Error{Code: "INVALID_INPUT", Status: 400}
	}
	encodedTokens, err := json.Marshal(tokens)
	if err != nil {
		return nil, err
	}
	id, err := newID()
	if err != nil {
		return nil, err
	}
	var inserted string
	err = s.db.QueryRowContext(ctx, `INSERT INTO wishlist_items(id,user_id,phrase,normalized_phrase,tokens_json,min_discount,created_at)
		SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM wishlist_items WHERE user_id=?)<30 OR EXISTS(SELECT 1 FROM wishlist_items WHERE user_id=? AND normalized_phrase=?)
		ON CONFLICT(user_id,normalized_phrase) DO UPDATE SET min_discount=excluded.min_discount RETURNING id`,
		id, userID, phrase, normalized, string(encodedTokens), minDiscount, time.Now().UTC().Format(time.RFC3339Nano), userID, userID, normalized).Scan(&inserted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, &Error{Code: "WISHLIST_LIMIT", Status: 409}
	}
	if err != nil {
		return nil, err
	}
	return s.items(ctx, userID)
}

func (s *Service) SetMinimumDiscount(ctx context.Context, userID, itemID string, minDiscount int) ([]Item, error) {
	if !discounts.Valid(minDiscount) {
		return nil, &Error{Code: "INVALID_DISCOUNT", Status: 400}
	}
	result, err := s.db.ExecContext(ctx, `UPDATE wishlist_items SET min_discount=? WHERE user_id=? AND id=?`, minDiscount, userID, itemID)
	if err != nil {
		return nil, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if changed == 0 {
		return nil, &Error{Code: "NOT_FOUND", Status: 404}
	}
	return s.items(ctx, userID)
}

func (s *Service) Delete(ctx context.Context, userID, itemID string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM wishlist_items WHERE user_id=? AND id=?", userID, itemID)
	return err
}

func (s *Service) SetLocation(ctx context.Context, userID string, locationID *string) error {
	if locationID != nil {
		var latitude, longitude float64
		err := s.db.QueryRowContext(ctx, "SELECT latitude,longitude FROM locations WHERE user_id=? AND id=?", userID, *locationID).Scan(&latitude, &longitude)
		if errors.Is(err, sql.ErrNoRows) {
			return &Error{Code: "NOT_FOUND", Status: 404}
		}
		if err != nil {
			return err
		}
		if !withinTehran(latitude, longitude) {
			return &Error{Code: "OUTSIDE_TEHRAN", Status: 422}
		}
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO wishlist_preferences(user_id,default_location_id,updated_at) VALUES(?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET default_location_id=excluded.default_location_id,updated_at=excluded.updated_at`, userID, locationID, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (s *Service) Notifications(ctx context.Context, userID string) ([]Notification, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,scan_id,location_id,title,body,matches_json,created_at,read_at FROM wishlist_notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 50", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Notification, 0)
	for rows.Next() {
		var item Notification
		var matches string
		if err := rows.Scan(&item.ID, &item.ScanID, &item.LocationID, &item.Title, &item.Body, &matches, &item.CreatedAt, &item.ReadAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(matches), &item.Matches); err != nil {
			return nil, err
		}
		if item.Matches == nil {
			item.Matches = []Match{}
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Service) ReceiptCompleted(ctx context.Context, scanID string) (bool, error) {
	var completed int
	err := s.db.QueryRowContext(ctx, "SELECT completed FROM wishlist_scan_receipts WHERE scan_id=?", scanID).Scan(&completed)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return completed == 1, err
}

func (s *Service) NotificationForScan(ctx context.Context, userID, scanID string) (*Notification, error) {
	var item Notification
	var matches string
	err := s.db.QueryRowContext(ctx, "SELECT id,scan_id,location_id,title,body,matches_json,created_at,read_at FROM wishlist_notifications WHERE user_id=? AND scan_id=?", userID, scanID).Scan(
		&item.ID, &item.ScanID, &item.LocationID, &item.Title, &item.Body, &matches, &item.CreatedAt, &item.ReadAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(matches), &item.Matches); err != nil {
		return nil, err
	}
	if item.Matches == nil {
		item.Matches = []Match{}
	}
	return &item, nil
}

func (s *Service) PushDeliveryCounts(ctx context.Context, userID, notificationID string) (int, int, error) {
	var total, pending int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*),COALESCE(SUM(CASE WHEN delivered_at IS NULL THEN 1 ELSE 0 END),0) FROM wishlist_push_deliveries WHERE user_id=? AND notification_id=?", userID, notificationID).Scan(&total, &pending)
	return total, pending, err
}

func (s *Service) MarkNotificationRead(ctx context.Context, userID, notificationID string) error {
	_, err := s.db.ExecContext(ctx, "UPDATE wishlist_notifications SET read_at=COALESCE(read_at,?) WHERE user_id=? AND id=?", time.Now().UTC().Format(time.RFC3339Nano), userID, notificationID)
	return err
}

func (s *Service) SavePushSubscription(ctx context.Context, userID string, input []byte) (bool, error) {
	var subscription pushSubscription
	if err := json.Unmarshal(input, &subscription); err != nil || !validSubscription(subscription) {
		return false, &Error{Code: "INVALID_SUBSCRIPTION", Status: 400}
	}
	subscription.ExpirationTime = nil
	id := subscriptionID(subscription.Endpoint)
	clear, err := json.Marshal(subscription)
	if err != nil {
		return false, err
	}
	encrypted, err := encrypt(clear, s.boxKey, "push:"+userID+":"+id)
	if err != nil {
		return false, err
	}
	var saved string
	err = s.db.QueryRowContext(ctx, `INSERT INTO push_subscriptions(id,user_id,encrypted_subscription,created_at)
		SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?)<5 OR EXISTS(SELECT 1 FROM push_subscriptions WHERE user_id=? AND id=?)
		ON CONFLICT(id) DO UPDATE SET encrypted_subscription=excluded.encrypted_subscription WHERE user_id=excluded.user_id RETURNING id`,
		id, userID, encrypted, time.Now().UTC().Format(time.RFC3339Nano), userID, userID, id).Scan(&saved)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Service) DeletePushSubscription(ctx context.Context, userID, endpoint string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM push_subscriptions WHERE user_id=? AND id=?", userID, subscriptionID(endpoint))
	return err
}

func (s *Service) items(ctx context.Context, userID string) ([]Item, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id,phrase,min_discount,created_at FROM wishlist_items WHERE user_id=? ORDER BY created_at,id", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Item, 0)
	for rows.Next() {
		var item Item
		if err := rows.Scan(&item.ID, &item.Phrase, &item.MinDiscount, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func validSubscription(subscription pushSubscription) bool {
	parsed, err := url.Parse(subscription.Endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.Fragment != "" || len(subscription.Endpoint) > 2048 {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	validHost := host == "fcm.googleapis.com" || host == "web.push.apple.com" || host == "updates.push.services.mozilla.com" || strings.HasSuffix(host, ".push.services.mozilla.com") || strings.HasSuffix(host, ".notify.windows.com")
	if !validHost {
		return false
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(subscription.Keys.P256DH)
	if err != nil || len(publicKey) != 65 || publicKey[0] != 4 {
		return false
	}
	auth, err := base64.RawURLEncoding.DecodeString(subscription.Keys.Auth)
	return err == nil && len(auth) == 16
}

func subscriptionID(endpoint string) string {
	digest := sha256.Sum256([]byte(endpoint))
	return hex.EncodeToString(digest[:])
}

func encrypt(plaintext []byte, secret, aad string) (string, error) {
	block, err := aes.NewCipher(boxKey(secret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, plaintext, []byte(aad))
	return base64.StdEncoding.EncodeToString(append(iv, sealed...)), nil
}

func boxKey(secret string) []byte {
	if len(secret) == 64 {
		if decoded, err := hex.DecodeString(secret); err == nil && len(decoded) == 32 {
			return decoded
		}
	}
	material := []byte(secret)
	if len(material) > 32 {
		material = material[:32]
	}
	for len(material) < 32 {
		material = append(material, '0')
	}
	return material
}

func newID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	value := hex.EncodeToString(bytes[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", value[:8], value[8:12], value[12:16], value[16:20], value[20:]), nil
}

func withinTehran(latitude, longitude float64) bool {
	return latitude >= 35.56 && latitude <= 35.82 && longitude >= 51.18 && longitude <= 51.66
}

func runeLen(value string) int { return len([]rune(value)) }
