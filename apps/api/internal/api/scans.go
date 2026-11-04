package api

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

type scanRequest struct {
	LocationID *string `json:"locationId"`
	Source     *string `json:"source"`
	Threshold  *int    `json:"threshold"`
	Mode       *string `json:"mode"`
}

func registerScans(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service, queue *scans.Queue) {
	mux.Handle("GET /api/scans", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := requestIdentity(r).User.ID
		if values, ok := r.URL.Query()["intent"]; ok {
			key := ""
			if len(values) > 0 {
				key = values[0]
			}
			if !scans.ValidUUID(key) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_IDEMPOTENCY_KEY"})
				return
			}
			record, err := queue.FindStartIntent(r.Context(), userID, key)
			if err != nil {
				writeScanError(w, queue, r, userID, err)
				return
			}
			items := make([]scans.Record, 0, 1)
			if record != nil {
				items = append(items, *record)
			}
			writeJSON(w, http.StatusOK, map[string]any{"data": items})
			return
		}
		query := r.URL.Query()
		if query.Has("locationId") || query.Has("source") || query.Has("cursor") || query.Has("limit") {
			limit := 50
			if raw := query.Get("limit"); raw != "" {
				parsed, err := strconv.Atoi(raw)
				if err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
					return
				}
				limit = parsed
			}
			page, err := queue.History(r.Context(), userID, cfg.BoxKey, query.Get("locationId"), query.Get("source"), limit, query.Get("cursor"))
			if err != nil {
				writeScanError(w, queue, r, userID, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"data": page.Items, "meta": map[string]any{"nextCursor": page.NextCursor, "activeScan": page.ActiveScan}})
			return
		}
		items, err := queue.List(r.Context(), userID)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "RESULT_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": items})
	})))
	mux.Handle("GET /api/scans/{id}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		item, err := queue.Get(r.Context(), requestIdentity(r).User.ID, r.PathValue("id"))
		if err != nil {
			writeScanError(w, queue, r, requestIdentity(r).User.ID, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": item})
	})))
	mux.Handle("POST /api/scans/{id}/cancel", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		item, err := queue.Cancel(r.Context(), requestIdentity(r).User.ID, r.PathValue("id"))
		if err != nil {
			writeScanError(w, queue, r, requestIdentity(r).User.ID, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": item})
	})))
	mux.Handle("POST /api/scans", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input scanRequest
		if !decodeJSONBody(w, r, &input) || input.LocationID == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		value := scans.Input{LocationID: *input.LocationID, Source: "snappmarket", Threshold: discounts.Minimum, Mode: "partial"}
		if input.Source != nil {
			value.Source = *input.Source
		}
		if input.Threshold != nil {
			value.Threshold = *input.Threshold
		}
		if input.Mode != nil {
			value.Mode = *input.Mode
		}
		item, err := queue.Enqueue(r.Context(), requestIdentity(r).User.ID, value, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeScanError(w, queue, r, requestIdentity(r).User.ID, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"data": item})
	})))
}

func writeScanError(w http.ResponseWriter, queue *scans.Queue, r *http.Request, userID string, err error) {
	var scanError *scans.Error
	if errors.As(err, &scanError) {
		if scanError.Status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "10")
		}
		body := map[string]any{"error": scanError.Code, "message": scanError.Message}
		if scanError.Code == "ACTIVE_SCAN_EXISTS" || scanError.Code == "SCAN_IN_PROGRESS" {
			if scans.ValidUUID(scanError.Message) {
				active, activeErr := queue.Get(r.Context(), userID, scanError.Message)
				if activeErr == nil {
					body["activeScan"] = active
				}
			} else {
				active, activeErr := queue.Active(r.Context(), userID)
				if activeErr == nil && active != nil {
					body["activeScan"] = active
				}
			}
		}
		writeJSON(w, scanError.Status, body)
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "PERSISTENCE_ERROR"})
}
