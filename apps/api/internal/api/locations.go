package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"golang.org/x/text/unicode/norm"
)

type location struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Latitude           float64 `json:"latitude"`
	Longitude          float64 `json:"longitude"`
	IsDefault          bool    `json:"isDefault"`
	CreatedAt          string  `json:"createdAt"`
	UpdatedAt          string  `json:"updatedAt"`
	CoordinateRevision int     `json:"coordinateRevision"`
}

type locationInput struct {
	Name      string   `json:"name"`
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
	IsDefault *bool    `json:"isDefault"`
}

type geocoderResult struct {
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	DisplayName string  `json:"displayName"`
}

func registerLocations(mux *http.ServeMux, db *sql.DB, cfg config.Config, service *auth.Service) {
	mux.Handle("GET /api/locations", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity := requestIdentity(r)
		rows, err := db.QueryContext(r.Context(), `SELECT id,name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision FROM locations WHERE user_id=? ORDER BY is_default DESC,created_at`, identity.User.ID)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		defer rows.Close()
		items := make([]location, 0)
		for rows.Next() {
			item, scanErr := scanLocation(rows)
			if scanErr != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
				return
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": items})
	})))
	mux.Handle("GET /api/locations/search", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := norm.NFKC.String(strings.TrimSpace(r.URL.Query().Get("q")))
		if len([]rune(query)) < 2 || len([]rune(query)) > 120 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_SEARCH_QUERY", "message": "عبارت جست‌وجو باید بین ۲ تا ۱۲۰ نویسه باشد."})
			return
		}
		results, status, err := searchLocations(r.Context(), cfg.GeocoderBaseURL, query)
		if err != nil || len(results) == 0 {
			results, status, err = searchPhoton(r.Context(), query)
		}
		if err != nil {
			if status == http.StatusServiceUnavailable {
				writeJSON(w, status, map[string]string{"error": "GEOCODER_UNAVAILABLE", "message": "جست‌وجوی نشانی فعلاً در دسترس نیست؛ روی نقشه انتخاب کنید."})
			} else {
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": "GEOCODER_ERROR", "message": "پاسخ جست‌وجوی نشانی دریافت نشد؛ دوباره تلاش کنید."})
			}
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": results})
	})))
	mux.Handle("POST /api/locations", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input locationInput
		if !decodeJSONBody(w, r, &input) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if input.IsDefault == nil {
			defaultValue := false
			input.IsDefault = &defaultValue
		}
		if !validLocationInput(input, false) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if !withinTehran(*input.Latitude, *input.Longitude) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "OUTSIDE_TEHRAN", "message": "فعلاً فقط امکان استفاده در شهر تهران وجود دارد."})
			return
		}
		identity := requestIdentity(r)
		at := time.Now().UTC().Format(time.RFC3339Nano)
		id, err := newUUID()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		tx, err := db.BeginTx(r.Context(), nil)
		if err == nil {
			if input.IsDefault != nil && *input.IsDefault {
				_, err = tx.ExecContext(r.Context(), `UPDATE locations SET is_default=0 WHERE user_id=?`, identity.User.ID)
			}
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision) VALUES (?,?,?,?,?,?,?,?,1)`, id, identity.User.ID, strings.TrimSpace(input.Name), *input.Latitude, *input.Longitude, boolInt(input.IsDefault != nil && *input.IsDefault), at, at)
		}
		if err != nil {
			if tx != nil {
				_ = tx.Rollback()
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		if err := tx.Commit(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		item, err := getLocation(r.Context(), db, identity.User.ID, id)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"data": item})
	})))
	mux.Handle("PATCH /api/locations/{id}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var patch map[string]json.RawMessage
		if !decodeJSONBody(w, r, &patch) || len(patch) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		for key := range patch {
			if key != "name" && key != "latitude" && key != "longitude" && key != "isDefault" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
		}
		current, err := getLocation(r.Context(), db, requestIdentity(r).User.ID, r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		if current == nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		input := locationInput{}
		if raw, ok := patch["name"]; ok {
			if json.Unmarshal(raw, &input.Name) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
		} else {
			input.Name = current.Name
		}
		if raw, ok := patch["latitude"]; ok {
			var value float64
			if json.Unmarshal(raw, &value) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			input.Latitude = &value
		} else {
			input.Latitude = &current.Latitude
		}
		if raw, ok := patch["longitude"]; ok {
			var value float64
			if json.Unmarshal(raw, &value) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			input.Longitude = &value
		} else {
			input.Longitude = &current.Longitude
		}
		if raw, ok := patch["isDefault"]; ok {
			var value bool
			if json.Unmarshal(raw, &value) != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
				return
			}
			input.IsDefault = &value
		} else {
			input.IsDefault = &current.IsDefault
		}
		if !validLocationInput(input, false) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "INVALID_INPUT"})
			return
		}
		if !withinTehran(*input.Latitude, *input.Longitude) {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "OUTSIDE_TEHRAN", "message": "فعلاً فقط امکان استفاده در شهر تهران وجود دارد."})
			return
		}
		identity := requestIdentity(r)
		at := time.Now().UTC().Format(time.RFC3339Nano)
		tx, err := db.BeginTx(r.Context(), nil)
		if err == nil && *input.IsDefault {
			_, err = tx.ExecContext(r.Context(), `UPDATE locations SET is_default=0 WHERE user_id=?`, identity.User.ID)
		}
		if err == nil {
			_, err = tx.ExecContext(r.Context(), `UPDATE locations SET coordinate_revision=coordinate_revision+CASE WHEN latitude<>? OR longitude<>? THEN 1 ELSE 0 END,name=?,latitude=?,longitude=?,is_default=?,updated_at=? WHERE user_id=? AND id=?`, *input.Latitude, *input.Longitude, strings.TrimSpace(input.Name), *input.Latitude, *input.Longitude, boolInt(*input.IsDefault), at, identity.User.ID, r.PathValue("id"))
		}
		if err != nil {
			if tx != nil {
				_ = tx.Rollback()
			}
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		if err := tx.Commit(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		item, err := getLocation(r.Context(), db, identity.User.ID, r.PathValue("id"))
		if err != nil || item == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": item})
	})))
	mux.Handle("DELETE /api/locations/{id}", requireIdentity(service, db, cfg.APIRateLimitsEnabled, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		identity := requestIdentity(r)
		tx, err := db.BeginTx(r.Context(), nil)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		defer tx.Rollback()
		var exists int
		err = tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM locations WHERE user_id=? AND id=?`, identity.User.ID, r.PathValue("id")).Scan(&exists)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		if exists == 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		var count int
		if err := tx.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM locations WHERE user_id=?`, identity.User.ID).Scan(&count); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		if count <= 1 {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "LAST_LOCATION"})
			return
		}
		var active int
		if err := tx.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM scans WHERE user_id=? AND location_id=? AND status IN ('queued','running'))`, identity.User.ID, r.PathValue("id")).Scan(&active); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_READ_ERROR"})
			return
		}
		if active != 0 {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "SCAN_IN_PROGRESS"})
			return
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM deals WHERE scan_id IN (SELECT id FROM scans WHERE user_id=? AND location_id=?)`, identity.User.ID, r.PathValue("id")); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM scans WHERE user_id=? AND location_id=?`, identity.User.ID, r.PathValue("id")); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		result, err := tx.ExecContext(r.Context(), `DELETE FROM locations WHERE user_id=? AND id=?`, identity.User.ID, r.PathValue("id"))
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		changed, _ := result.RowsAffected()
		if changed == 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		if err := tx.Commit(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LOCATION_WRITE_ERROR"})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})))
}

