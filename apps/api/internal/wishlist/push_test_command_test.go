package wishlist

import (
	"bytes"
	"context"
	"crypto/elliptic"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
	_ "modernc.org/sqlite"
)

type pushRoundTrip func(*http.Request) (*http.Response, error)

func (f pushRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTestPushScopedAndExpired(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	for _, q := range []string{`CREATE TABLE "user" (id TEXT, email TEXT)`, `CREATE TABLE push_subscriptions (id TEXT, user_id TEXT, encrypted_subscription TEXT)`, `INSERT INTO "user" VALUES ('u1','one@example.com'),('u2','two@example.com')`} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	cfg := PushConfig{PublicKey: pub, PrivateKey: priv, Subject: "mailto:test@example.com"}
	_, x, y, err := elliptic.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var sub pushSubscription
	sub.Endpoint = "https://fcm.googleapis.com/fcm/send/example"
	sub.Keys.P256DH = base64.RawURLEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), x, y))
	sub.Keys.Auth = base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	clear, _ := json.Marshal(sub)
	for _, entry := range []struct{ id, user string }{{"first", "u1"}, {"second", "u1"}, {"other", "u2"}} {
		encrypted, err := encrypt(clear, "secret", "push:"+entry.user+":"+entry.id)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(`INSERT INTO push_subscriptions VALUES (?,?,?)`, entry.id, entry.user, encrypted); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	client := &http.Client{Transport: pushRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		status := 201
		if calls == 2 {
			status = 410
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})}
	var out bytes.Buffer
	err = sendTestPush(context.Background(), db, "secret", cfg, "one@example.com", "", &out, client, stubTestProduct)
	if err == nil || calls != 2 || !strings.Contains(out.String(), "expired") {
		t.Fatalf("error=%v calls=%d output=%s", err, calls, out.String())
	}
	var count int
	if err = db.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE user_id='u2'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("other account affected: %d, %v", count, err)
	}
	if err = db.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE id='second'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired not removed: %d, %v", count, err)
	}
	if err = sendTestPush(context.Background(), db, "secret", cfg, "one@example.com", "u1", &out, client, stubTestProduct); err == nil {
		t.Fatal("accepted two selectors")
	}
	if err = sendTestPush(context.Background(), db, "secret", cfg, "missing@example.com", "", &out, client, stubTestProduct); err == nil || !strings.Contains(err.Error(), "account not found") {
		t.Fatalf("unknown account: %v", err)
	}
	if err = sendTestPush(context.Background(), db, "secret", PushConfig{}, "one@example.com", "", &out, client, stubTestProduct); err == nil {
		t.Fatal("accepted missing VAPID configuration")
	}
	if err = sendTestPush(context.Background(), db, "wrong key", cfg, "one@example.com", "", &out, client, stubTestProduct); err == nil || !strings.Contains(out.String(), "invalid stored subscription") {
		t.Fatalf("wrong encryption key: %v, %s", err, out.String())
	}
	if _, err = db.Exec(`DELETE FROM push_subscriptions WHERE user_id='u1'`); err != nil {
		t.Fatal(err)
	}
	if err = sendTestPush(context.Background(), db, "secret", cfg, "", "u1", &out, client, stubTestProduct); err == nil || !strings.Contains(err.Error(), "no subscriptions") {
		t.Fatalf("missing subscriptions: %v", err)
	}
}

func TestSelectTestProductUsesOwnedSavedScan(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "push.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.ApplyMigrations(ctx, db); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO locations(id,user_id,name,latitude,longitude,created_at,updated_at) VALUES('loc','owner','Home',35.7,51.4,'2026-01-01','2026-01-01')`,
		`INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at) VALUES('scan','owner','loc',15,'snappmarket','full','succeeded','2026-01-01')`,
		`INSERT INTO scan_execution(scan_id,user_id,instance_id,device_id,queued_until,created_at) VALUES('scan','owner','instance','device','2026-01-01','2026-01-01')`,
		`INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,vendor_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json) VALUES('deal','scan','deal','p','vendor','Tea','Store',100,50,50,50,2,'{}')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	match, scan, err := selectTestProduct(ctx, db, "key", "owner")
	if err != nil || scan != "scan" || match.Title != "Tea" || match.VendorTitle != "Store" || match.ProductKey == "" {
		t.Fatalf("match=%+v scan=%q err=%v", match, scan, err)
	}
	if _, _, err := selectTestProduct(ctx, db, "key", "another-user"); err == nil {
		t.Fatal("selected another account's product")
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM wishlist_notifications`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("test modified inbox: %d %v", count, err)
	}
}

func TestPushSenderRedactsErrorsAndRejectsRedirects(t *testing.T) {
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	_, x, y, err := elliptic.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var sub pushSubscription
	sub.Endpoint = "https://fcm.googleapis.com/private-endpoint"
	sub.Keys.P256DH = base64.RawURLEncoding.EncodeToString(elliptic.Marshal(elliptic.P256(), x, y))
	sub.Keys.Auth = base64.RawURLEncoding.EncodeToString(make([]byte, 16))
	clear, _ := json.Marshal(sub)
	encrypted, err := encrypt(clear, "key", "push:user:device")
	if err != nil {
		t.Fatal(err)
	}
	cfg := PushConfig{PublicKey: pub, PrivateKey: priv, Subject: "mailto:test@example.com"}
	client := &http.Client{Transport: pushRoundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("private-endpoint") })}
	_, err = sendPush(context.Background(), client, cfg, "key", "user", "device", encrypted, []byte(`{}`))
	if err == nil || strings.Contains(err.Error(), "private-endpoint") {
		t.Fatalf("unsafe error: %v", err)
	}
	client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: pushRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://example.com/"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})}
	status, err := sendPush(context.Background(), client, cfg, "key", "user", "device", encrypted, []byte(`{}`))
	if status != 302 || err == nil {
		t.Fatalf("redirect: %d, %v", status, err)
	}
}

func stubTestProduct(context.Context, *sql.DB, string, string) (Match, string, error) {
	return Match{Title: "test", Source: "snappmarket", ProductKey: "product", VendorID: "vendor", VendorTitle: "store", DiscountPercent: 50}, "scan", nil
}
