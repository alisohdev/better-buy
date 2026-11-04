package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"github.com/alirezasoheili/better-buy/apps/api/internal/wishlist"
)

func registerWishlist(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service, queue *scans.Queue) {
	store := wishlist.New(db, cfg.BoxKey)
	registerDevWishlist(mux, db, cfg, service, queue, store)
	var publicKey *string
	if cfg.VAPIDPublicKey != "" && cfg.VAPIDPrivateKey != "" && cfg.VAPIDSubject != "" {
		publicKey = &cfg.VAPIDPublicKey
	}
	mux.Handle("GET /api/wishlist", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := store.Read(r.Context(), requestIdentity(r).User.ID, publicKey, cfg.WishlistScheduleEnabled, cfg.DevMode)
		if err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": result})
	})))
	mux.Handle("POST /api/wishlist", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Phrase      string `json:"phrase"`
			MinDiscount *int   `json:"minDiscount"`
		}
		if decodeFlexibleJSON(r, &body) != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		minDiscount := discounts.Minimum
		if body.MinDiscount != nil {
			minDiscount = *body.MinDiscount
		}
		items, err := store.Add(r.Context(), requestIdentity(r).User.ID, body.Phrase, minDiscount)
		if err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"data": items})
	})))
	mux.Handle("PATCH /api/wishlist/{id}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			MinDiscount *int `json:"minDiscount"`
		}
		if decodeFlexibleJSON(r, &body) != nil || body.MinDiscount == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		items, err := store.SetMinimumDiscount(r.Context(), requestIdentity(r).User.ID, r.PathValue("id"), *body.MinDiscount)
		if err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": items})
	})))
	mux.Handle("DELETE /api/wishlist/{id}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := store.Delete(r.Context(), requestIdentity(r).User.ID, r.PathValue("id")); err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
	})))
	mux.Handle("PUT /api/wishlist/location", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]json.RawMessage
		if decodeFlexibleJSON(r, &body) != nil || body == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		raw, exists := body["locationId"]
		if !exists {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		var locationID *string
		if string(raw) != "null" {
			var value string
			if json.Unmarshal(raw, &value) != nil || strings.TrimSpace(value) == "" || len([]rune(strings.TrimSpace(value))) > 200 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			value = strings.TrimSpace(value)
			locationID = &value
		}
		if err := store.SetLocation(r.Context(), requestIdentity(r).User.ID, locationID); err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]*string{"defaultLocationId": locationID}})
	})))
	mux.Handle("GET /api/notifications", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		items, err := store.Notifications(r.Context(), requestIdentity(r).User.ID)
		if err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": items})
	})))
	mux.Handle("POST /api/notifications/{id}/read", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := store.MarkNotificationRead(r.Context(), requestIdentity(r).User.ID, r.PathValue("id")); err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
	})))
	mux.Handle("POST /api/push/subscriptions", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if publicKey == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "PUSH_NOT_CONFIGURED"})
			return
		}
		body, err := readRequestBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_SUBSCRIPTION"})
			return
		}
		saved, err := store.SavePushSubscription(r.Context(), requestIdentity(r).User.ID, body)
		if err != nil {
			writeWishlistError(w, err)
			return
		}
		if !saved {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "SUBSCRIPTION_LIMIT_OR_CONFLICT", "message": "ثبت اعلان ممکن نشد؛ اشتراک مرورگر را غیرفعال و دوباره فعال کنید."})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"data": map[string]bool{"ok": true}})
	})))
	mux.Handle("DELETE /api/push/subscriptions", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if decodeFlexibleJSON(r, &body) != nil || len(body.Endpoint) > 2048 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if err := store.DeletePushSubscription(r.Context(), requestIdentity(r).User.ID, body.Endpoint); err != nil {
			writeWishlistError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
	})))
}

func decodeFlexibleJSON(r *http.Request, value any) error {
	body, err := readRequestBody(r)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, value)
}

func readRequestBody(r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8193))
	if err != nil {
		return nil, err
	}
	if len(body) > 8192 {
		return nil, errors.New("request body is too large")
	}
	return body, nil
}

func writeWishlistError(w http.ResponseWriter, err error) {
	var wishlistError *wishlist.Error
	if errors.As(err, &wishlistError) {
		message := ""
		if wishlistError.Code == "INVALID_INPUT" {
			message = "نام کالا باید بین ۲ تا ۱۲۰ نویسه باشد."
		} else if wishlistError.Code == "INVALID_DISCOUNT" {
			message = "حداقل تخفیف باید بین ۱۵ تا ۸۰ درصد باشد."
		} else if wishlistError.Code == "WISHLIST_LIMIT" {
			message = "حداکثر ۳۰ عبارت می‌توانید اضافه کنید."
		}
		body := map[string]string{"error": wishlistError.Code}
		if message != "" {
			body["message"] = message
		}
		writeJSON(w, wishlistError.Status, body)
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "WISHLIST_ERROR"})
}
