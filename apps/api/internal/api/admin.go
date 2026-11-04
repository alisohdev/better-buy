package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/alirezasoheili/better-buy/apps/api/internal/analytics"
	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
)

func registerAnalytics(mux *http.ServeMux, db *sql.DB, cfg config.Config, authService *auth.Service) {
	store := analytics.New(db)
	mux.HandleFunc("POST /api/analytics/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		originAllowed := false
		for _, origin := range cfg.CORSOrigins {
			if origin == r.Header.Get("Origin") && origin != "" {
				originAllowed = true
				break
			}
		}
		if !originAllowed {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "INVALID_ORIGIN"})
			return
		}
		var event analytics.Event
		if !decodeAuthBody(w, r, &event) || !event.ValidIdentifiers() {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_ANALYTICS_EVENT"})
			return
		}
		identity, err := authService.Session(r)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "SESSION_READ_ERROR"})
			return
		}
		userID, rateKey := "", "analytics-visitor:"+event.VisitorID
		if identity != nil {
			userID, rateKey = identity.User.ID, "analytics-user:"+identity.User.ID
		}
		if cfg.APIRateLimitsEnabled {
			retry, err := consumeRateLimit(r.Context(), db, rateKey, r.Method, r.URL.Path)
			if err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "RATE_LIMIT_READ_ERROR"})
				return
			}
			if retry > 0 {
				w.Header().Set("Retry-After", strconv.Itoa(retry))
				writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "RATE_LIMITED"})
				return
			}
		}
		err = store.Record(r.Context(), userID, event)
		switch {
		case errors.Is(err, analytics.ErrInvalidEvent):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_ANALYTICS_EVENT"})
		case errors.Is(err, analytics.ErrUnauthenticatedSearch):
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "UNAUTHENTICATED"})
		case err != nil:
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ANALYTICS_WRITE_ERROR"})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	})
	mux.Handle("GET /api/admin/access", requireIdentity(authService, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"allowed": adminAllowed(requestIdentity(r).User, cfg.AdminEmails)}})
	})))
	admin := func(next http.HandlerFunc) http.Handler {
		return requireIdentity(authService, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !adminAllowed(requestIdentity(r).User, cfg.AdminEmails) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "ADMIN_REQUIRED"})
				return
			}
			next.ServeHTTP(w, r)
		}))
	}
	mux.Handle("GET /api/admin/analytics", admin(func(w http.ResponseWriter, r *http.Request) {
		result, err := store.Overview(r.Context())
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ANALYTICS_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": result})
	}))
	mux.Handle("GET /api/admin/users", admin(func(w http.ResponseWriter, r *http.Request) {
		query := strings.TrimSpace(r.URL.Query().Get("q"))
		page := 1
		var err error
		if raw := r.URL.Query().Get("page"); raw != "" {
			page, err = strconv.Atoi(raw)
		}
		if err != nil || page < 1 || page > 100_000 || utf8.RuneCountInString(query) > 120 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_ADMIN_QUERY"})
			return
		}
		result, err := store.Users(r.Context(), query, page)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ADMIN_USERS_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": result})
	}))
	mux.Handle("GET /api/admin/users/{id}", admin(func(w http.ResponseWriter, r *http.Request) {
		result, err := store.User(r.Context(), r.PathValue("id"))
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "USER_NOT_FOUND"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ADMIN_USER_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": result})
	}))
}

func adminAllowed(user auth.User, emails []string) bool {
	if !user.EmailVerified {
		return false
	}
	for _, email := range emails {
		if strings.EqualFold(strings.TrimSpace(email), user.Email) {
			return true
		}
	}
	return false
}
