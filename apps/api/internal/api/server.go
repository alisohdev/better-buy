package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

type identityKey struct{}

func New(db *sql.DB, cfg config.Config, queue *scans.Queue) http.Handler {
	mux := http.NewServeMux()
	authService := auth.New(db, cfg.BetterAuthSecret, cfg.BetterAuthURL, cfg.GoogleClientID, cfg.GoogleClientSecret)
	registerAuth(mux, authService, cfg.DevMode)
	registerLocations(mux, db, cfg, authService)
	registerScans(mux, db, cfg, authService, queue)
	registerProducts(mux, db, cfg, authService, queue)
	registerCarts(mux, db, cfg, authService, queue)
	registerSettings(mux, authService, db, cfg.APIRateLimitsEnabled)
	registerWishlist(mux, db, cfg, authService, queue)
	registerAnalytics(mux, db, cfg, authService)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.Handle("GET /api/health", requireIdentity(authService, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "storage": "sqlite", "signedIn": true})
	})))
	mux.Handle("GET /api/me", requireIdentity(authService, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity := r.Context().Value(identityKey{}).(auth.Identity)
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]string{"id": identity.User.ID}})
	})))
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND", "message": "مسیر پیدا نشد."})
	})
	return cors(cfg.CORSOrigins, mux)
}

func requireIdentity(service *auth.Service, db *sql.DB, rateLimits bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Vary", "Cookie, Authorization")
		identity, err := service.Session(r)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SESSION_READ_ERROR"})
			return
		}
		if identity == nil || identity.User.ID == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "UNAUTHENTICATED", "message": "برای ادامه با ایمیل یا گوگل وارد شوید."})
			return
		}
		if rateLimits {
			retry, err := consumeRateLimit(r.Context(), db, identity.User.ID, r.Method, r.URL.Path)
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "RATE_LIMIT_READ_ERROR"})
				return
			}
			if retry > 0 {
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "RATE_LIMITED", "message": "درخواست‌ها موقتاً محدود شده‌اند؛ کمی بعد دوباره تلاش کنید."})
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, *identity)))
	})
}

var cancelPath = regexp.MustCompile(`^/api/scans/[^/]+/cancel$`)

func consumeRateLimit(ctx context.Context, db *sql.DB, userID, method, path string) (int, error) {
	bucket, limit := "read", 120
	if method == http.MethodPost && path == "/api/scans" {
		bucket, limit = "start", 5
	} else if method == http.MethodPost && cancelPath.MatchString(path) {
		bucket, limit = "cancel", 10
	}
	now := time.Now().UnixMilli()
	window := now / 60_000 * 60_000
	var requests int
	err := db.QueryRowContext(ctx, `INSERT INTO api_rate_limits(user_id,bucket,window_start,requests) VALUES(?,?,?,1) ON CONFLICT(user_id,bucket,window_start) DO UPDATE SET requests=requests+1 WHERE requests < ? RETURNING requests`, userID, bucket, window, limit).Scan(&requests)
	if errors.Is(err, sql.ErrNoRows) {
		retry := int((window + 60_000 - now + 999) / 1000)
		if retry < 1 {
			retry = 1
		}
		return retry, nil
	}
	return 0, err
}

func cors(origins []string, next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		allowed[origin] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if _, ok := allowed[origin]; !ok {
				if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
					writeJSON(w, http.StatusForbidden, map[string]string{"error": "INVALID_ORIGIN"})
					return
				}
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key, X-Better-Buy-Dev")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "86400")
		}
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
