package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

func registerProducts(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service, queue *scans.Queue) {
	productService := products.New(db, cfg.BoxKey)
	mux.Handle("GET /api/scans/{id}/deals", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deals, _, err := productService.Deals(r.Context(), queue, requestIdentity(r).User.ID, r.PathValue("id"))
		if err != nil {
			writeProductError(w, err)
			return
		}
		for i := range deals {
			if deals[i].State == "current" {
				deals[i].State = "still_available"
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": deals})
	})))
	mux.Handle("GET /api/scans/{id}/deal-groups", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deals, scan, err := productService.Deals(r.Context(), queue, requestIdentity(r).User.ID, r.PathValue("id"))
		if err != nil {
			writeProductError(w, err)
			return
		}
		for i := range deals {
			if deals[i].State == "current" {
				deals[i].State = "still_available"
			}
		}
		groups := products.LegacyGroups(scan.Source, deals)
		writeJSON(w, http.StatusOK, map[string]any{"data": groups, "meta": map[string]any{"groupKeyVersion": 1, "groupedProductCount": len(groups), "offerCount": len(deals)}})
	})))
	mux.Handle("GET /api/scans/{id}/products", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID, scanID := requestIdentity(r).User.ID, r.PathValue("id")
		if r.URL.Query().Get("page") == "1" {
			page, err := productService.ProductPage(r.Context(), queue, userID, scanID, r.URL.Query())
			if err != nil {
				writeProductError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"data": page})
			return
		}
		groups, scan, err := productService.ProductGroups(r.Context(), queue, userID, scanID)
		if err != nil {
			writeProductError(w, err)
			return
		}
		contextStatus := "legacy_unverified"
		if scan.Context != nil {
			contextStatus = "verified"
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": groups, "meta": map[string]any{"groupKeyVersion": 2, "historyContext": contextStatus, "coverageSummary": "supported_discount_feeds"}})
	})))
	mux.Handle("GET /api/scans/{id}/products/{key}/offers", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, err := productService.OfferPage(r.Context(), queue, requestIdentity(r).User.ID, r.PathValue("id"), r.PathValue("key"), r.URL.Query())
		if err != nil {
			writeProductError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": page})
	})))
}

func writeProductError(w http.ResponseWriter, err error) {
	var scanError *scans.Error
	if errors.As(err, &scanError) {
		writeJSON(w, scanError.Status, map[string]string{"error": scanError.Code})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "RESULT_READ_ERROR", "retryable": true})
}
