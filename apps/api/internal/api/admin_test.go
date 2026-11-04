package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/analytics"
	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
)

func analyticsTestDatabase(t *testing.T) (*sql.DB, config.Config) {
	t.Helper()
	db, err := storage.Open(context.Background(), filepath.Join(t.TempDir(), "analytics.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := storage.ApplyMigrations(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	return db, config.Config{BetterAuthSecret: "analytics-test-secret", BetterAuthURL: "http://localhost:8787", CORSOrigins: []string{"http://localhost:3000"}, AdminEmails: []string{"admin@example.com"}, APIRateLimitsEnabled: true}
}

func analyticsTestUser(t *testing.T, db *sql.DB, cfg config.Config, id, email string, verified bool) *http.Cookie {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)`, id, "User "+id, email, verified, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)`, id+"-session", id, id+"-token", time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), now, now); err != nil {
		t.Fatal(err)
	}
	service := auth.New(db, cfg.BetterAuthSecret, cfg.BetterAuthURL, "", "")
	recorder := httptest.NewRecorder()
	service.SetSessionCookie(recorder, id+"-token")
	return recorder.Result().Cookies()[0]
}

func analyticsTestRequest(handler http.Handler, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		request.AddCookie(cookie)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestAdminRequiresExplicitVerifiedEmail(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	admin := analyticsTestUser(t, db, cfg, "admin", "admin@example.com", true)
	member := analyticsTestUser(t, db, cfg, "member", "member@example.com", true)
	handler := New(db, cfg, nil)
	for _, path := range []string{"/api/admin/analytics", "/api/admin/users", "/api/admin/users/admin"} {
		if response := analyticsTestRequest(handler, "GET", path, "", nil); response.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous %s: %d", path, response.Code)
		}
		if response := analyticsTestRequest(handler, "GET", path, "", member); response.Code != http.StatusForbidden {
			t.Fatalf("ordinary member %s: %d", path, response.Code)
		}
		response := analyticsTestRequest(handler, "GET", path, "", admin)
		if response.Code != http.StatusOK {
			t.Fatalf("admin %s: %d %s", path, response.Code, response.Body.String())
		}
		if !strings.Contains(response.Header().Get("Cache-Control"), "no-store") {
			t.Fatalf("admin data was cacheable: %s", path)
		}
	}
	if response := analyticsTestRequest(handler, "GET", "/api/admin/access", "", member); !strings.Contains(response.Body.String(), `"allowed":false`) {
		t.Fatal(response.Body.String())
	}
	if response := analyticsTestRequest(handler, "GET", "/api/admin/access", "", admin); !strings.Contains(response.Body.String(), `"allowed":true`) {
		t.Fatal(response.Body.String())
	}
	if _, err := db.Exec(`UPDATE "user" SET emailVerified=0 WHERE id='admin'`); err != nil {
		t.Fatal(err)
	}
	if response := analyticsTestRequest(handler, "GET", "/api/admin/analytics", "", admin); response.Code != http.StatusForbidden {
		t.Fatalf("unverified allowlisted account: %d", response.Code)
	}
	if _, err := db.Exec(`UPDATE "user" SET emailVerified=1 WHERE id='admin'`); err != nil {
		t.Fatal(err)
	}
	cfg.AdminEmails = nil
	if response := analyticsTestRequest(New(db, cfg, nil), "GET", "/api/admin/analytics", "", admin); response.Code != http.StatusForbidden {
		t.Fatalf("empty allowlist granted access: %d", response.Code)
	}
}