func validLocationInput(input locationInput, allowMissing bool) bool {
	name := strings.TrimSpace(input.Name)
	if name == "" || len([]rune(name)) > 80 || input.Latitude == nil || input.Longitude == nil {
		return false
	}
	if math.IsNaN(*input.Latitude) || math.IsInf(*input.Latitude, 0) || *input.Latitude < -90 || *input.Latitude > 90 || math.IsNaN(*input.Longitude) || math.IsInf(*input.Longitude, 0) || *input.Longitude < -180 || *input.Longitude > 180 {
		return false
	}
	if !allowMissing && input.IsDefault == nil {
		return false
	}
	return true
}

func withinTehran(latitude, longitude float64) bool {
	return latitude >= 35.56 && latitude <= 35.82 && longitude >= 51.18 && longitude <= 51.66
}

func scanLocation(row interface{ Scan(...any) error }) (location, error) {
	var item location
	var isDefault int
	err := row.Scan(&item.ID, &item.Name, &item.Latitude, &item.Longitude, &isDefault, &item.CreatedAt, &item.UpdatedAt, &item.CoordinateRevision)
	item.IsDefault = isDefault != 0
	return item, err
}

func getLocation(ctx context.Context, db *sql.DB, userID, id string) (*location, error) {
	item, err := scanLocation(db.QueryRowContext(ctx, `SELECT id,name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision FROM locations WHERE user_id=? AND id=?`, userID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func searchLocations(ctx context.Context, base, query string) ([]geocoderResult, int, error) {
	parsed, err := url.Parse(base)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, http.StatusServiceUnavailable, fmt.Errorf("invalid geocoder URL")
	}
	params := parsed.Query()
	params.Set("q", query)
	params.Set("format", "jsonv2")
	params.Set("limit", "5")
	params.Set("bounded", "1")
	params.Set("viewbox", "51.18,35.82,51.66,35.56")
	params.Set("addressdetails", "0")
	params.Set("accept-language", "fa")
	parsed.RawQuery = params.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, http.StatusServiceUnavailable, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "better-buy-location-search/1.0")
	client := &http.Client{Timeout: 8 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, http.StatusBadGateway, fmt.Errorf("geocoder returned %s", response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	var raw []struct {
		Latitude    string `json:"lat"`
		Longitude   string `json:"lon"`
		DisplayName string `json:"display_name"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, http.StatusBadGateway, err
	}
	results := make([]geocoderResult, 0, 5)
	seen := make(map[string]struct{})
	for _, row := range raw {
		latitude, latErr := strconvParseFloat(row.Latitude)
		longitude, lonErr := strconvParseFloat(row.Longitude)
		name := sanitizeGeocoderText(row.DisplayName, 240)
		if latErr != nil || lonErr != nil || name == "" || !withinTehran(latitude, longitude) {
			continue
		}
		key := fmt.Sprintf("%.6f:%.6f:%s", latitude, longitude, name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		results = append(results, geocoderResult{Latitude: latitude, Longitude: longitude, DisplayName: name})
		if len(results) == 5 {
			break
		}
	}
	return results, http.StatusOK, nil
}

func sanitizeGeocoderText(value string, maxLength int) string {
	var builder strings.Builder
	space := true
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			if !space {
				builder.WriteByte(' ')
				space = true
			}
			continue
		}
		builder.WriteRune(r)
		space = false
	}
	runes := []rune(builder.String())
	if len(runes) > maxLength {
		runes = runes[:maxLength]
	}
	return strings.TrimSpace(string(runes))
}

func strconvParseFloat(value string) (float64, error) {
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, fmt.Errorf("invalid float")
	}
	return parsed, nil
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	if decoder.Decode(target) != nil {
		return false
	}
	var trailing any
	return errors.Is(decoder.Decode(&trailing), io.EOF)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func newUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func requestIdentity(r *http.Request) auth.Identity {
	return r.Context().Value(identityKey{}).(auth.Identity)
}
