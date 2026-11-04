package api

import (
	"database/sql"
	"net/http"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
)

func registerSettings(mux *http.ServeMux, service *auth.Service, db *sql.DB, rateLimits bool) {
	mux.Handle("GET /api/settings/digikalajet", requireIdentity(service, db, rateLimits, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":   "PROVIDER_UNAVAILABLE",
			"message": "این فروشگاه فعلاً برای اسکن جدید در دسترس نیست.",
		})
	})))
	mux.Handle("PUT /api/settings/digikalajet", requireIdentity(service, db, rateLimits, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":   "PROVIDER_UNAVAILABLE",
			"message": "این فروشگاه فعلاً برای اسکن جدید در دسترس نیست.",
		})
	})))
	mux.Handle("GET /api/settings/okala", requireIdentity(service, db, rateLimits, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]any{
			"requiresCustomerCredentials": false,
			"access":                      "public",
			"coverage":                    "campaign-feed",
		}})
	})))
}
