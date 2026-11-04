package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"github.com/alirezasoheili/better-buy/apps/api/internal/wishlist"
)

var devTimestampPattern = regexp.MustCompile(`^\d{13}$`)
var devSignaturePattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func registerDevWishlist(mux *http.ServeMux, db *sql.DB, cfg config.Config, authService *auth.Service, queue *scans.Queue, store *wishlist.Service) {
	catalog := products.New(db, cfg.BoxKey)
	maintainer := wishlist.NewMaintainer(store, queue, catalog, false, cfg.APIRateLimitsEnabled, wishlist.PushConfig{PublicKey: cfg.VAPIDPublicKey, PrivateKey: cfg.VAPIDPrivateKey, Subject: cfg.VAPIDSubject})
	mux.Handle("POST /api/wishlist/dev-scan/start", requireIdentity(authService, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !cfg.DevMode {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		if !browserDevWishlistAllowed(r, cfg.CORSOrigins) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "INVALID_ORIGIN"})
			return
		}
		var body struct {
			Source string `json:"source"`
			Key    string `json:"key"`
		}
		if decodeJSON(r, &body) != nil || !validDevScanInput(body.Source, body.Key) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		userID := requestIdentity(r).User.ID
		locationID, err := wishlistTarget(r, db, userID)
		if err != nil {
			writeWishlistStartError(w, err)
			return
		}
		item, err := queue.Enqueue(r.Context(), userID, wishlistScanInput(locationID, body.Source), body.Key)
		if err != nil {
			writeScanError(w, queue, r, userID, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"data": map[string]string{"scanId": item.ID, "status": item.Status}})
	})))
	mux.Handle("POST /api/wishlist/dev-scan/status", requireIdentity(authService, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !cfg.DevMode {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		if !browserDevWishlistAllowed(r, cfg.CORSOrigins) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "INVALID_ORIGIN"})
			return
		}
		var body struct {
			ScanID string `json:"scanId"`
		}
		if decodeJSON(r, &body) != nil || !scans.ValidUUID(body.ScanID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		writeDevWishlistStatus(w, r, queue, store, maintainer, cfg, requestIdentity(r).User.ID, body.ScanID)
	})))
	mux.HandleFunc("POST /api/dev/wishlist/start", func(w http.ResponseWriter, r *http.Request) {
		if !cfg.DevMode {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		bodyBytes, err := readRequestBody(r)
		if err != nil || !validDevWishlistRequest(r, bodyBytes, cfg.BetterAuthSecret) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		var body struct {
			UserID string `json:"userId"`
			Source string `json:"source"`
			Key    string `json:"key"`
		}
		if decodeFlexibleBytes(bodyBytes, &body) != nil || !validDevScanInput(body.Source, body.Key) || strings.TrimSpace(body.UserID) == "" || len([]rune(strings.TrimSpace(body.UserID))) > 200 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		userID := strings.TrimSpace(body.UserID)
		locationID, err := wishlistTarget(r, db, userID)
		if err != nil {
			writeWishlistStartError(w, err)
			return
		}
		item, err := queue.Enqueue(r.Context(), userID, wishlistScanInput(locationID, body.Source), body.Key)
		if err != nil {
			writeScanError(w, queue, r, userID, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"data": map[string]string{"scanId": item.ID, "status": item.Status}})
	})
	mux.HandleFunc("POST /api/dev/wishlist/status", func(w http.ResponseWriter, r *http.Request) {
		if !cfg.DevMode {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		bodyBytes, err := readRequestBody(r)
		if err != nil || !validDevWishlistRequest(r, bodyBytes, cfg.BetterAuthSecret) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		var body struct {
			UserID string `json:"userId"`
			ScanID string `json:"scanId"`
		}
		if decodeFlexibleBytes(bodyBytes, &body) != nil || strings.TrimSpace(body.UserID) == "" || len([]rune(strings.TrimSpace(body.UserID))) > 200 || !scans.ValidUUID(body.ScanID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		writeDevWishlistStatus(w, r, queue, store, maintainer, cfg, strings.TrimSpace(body.UserID), body.ScanID)
	})
}

func writeDevWishlistStatus(w http.ResponseWriter, r *http.Request, queue *scans.Queue, store *wishlist.Service, maintainer *wishlist.Maintainer, cfg config.Config, userID, scanID string) {
	scan, err := queue.Get(r.Context(), userID, scanID)
	if err != nil {
		writeScanError(w, queue, r, userID, err)
		return
	}
	if scan.Status != "succeeded" {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{"status": scan.Status, "errorCode": scan.ErrorCode, "errorMessage": scan.ErrorMessage}})
		return
	}
	if err := maintainer.ProcessScan(r.Context(), userID, scan.ID, time.Now()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "NOTIFICATION_PROCESSING_FAILED"})
		return
	}
	completed, err := store.ReceiptCompleted(r.Context(), scan.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "NOTIFICATION_PROCESSING_FAILED"})
		return
	}
	if !completed {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]string{"status": "processing"}})
		return
	}
	notification, err := store.NotificationForScan(r.Context(), userID, scan.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "NOTIFICATION_PROCESSING_FAILED"})
		return
	}
	pushState := "not_applicable"
	if notification != nil {
		if cfg.VAPIDPublicKey == "" || cfg.VAPIDPrivateKey == "" || cfg.VAPIDSubject == "" {
			pushState = "unconfigured"
		} else if err := maintainer.DrainForScan(r.Context(), userID, scan.ID, time.Now()); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "NOTIFICATION_PROCESSING_FAILED"})
			return
		} else {
			total, pending, err := store.PushDeliveryCounts(r.Context(), userID, notification.ID)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "NOTIFICATION_PROCESSING_FAILED"})
				return
			}
			switch {
			case total == 0:
				pushState = "no_deliveries"
			case pending == 0:
				pushState = "accepted"
			default:
				pushState = "pending"
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
		"status":       "succeeded",
		"push":         pushState,
		"notification": notification,
	}})
}