func TestAnalyticsCollectsRealEventsAndAdminUserContents(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	admin := analyticsTestUser(t, db, cfg, "admin", "admin@example.com", true)
	member := analyticsTestUser(t, db, cfg, "member", "member@example.com", true)
	handler := New(db, cfg, nil)
	const visitor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	visit := `{"id":"11111111-1111-4111-8111-111111111111","visitorId":"` + visitor + `","kind":"visit"}`
	for range 2 {
		if response := analyticsTestRequest(handler, "POST", "/api/analytics/events", visit, nil); response.Code != http.StatusNoContent {
			t.Fatalf("anonymous visit: %d %s", response.Code, response.Body.String())
		}
	}
	search := `{"id":"33333333-3333-4333-8333-333333333333","visitorId":"` + visitor + `","kind":"search","query":"  milk   powder  ","source":"all"}`
	if response := analyticsTestRequest(handler, "POST", "/api/analytics/events", search, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous search: %d", response.Code)
	}
	if response := analyticsTestRequest(handler, "POST", "/api/analytics/events", search, member); response.Code != http.StatusNoContent {
		t.Fatalf("member search: %d %s", response.Code, response.Body.String())
	}
	signedVisit := strings.ReplaceAll(visit, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if response := analyticsTestRequest(handler, "POST", "/api/analytics/events", signedVisit, member); response.Code != http.StatusNoContent {
		t.Fatalf("member visit: %d", response.Code)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, statement := range []string{
		`INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at) VALUES('member-location','member','Home',35.7,51.4,1,?,?)`,
		`INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at,finished_at) VALUES('member-scan','member','member-location',15,'okala','partial','succeeded',?,?)`,
		`INSERT INTO provider_carts(user_id,source,group_key,title,quantity,origin_scan_id,created_at,updated_at) VALUES('member','okala','milk','Milk powder',3,'member-scan',?,?)`,
	} {
		if _, err := db.Exec(statement, now, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO wishlist_items(id,user_id,phrase,normalized_phrase,tokens_json,created_at) VALUES('wishlist-member','member','Milk powder','milk powder','["milk","powder"]',?)`, now); err != nil {
		t.Fatal(err)
	}
	response := analyticsTestRequest(handler, "GET", "/api/admin/analytics", "", admin)
	var overview struct {
		Data analytics.Overview `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &overview) != nil {
		t.Fatalf("overview: %d %s", response.Code, response.Body.String())
	}
	if got := overview.Data.Totals; got.Users != 2 || got.Visits != 2 || got.Visitors != 1 || got.Searches != 1 || got.Scans != 1 || got.Locations != 1 || got.WishlistItems != 1 || got.CartItems != 3 {
		t.Fatalf("incorrect analytics totals: %+v", got)
	}
	if len(overview.Data.Days) != 30 || overview.Data.Days[29].Visits != 2 {
		t.Fatalf("incorrect daily analytics: %+v", overview.Data.Days)
	}
	if len(overview.Data.TopSearches) != 1 || overview.Data.TopSearches[0].Query != "milk powder" {
		t.Fatalf("incorrect searches: %+v", overview.Data.TopSearches)
	}
	response = analyticsTestRequest(handler, "GET", "/api/admin/users?q=member%40example&page=1", "", admin)
	var users struct {
		Data analytics.UserPage `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &users) != nil {
		t.Fatalf("users: %d %s", response.Code, response.Body.String())
	}
	if users.Data.Total != 1 || len(users.Data.Users) != 1 || users.Data.Users[0].Scans != 1 || users.Data.Users[0].Visits != 1 || users.Data.Users[0].Searches != 1 {
		t.Fatalf("incorrect user summary: %+v", users.Data)
	}
	response = analyticsTestRequest(handler, "GET", "/api/admin/users/member", "", admin)
	var detail struct {
		Data analytics.UserDetail `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &detail) != nil {
		t.Fatalf("detail: %d %s", response.Code, response.Body.String())
	}
	if len(detail.Data.Locations) != 1 || detail.Data.Locations[0].Name != "Home" || len(detail.Data.Wishlist) != 1 || detail.Data.Wishlist[0].Phrase != "Milk powder" || detail.Data.Wishlist[0].MinDiscount != 15 || len(detail.Data.Cart) != 1 || detail.Data.Cart[0].Quantity != 3 || len(detail.Data.RecentSearches) != 1 {
		t.Fatalf("incorrect detail: %+v", detail.Data)
	}
	if response := analyticsTestRequest(handler, "GET", "/api/admin/users/no-such-user", "", admin); response.Code != http.StatusNotFound {
		t.Fatalf("unknown user: %d", response.Code)
	}
}

func TestAnalyticsRejectsUntrustedOriginsAndInvalidEvents(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	handler := New(db, cfg, nil)
	const visit = `{"id":"11111111-1111-4111-8111-111111111111","visitorId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","kind":"visit"}`
	for _, origin := range []string{"", "https://untrusted.example"} {
		request := httptest.NewRequest("POST", "/api/analytics/events", strings.NewReader(visit))
		request.Header.Set("Origin", origin)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusForbidden {
			t.Fatalf("origin %q: %d", origin, recorder.Code)
		}
	}
	for _, body := range []string{
		strings.Replace(visit, "11111111-1111-4111-8111-111111111111", "bad-id", 1),
		strings.TrimSuffix(visit, "}") + `,"userId":"admin"}`,
		strings.TrimSuffix(visit, "}") + `,"query":"unexpected"}`,
		visit + ` {}`,
		strings.Repeat("x", 20<<10),
	} {
		if response := analyticsTestRequest(handler, "POST", "/api/analytics/events", body, nil); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid event returned %d: %s", response.Code, response.Body.String())
		}
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM analytics_events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("stored %d rejected events", count)
	}
}
