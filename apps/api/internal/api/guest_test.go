package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

func TestGuestIsolationAndAccountOnlyFeatures(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, cfg, queue)
	create := func() *http.Cookie {
		response := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil)
		if response.Code != 200 {
			t.Fatalf("guest: %d %s", response.Code, response.Body.String())
		}
		cookies := response.Result().Cookies()
		if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].MaxAge != 86400 {
			t.Fatal("guest cookie protection")
		}
		return cookies[0]
	}
	first, second := create(), create()
	saved := analyticsTestRequest(handler, "POST", "/api/locations", `{"name":"Guest home","latitude":35.7,"longitude":51.4,"isDefault":true}`, first)
	if saved.Code != 201 {
		t.Fatalf("location: %d %s", saved.Code, saved.Body.String())
	}
	var item struct {
		Data location `json:"data"`
	}
	if err := json.Unmarshal(saved.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	other := analyticsTestRequest(handler, "GET", "/api/locations", "", second)
	if other.Code != 200 || string(other.Body.Bytes()) != "{\"data\":[]}\n" {
		t.Fatal("guest data leaked", other.Body.String())
	}
	started := analyticsTestRequest(handler, "POST", "/api/scans", `{"locationId":"`+item.Data.ID+`","source":"okala","threshold":15,"mode":"partial"}`, first)
	if started.Code != 202 {
		t.Fatalf("scan: %d %s", started.Code, started.Body.String())
	}
	var scan struct {
		Data scans.Record `json:"data"`
	}
	json.Unmarshal(started.Body.Bytes(), &scan)
	if response := analyticsTestRequest(handler, "GET", "/api/scans/"+scan.Data.ID, "", second); response.Code != 404 {
		t.Fatal("scan ownership", response.Code)
	}
	for _, path := range []string{"/api/wishlist", "/api/notifications", "/api/admin/access", "/api/carts/okala"} {
		if response := analyticsTestRequest(handler, "GET", path, "", first); response.Code != 401 {
			t.Fatal("guest bypassed account boundary", path, response.Code)
		}
	}
	if _, err := db.Exec("UPDATE guest_sessions SET expires_at=?", time.Now().Add(-time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	if response := analyticsTestRequest(handler, "GET", "/api/locations", "", first); response.Code != 401 {
		t.Fatal("expired guest session accepted")
	}
	create()
	var count int
	if err := db.QueryRow("SELECT count(*) FROM scans WHERE id=?", scan.Data.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("active scan removed by guest cleanup", count, err)
	}
	if _, err := db.Exec("UPDATE scans SET status='cancelled' WHERE id=?", scan.Data.ID); err != nil {
		t.Fatal(err)
	}
	create()
	if err := db.QueryRow("SELECT count(*) FROM scans WHERE id=?", scan.Data.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("expired guest data retained after cleanup", count, err)
	}
}

func TestGuestSessionOriginAndBootstrapLimits(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	handler := New(db, cfg, nil)
	rejected := httptest.NewRequest("POST", "/api/guest/session", nil)
	rejected.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, rejected)
	if response.Code != 403 {
		t.Fatal("cross-site guest creation", response.Code)
	}
	request := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil)
	if request.Code != 200 {
		t.Fatal(request.Code)
	}
	for index := 0; index < 9; index++ {
		analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil)
	}
	if response := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil); response.Code != 429 {
		t.Fatal("guest bootstrap unbounded", response.Code)
	}
}

func TestGuestAddressTrustsOnlyLoopbackProxy(t *testing.T) {
	request := httptest.NewRequest("POST", "/api/guest/session", nil)
	request.RemoteAddr = "192.0.2.1:1234"
	request.Header.Set("X-Real-IP", "198.51.100.1")
	if guestAddress(request) != guestHash("192.0.2.1") {
		t.Fatal("untrusted address override")
	}
	request.RemoteAddr = "127.0.0.1:1234"
	if guestAddress(request) != guestHash("198.51.100.1") {
		t.Fatal("trusted Caddy address ignored")
	}
}

func TestGuestProductionCookieIsHostBound(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	cfg.BetterAuthURL = "https://better-buy.example"
	handler := New(db, cfg, nil)
	response := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil)
	cookie := response.Result().Cookies()[0]
	if !cookie.Secure || !cookie.HttpOnly || cookie.Name != "__Host-better-buy.guest" || cookie.Domain != "" || cookie.Path != "/" {
		t.Fatal("production guest cookie protection", cookie)
	}
	if response := analyticsTestRequest(handler, "GET", "/api/locations", "", cookie); response.Code != 200 {
		t.Fatal(response.Code)
	}
	cookie.Name = guestCookieName
	if response := analyticsTestRequest(handler, "GET", "/api/locations", "", cookie); response.Code != 401 {
		t.Fatal("production accepted insecure cookie name")
	}
}

