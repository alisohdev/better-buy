package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/carts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

func registerCarts(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service, queue *scans.Queue) {
	store := carts.New(db, queue, products.New(db, cfg.BoxKey))
	mux.Handle("GET /api/carts/{source}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		source, ok := cartSource(r.PathValue("source"))
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_SOURCE"})
			return
		}
		var locationID *string
		if values, exists := r.URL.Query()["locationId"]; exists {
			value := strings.TrimSpace(first(values))
			if value == "" || len(value) > 128 {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			locationID = &value
		}
		response, err := store.Read(r.Context(), requestIdentity(r).User.ID, source, locationID)
		if err != nil {
			writeCartError(w, err, false)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": response})
	})))
	mux.Handle("PUT /api/carts/{source}/items/{key}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		source, ok := cartSource(r.PathValue("source"))
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_SOURCE"})
			return
		}
		key := strings.TrimSpace(r.PathValue("key"))
		if key == "" || len(key) > 512 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_ITEM_KEY"})
			return
		}
		var shape map[string]json.RawMessage
		if decodeJSON(r, &shape) != nil || shape == nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		var err error
		if _, hasScan := shape["scanId"]; hasScan {
			var body struct {
				ScanID   string `json:"scanId"`
				Quantity int    `json:"quantity"`
			}
			if decodeJSONBytes(mustJSON(shape), &body) != nil || strings.TrimSpace(body.ScanID) == "" || len(strings.TrimSpace(body.ScanID)) > 128 || !validCartQuantity(body.Quantity) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			err = store.Put(r.Context(), requestIdentity(r).User.ID, source, key, strings.TrimSpace(body.ScanID), body.Quantity)
		} else {
			var body struct {
				Quantity int `json:"quantity"`
			}
			if decodeJSONBytes(mustJSON(shape), &body) != nil || !validCartQuantity(body.Quantity) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			err = store.Update(r.Context(), requestIdentity(r).User.ID, source, key, body.Quantity)
		}
		if err != nil {
			writeCartError(w, err, true)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})))
	mux.Handle("DELETE /api/carts/{source}/items/{key}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		source, ok := cartSource(r.PathValue("source"))
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_SOURCE"})
			return
		}
		key := strings.TrimSpace(r.PathValue("key"))
		if key == "" || len(key) > 512 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_ITEM_KEY"})
			return
		}
		if err := store.Delete(r.Context(), requestIdentity(r).User.ID, source, key); err != nil {
			writeCartError(w, err, true)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})))
}

func cartSource(source string) (string, bool) {
	return source, source == "snappmarket" || source == "okala"
}

func validCartQuantity(quantity int) bool { return quantity >= 1 && quantity <= 99 }

func writeCartError(w http.ResponseWriter, err error, writing bool) {
	var cartError *carts.Error
	if errors.As(err, &cartError) {
		writeJSON(w, cartError.Status, map[string]any{"error": cartError.Code, "retryable": false})
		return
	}
	var scanError *scans.Error
	if writing && errors.As(err, &scanError) {
		writeJSON(w, scanError.Status, map[string]string{"error": scanError.Code})
		return
	}
	writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "CART_READ_ERROR", "retryable": true})
}

func decodeJSON(r *http.Request, out any) error {
	return decodeJSONReader(io.LimitReader(r.Body, 8193), out)
}

func decodeJSONBytes(data []byte, out any) error {
	return decodeJSONReader(bytes.NewReader(data), out)
}

func decodeJSONReader(reader io.Reader, out any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON value")
	}
	return nil
}

func mustJSON(value any) []byte {
	data, _ := json.Marshal(value)
	return data
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
