package auth

import (
	"context"
	"database/sql"
	"errors"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func setup(t *testing.T) (*Service, *sql.DB, *string) {
	t.Helper()
	db, e := storage.Open(context.Background(), filepath.Join(t.TempDir(), "auth.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	if e = storage.ApplyMigrations(context.Background(), db); e != nil {
		t.Fatal(e)
	}
	s := New(db, strings.Repeat("s", 32), "http://localhost:8787")
	code := new(string)
	s.SMS = MockSMSProvider{Receive: func(_, v string) { *code = v }}
	return s, db, code
}
func TestNormalizePhone(t *testing.T) {
	for _, p := range []string{"09123456789", "989123456789", "+989123456789", "۰۹۱۲۳۴۵۶۷۸۹", "٠٩١٢٣٤٥٦٧٨٩"} {
		got, e := NormalizePhone(p)
		if e != nil || got != "+989123456789" {
			t.Fatal(p, got, e)
		}
	}
	for _, p := range []string{"", "09123", "02123456789", "+971912345678", "0912345678x", "091234567890", "9123456789"} {
		if _, e := NormalizePhone(p); e == nil {
			t.Fatal(p)
		}
	}
}
func TestRegistrationLoginReset(t *testing.T) {
	s, db, code := setup(t)
	ctx := context.Background()
	id, e := s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	if len(*code) != 6 {
		t.Fatal("code length")
	}
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM "user"`).Scan(&count)
	if count != 0 {
		t.Fatal("premature user")
	}
	ticket, e := s.Verify(ctx, id, *code)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Verify(ctx, id, *code); e == nil {
		t.Fatal("replay")
	}
	identity, e := s.Complete(ctx, ticket, "نام", "long passphrase 123", false)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Complete(ctx, ticket, "نام", "long passphrase 123", false); e == nil {
		t.Fatal("ticket replay")
	}
	if _, e = s.SignIn(ctx, "09123456789", "wrong password"); e == nil {
		t.Fatal("bad password")
	}
	login, e := s.SignIn(ctx, "۰۹۱۲۳۴۵۶۷۸۹", "long passphrase 123")
	if e != nil || login.User.ID != identity.User.ID {
		t.Fatal(e)
	}
	rec := httptest.NewRecorder()
	s.SetSessionCookie(rec, login.Session.Token)
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(rec.Result().Cookies()[0])
	if session, e := s.Session(r); e != nil || session == nil {
		t.Fatal(e)
	}
	db.Exec(`UPDATE otp_challenges SET created=created-61`)
	id, e = s.Start(ctx, "09123456789", "password_reset")
	if e != nil {
		t.Fatal(e)
	}
	ticket, e = s.Verify(ctx, id, *code)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Complete(ctx, ticket, "", "replacement password", true); e != nil {
		t.Fatal(e)
	}
	if session, e := s.Session(r); e != nil || session != nil {
		t.Fatal("session not revoked")
	}
	if _, e = s.SignIn(ctx, "09123456789", "long passphrase 123"); e == nil {
		t.Fatal("old password")
	}
	if _, e = s.SignIn(ctx, "09123456789", "replacement password"); e != nil {
		t.Fatal(e)
	}
}
func TestOTPAbuseAndExpiry(t *testing.T) {
	s, db, code := setup(t)
	ctx := context.Background()
	id, e := s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	old := *code
	if _, e = s.Start(ctx, "09123456789", "registration"); !errors.Is(e, ErrLimited) {
		t.Fatal("cooldown", e)
	}
	db.Exec(`UPDATE otp_challenges SET created=created-61`)
	next, e := s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Verify(ctx, id, old); e == nil {
		t.Fatal("old challenge")
	}
	wrong := "000000"
	if wrong == *code {
		wrong = "111111"
	}
	for i := 0; i < 5; i++ {
		if _, e = s.Verify(ctx, next, wrong); e == nil {
			t.Fatal("wrong accepted")
		}
	}
	if _, e = s.Verify(ctx, next, *code); e == nil {
		t.Fatal("lockout bypass")
	}
	db.Exec(`UPDATE otp_challenges SET created=created-61`)
	id, e = s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	db.Exec(`UPDATE otp_challenges SET expires=?`, time.Now().Unix()-1)
	if _, e = s.Verify(ctx, id, *code); e == nil {
		t.Fatal("expired accepted")
	}
}
func TestConcurrentVerify(t *testing.T) {
	s, _, code := setup(t)
	ctx := context.Background()
	id, e := s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	success := 0
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.Verify(ctx, id, *code); e == nil {
				mu.Lock()
				success++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if success != 1 {
		t.Fatal(success)
	}
}
func TestRecoveryUnknownAndLimits(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	sent := false
	s.SMS = MockSMSProvider{Receive: func(string, string) { sent = true }}
	id, e := s.Start(ctx, "09123456789", "password_reset")
	if e != nil || id == "" || sent {
		t.Fatal("unknown recovery", e)
	}
	for i := 0; i < 3; i++ {
		if e = s.Limit(ctx, "test", 60, 3); e != nil {
			t.Fatal(e)
		}
	}
	if e = s.Limit(ctx, "test", 60, 3); !errors.Is(e, ErrLimited) {
		t.Fatal(e)
	}
}

type failingSMS struct{}

func (failingSMS) SendOTP(context.Context, string, string) error {
	return errors.New("provider details")
}
func TestDeliveryFailureCannotVerify(t *testing.T) {
	s, _, _ := setup(t)
	s.SMS = failingSMS{}
	id, e := s.Start(context.Background(), "09123456789", "registration")
	if e != nil || id == "" {
		t.Fatal("enumeration-resistant failure")
	}
	if _, e = s.Verify(context.Background(), id, "000000"); e == nil {
		t.Fatal("failed delivery verified")
	}
}
