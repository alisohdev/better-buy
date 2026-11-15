package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
)

const guestCookieName = "better-buy.guest"

func guestHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func guestCookie(secure bool) string {
	if secure {
		return "__Host-" + guestCookieName
	}
	return guestCookieName
}

func guestIdentity(db *sql.DB, r *http.Request, secure bool) (*auth.Identity, error) {
	cookie, err := r.Cookie(guestCookie(secure))
	if err != nil || len(cookie.Value) != 64 {
		return nil, nil
	}
	var userID string
	err = db.QueryRowContext(r.Context(), "SELECT user_id FROM guest_sessions WHERE token_hash=? AND expires_at>?", guestHash(cookie.Value), time.Now().Unix()).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &auth.Identity{User: auth.User{ID: userID, Name: "Guest"}}, nil
}

func guestAddress(r *http.Request) string {
	address, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		address = r.RemoteAddr
	}
	if remote := net.ParseIP(address); remote != nil && remote.IsLoopback() {
		if forwarded := net.ParseIP(r.Header.Get("X-Real-IP")); forwarded != nil {
			address = forwarded.String()
		}
	}
	return guestHash(address)
}

func registerGuest(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service) {
	mux.HandleFunc("POST /api/guest/session", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		identity, err := service.Session(r)
		if err == nil && identity == nil {
			identity, err = guestIdentity(db, r, strings.HasPrefix(cfg.BetterAuthURL, "https://"))
		}
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "SESSION_READ_ERROR"})
			return
		}
		if identity != nil {
			writeJSON(w, 200, map[string]any{"data": map[string]string{"id": identity.User.ID}})
			return
		}
		if err := service.Limit(r.Context(), "guest-create:"+guestAddress(r), 60, 10); err != nil {
			w.Header().Set("Retry-After", "60")
			writeJSON(w, 429, map[string]string{"error": "RATE_LIMITED"})
			return
		}
		tokenBytes := make([]byte, 32)
		if _, err := rand.Read(tokenBytes); err != nil {
			writeJSON(w, 503, map[string]string{"error": "GUEST_SESSION_ERROR"})
			return
		}
		token := hex.EncodeToString(tokenBytes)
		userID := "guest:" + guestHash(token)
		tx, err := db.BeginTx(r.Context(), nil)
		if err == nil {
			defer tx.Rollback()
			expired := "SELECT user_id FROM guest_sessions WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM scans WHERE scans.user_id=guest_sessions.user_id AND status IN ('queued','running'))"
			for _, table := range []string{"scans", "locations", "api_rate_limits"} {
				if err == nil {
					_, err = tx.ExecContext(r.Context(), "DELETE FROM "+table+" WHERE user_id IN ("+expired+")", time.Now().Unix())
				}
			}
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "DELETE FROM guest_sessions WHERE user_id IN ("+expired+")", time.Now().Unix())
			}
			if err == nil {
				_, err = tx.ExecContext(r.Context(), "INSERT INTO guest_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", guestHash(token), userID, time.Now().Add(24*time.Hour).Unix())
			}
			if err == nil {
				err = tx.Commit()
			}
		}
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "GUEST_SESSION_ERROR"})
			return
		}
		secure := strings.HasPrefix(cfg.BetterAuthURL, "https://")
		http.SetCookie(w, &http.Cookie{Name: guestCookie(secure), Value: token, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: 86400})
		writeJSON(w, 200, map[string]any{"data": map[string]string{"id": userID}})
	})
}

func requireVisitor(service *auth.Service, db *sql.DB, cfg config.Config, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Vary", "Origin, Cookie, Authorization")
		identity, err := service.Session(r)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "SESSION_READ_ERROR"})
			return
		}
		if identity != nil {
			if r.Header.Get("X-Better-Buy-Guest") != "" {
				writeJSON(w, 409, map[string]string{"error": "ACCOUNT_CHANGED"})
				return
			}
			requireIdentity(service, db, cfg.APIRateLimitsEnabled, next).ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "private, no-store, max-age=0")
		w.Header().Set("Vary", "Origin, Cookie, Authorization")
		identity, err = guestIdentity(db, r, strings.HasPrefix(cfg.BetterAuthURL, "https://"))
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "SESSION_READ_ERROR"})
			return
		}
		if identity == nil {
			writeJSON(w, 401, map[string]string{"error": "GUEST_SESSION_EXPIRED", "message": "نشست مهمان پایان یافته است؛ صفحه را تازه‌سازی کنید."})
			return
		}
		if expected := r.Header.Get("X-Better-Buy-Guest"); expected != "" && expected != identity.User.ID {
			writeJSON(w, 409, map[string]string{"error": "GUEST_SESSION_CHANGED"})
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/locations" {
			var count int
			if err := db.QueryRowContext(r.Context(), "SELECT count(*) FROM locations WHERE user_id=?", identity.User.ID).Scan(&count); err != nil {
				writeJSON(w, 503, map[string]string{"error": "LOCATION_READ_ERROR"})
				return
			}
			if count >= 20 {
				writeJSON(w, 422, map[string]string{"error": "GUEST_LOCATION_LIMIT", "message": "برای نگهداری موقعیت‌های بیشتر وارد حساب شوید."})
				return
			}
		}
		if r.Method == http.MethodPost && r.URL.Path == "/api/scans" {
			if err := service.Limit(r.Context(), "guest-scan:"+guestAddress(r), 3600, 10); err != nil {
				w.Header().Set("Retry-After", "3600")
				writeJSON(w, 429, map[string]string{"error": "RATE_LIMITED", "message": "سقف اسکن مهمان پر شده است؛ بعداً تلاش کنید یا وارد حساب شوید."})
				return
			}
		}
		retry, err := consumeRateLimit(r.Context(), db, identity.User.ID, r.Method, r.URL.Path)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "RATE_LIMIT_READ_ERROR"})
			return
		}
		if retry > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			writeJSON(w, 429, map[string]string{"error": "RATE_LIMITED"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey{}, *identity)))
	})
}