func validDevScanInput(source, key string) bool {
	return (source == "snappmarket" || source == "okala") && scans.ValidUUID(key)
}

func wishlistScanInput(locationID, source string) scans.Input {
	return scans.Input{LocationID: locationID, Source: source, Threshold: discounts.Minimum, Mode: "full"}
}

func wishlistTarget(r *http.Request, db *sql.DB, userID string) (string, error) {
	var locationID string
	err := db.QueryRowContext(r.Context(), `SELECT l.id FROM wishlist_preferences p JOIN locations l ON l.id=p.default_location_id AND l.user_id=p.user_id
		WHERE p.user_id=? AND EXISTS(SELECT 1 FROM wishlist_items w WHERE w.user_id=p.user_id)`, userID).Scan(&locationID)
	if err != nil {
		return "", err
	}
	return locationID, nil
}

func writeWishlistStartError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "WISHLIST_OR_LOCATION_MISSING"})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SCAN_START_FAILED"})
}

func validDevWishlistRequest(r *http.Request, body []byte, secret string) bool {
	timestamp := r.Header.Get("X-Better-Buy-Dev-Time")
	signature := r.Header.Get("X-Better-Buy-Dev-Signature")
	if r.Header.Get("Origin") != "" || r.Header.Get("X-Better-Buy-Dev") != "wishlist" || !devTimestampPattern.MatchString(timestamp) || !devSignaturePattern.MatchString(signature) {
		return false
	}
	value, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || absInt64(time.Now().UnixMilli()-value) > 60_000 {
		return false
	}
	provided, err := hex.DecodeString(signature)
	if err != nil {
		return false
	}
	message := fmt.Sprintf("better-buy-dev-wishlist-v1\n%s\n%s\n%s\n%s", timestamp, r.Method, r.URL.EscapedPath(), body)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(message))
	return hmac.Equal(provided, mac.Sum(nil))
}

func decodeFlexibleBytes(body []byte, target any) error {
	return json.Unmarshal(body, target)
}

func browserDevWishlistAllowed(r *http.Request, origins []string) bool {
	origin, allowed := r.Header.Get("Origin"), false
	for _, candidate := range origins {
		if candidate == origin {
			allowed = true
			break
		}
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]))
	return allowed && r.Header.Get("X-Better-Buy-Dev") == "wishlist-ui" && contentType == "application/json"
}

func absInt64(value int64) int64 {
	if value < 0 {
		return -value
	}
	return value
}
