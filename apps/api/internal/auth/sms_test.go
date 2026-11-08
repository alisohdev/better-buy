package auth

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestProviderContracts(t *testing.T) {
	ctx := context.Background()
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.iranpayamak.com" || r.Header.Get("Api-Key") != "secret" {
			t.Fatal("IranPayamak request")
		}
		var body map[string]any
		if e := json.NewDecoder(r.Body).Decode(&body); e != nil {
			t.Fatal(e)
		}
		if body["recipient"] != "09123456789" || body["number_format"] != "english" {
			t.Fatal(body)
		}
		return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader(`{"status":"success","data":123}`))}, nil
	})}
	p := IranPayamakProvider{APIKey: "secret", Pattern: "approved", Line: "line", Domain: "better-buy.ir", Client: client}
	if e := p.SendOTP(ctx, "+989123456789", "123456"); e != nil {
		t.Fatal(e)
	}
	client.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		if e := r.ParseForm(); e != nil {
			t.Fatal(e)
		}
		if r.URL.Host != "rest.payamak-panel.com" || r.Form.Get("text") != "123456;123456" || r.Form.Get("bodyId") != "42" {
			t.Fatal("MeliPayamak request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"Value":"1234567890123456","RetStatus":1}`))}, nil
	})
	m := MeliPayamakProvider{Username: "user", Password: "secret", Pattern: "42", Client: client}
	if e := m.SendOTP(ctx, "+989123456789", "123456"); e != nil {
		t.Fatal(e)
	}
	for _, body := range []string{`{"RetStatus":1,"Value":"2"}`, `{"RetStatus":0,"Value":"1234567890123456"}`, `bad-json`} {
		client.Transport = roundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
		})
		if e := m.SendOTP(ctx, "+989123456789", "123456"); e == nil {
			t.Fatal("accepted provider failure")
		}
	}
}
func TestDuplicateRegistrationAndTicketPurpose(t *testing.T) {
	s, db, code := setup(t)
	ctx := context.Background()
	id, e := s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	ticket, e := s.Verify(ctx, id, *code)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Complete(ctx, ticket, "", "new long password", true); e == nil {
		t.Fatal("cross-purpose ticket")
	}
	first, e := s.Complete(ctx, ticket, "User", "new long password", false)
	if e != nil {
		t.Fatal(e)
	}
	db.Exec(`UPDATE otp_challenges SET created=created-61`)
	id, e = s.Start(ctx, "09123456789", "registration")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = s.Verify(ctx, id, *code); e == nil {
		t.Fatal("duplicate phone issued registration ticket")
	}
	var count int
	db.QueryRow(`SELECT COUNT(*) FROM "user" WHERE phone=?`, first.User.Phone).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
}