func TestGuestLocationImportIsIdempotentAndAccountOnly(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	handler := New(db, cfg, nil)
	cookie := analyticsTestUser(t, db, cfg, "member", "member", false)
	body := `{"guestId":"11111111-1111-4111-8111-111111111111","name":"Guest home","latitude":35.7,"longitude":51.4,"isDefault":true}`
	if response := analyticsTestRequest(handler, "POST", "/api/locations/import", body, nil); response.Code != 401 {
		t.Fatal(response.Code)
	}
	for index := 0; index < 2; index++ {
		if response := analyticsTestRequest(handler, "POST", "/api/locations/import", body, cookie); response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	var count int
	if err := db.QueryRow("SELECT count(*) FROM locations WHERE user_id='member'").Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate import", count, err)
	}
	changed := `{"guestId":"11111111-1111-4111-8111-111111111111","name":"Changed guest home","latitude":35.71,"longitude":51.4,"isDefault":true}`
	if response := analyticsTestRequest(handler, "POST", "/api/locations/import", changed, cookie); response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	if err := db.QueryRow("SELECT count(*) FROM locations WHERE user_id='member'").Scan(&count); err != nil || count != 2 {
		t.Fatal("new guest coordinates were ignored", count, err)
	}
	if err := db.QueryRow("SELECT count(*) FROM locations WHERE user_id='member' AND is_default=1 AND latitude=35.7").Scan(&count); err != nil || count != 1 {
		t.Fatal("existing account default overwritten", count, err)
	}
	mismatch := `{"userId":"another-member","guestId":"11111111-1111-4111-8111-111111111111","name":"Home","latitude":35.7,"longitude":51.4,"isDefault":true}`
	if response := analyticsTestRequest(handler, "POST", "/api/locations/import", mismatch, cookie); response.Code != 409 {
		t.Fatal("import crossed account switch", response.Code)
	}
	invalid := `{"guestId":"22222222-2222-4222-8222-222222222222","name":"Outside","latitude":0,"longitude":0,"isDefault":true}`
	if response := analyticsTestRequest(handler, "POST", "/api/locations/import", invalid, cookie); response.Code != 422 {
		t.Fatal("outside location accepted", response.Code)
	}
}

func TestGuestScanBudgetCannotBeResetByNewCookie(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, cfg, queue)
	first := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil).Result().Cookies()[0]
	second := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil).Result().Cookies()[0]
	body := `{"locationId":"11111111-1111-4111-8111-111111111111","source":"okala","threshold":15,"mode":"partial"}`
	for index := 0; index < 10; index++ {
		cookie := first
		if index >= 5 {
			cookie = second
		}
		analyticsTestRequest(handler, "POST", "/api/scans", body, cookie)
	}
	third := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil).Result().Cookies()[0]
	if response := analyticsTestRequest(handler, "POST", "/api/scans", body, third); response.Code != 429 {
		t.Fatal("new cookie reset scan budget", response.Code, response.Body.String())
	}
}

func TestDeleteLastLocation(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, cfg, queue)
	first := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil).Result().Cookies()[0]
	second := analyticsTestRequest(handler, "POST", "/api/guest/session", "{}", nil).Result().Cookies()[0]
	saved := analyticsTestRequest(handler, "POST", "/api/locations", `{"name":"Home","latitude":35.7,"longitude":51.4,"isDefault":true}`, first)
	if saved.Code != 201 {
		t.Fatal(saved.Code, saved.Body.String())
	}
	var item struct {
		Data location `json:"data"`
	}
	if err := json.Unmarshal(saved.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	started := analyticsTestRequest(handler, "POST", "/api/scans", `{"locationId":"`+item.Data.ID+`","source":"okala","threshold":15,"mode":"partial"}`, first)
	if started.Code != 202 {
		t.Fatal(started.Code, started.Body.String())
	}
	var scan struct {
		Data scans.Record `json:"data"`
	}
	if err := json.Unmarshal(started.Body.Bytes(), &scan); err != nil {
		t.Fatal(err)
	}
	if response := analyticsTestRequest(handler, "DELETE", "/api/locations/"+item.Data.ID, "", first); response.Code != 409 {
		t.Fatal("active scan protection", response.Code)
	}
	if _, err := db.Exec("UPDATE scans SET status='succeeded' WHERE id=?", scan.Data.ID); err != nil {
		t.Fatal(err)
	}
	path := "/api/locations/" + item.Data.ID
	if response := analyticsTestRequest(handler, "DELETE", path, "", second); response.Code != 404 {
		t.Fatal("ownership", response.Code)
	}
	if response := analyticsTestRequest(handler, "DELETE", path, "", first); response.Code != 204 {
		t.Fatal("last location", response.Code, response.Body.String())
	}
	for _, table := range []string{"scans", "vps_scan_jobs"} {
		var count int
		column := "scan_id"
		if table == "scans" {
			column = "id"
		}
		if err := db.QueryRow("SELECT COUNT(*) FROM "+table+" WHERE "+column+"=?", scan.Data.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s history retained after location deletion", table)
		}
	}
	response := analyticsTestRequest(handler, "GET", "/api/locations", "", first)
	if response.Code != 200 || response.Body.String() != "{\"data\":[]}\n" {
		t.Fatal("empty locations", response.Code, response.Body.String())
	}
}
