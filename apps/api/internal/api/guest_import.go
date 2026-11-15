package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

func registerGuestLocationImport(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service) {
	mux.Handle("POST /api/locations/import", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			UserID    string   `json:"userId"`
			GuestID   string   `json:"guestId"`
			Name      string   `json:"name"`
			Latitude  *float64 `json:"latitude"`
			Longitude *float64 `json:"longitude"`
			IsDefault *bool    `json:"isDefault"`
		}
		if !decodeJSONBody(w, r, &input) || !scans.ValidUUID(input.GuestID) || !validLocationInput(locationInput{Name: input.Name, Latitude: input.Latitude, Longitude: input.Longitude, IsDefault: input.IsDefault}, false) {
			writeJSON(w, 400, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if !withinTehran(*input.Latitude, *input.Longitude) {
			writeJSON(w, 422, map[string]string{"error": "OUTSIDE_TEHRAN"})
			return
		}
		userID := requestIdentity(r).User.ID
		importID := input.GuestID + ":" + guestHash(fmt.Sprintf("%g,%g", *input.Latitude, *input.Longitude))
		if input.UserID != "" && input.UserID != userID {
			writeJSON(w, 409, map[string]string{"error": "ACCOUNT_CHANGED"})
			return
		}
		tx, err := db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		defer tx.Rollback()
		var locationID string
		err = tx.QueryRowContext(r.Context(), `SELECT l.id FROM locations l JOIN guest_location_imports g ON g.user_id=l.user_id AND g.location_id=l.id WHERE g.user_id=? AND g.guest_location_id=?`, userID, importID).Scan(&locationID)
		if errors.Is(err, sql.ErrNoRows) {
			err = tx.QueryRowContext(r.Context(), "SELECT id FROM locations WHERE user_id=? AND latitude=? AND longitude=? LIMIT 1", userID, *input.Latitude, *input.Longitude).Scan(&locationID)
		}
		if errors.Is(err, sql.ErrNoRows) {
			locationID, err = newUUID()
			var count int
			if err == nil {
				err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM locations WHERE user_id=?", userID).Scan(&count)
			}
			if err == nil {
				at := time.Now().UTC().Format(time.RFC3339Nano)
				_, err = tx.ExecContext(r.Context(), `INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision) VALUES(?,?,?,?,?,?,?,?,1)`, locationID, userID, input.Name, *input.Latitude, *input.Longitude, boolInt(count == 0), at, at)
			}
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO guest_location_imports(user_id,guest_location_id,location_id) VALUES(?,?,?) ON CONFLICT(user_id,guest_location_id) DO UPDATE SET location_id=excluded.location_id`, userID, importID, locationID)
		}
		var saved location
		if err == nil {
			saved, err = scanLocation(tx.QueryRowContext(r.Context(), `SELECT id,name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision FROM locations WHERE user_id=? AND id=?`, userID, locationID))
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		writeJSON(w, 200, map[string]any{"data": saved})
	})))
}
