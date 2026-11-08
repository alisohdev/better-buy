package api

import (
	"context"
	"encoding/json"
	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"net/http"
	"strings"
	"testing"
)

func TestPhoneAuthHTTPContract(t *testing.T) {
	db, cfg := analyticsTestDatabase(t)
	service := auth.New(db, cfg.BetterAuthSecret, cfg.BetterAuthURL)
	code := ""
	service.SMS = auth.MockSMSProvider{Receive: func(_, v string) { code = v }}
	mux := http.NewServeMux()
	registerAuth(mux, service, false)
	handler := cors(cfg.CORSOrigins, mux)
	start := analyticsTestRequest(handler, "POST", "/api/auth/otp/start", `{"phone":"09123456789","purpose":"registration"}`, nil)
	if start.Code != 200 {
		t.Fatal(start.Body.String())
	}
	var challenge struct {
		ChallengeID string `json:"challengeId"`
	}
	json.Unmarshal(start.Body.Bytes(), &challenge)
	verify := analyticsTestRequest(handler, "POST", "/api/auth/otp/verify", `{"challengeId":"`+challenge.ChallengeID+`","code":"`+code+`"}`, nil)
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	json.Unmarshal(verify.Body.Bytes(), &ticket)
	signup := analyticsTestRequest(handler, "POST", "/api/auth/sign-up/phone", `{"name":"User","password":"a long passphrase","ticket":"`+ticket.Ticket+`"}`, nil)
	if signup.Code != 200 || strings.Contains(signup.Body.String(), "token") {
		t.Fatal(signup.Code, signup.Body.String())
	}
	cookie := signup.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.MaxAge == 0 {
		t.Fatal("insecure cookie")
	}
	session := analyticsTestRequest(handler, "GET", "/api/auth/get-session", "", cookie)
	if session.Code != 200 || strings.Contains(session.Body.String(), `"token"`) {
		t.Fatal(session.Body.String())
	}
	other := analyticsTestRequest(handler, "GET", "/api/auth/get-session", "", nil)
	if strings.TrimSpace(other.Body.String()) != "null" {
		t.Fatal(other.Body.String())
	}
	for _, path := range []string{"/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/google/start", "/api/auth/callback/google", "/api/auth/test-login"} {
		r := analyticsTestRequest(handler, "POST", path, `{}`, nil)
		if r.Code != 404 {
			t.Fatal("obsolete route", path, r.Code)
		}
	}
	logout := analyticsTestRequest(handler, "POST", "/api/auth/sign-out", "", cookie)
	if logout.Code != 200 {
		t.Fatal(logout.Code)
	}
	r := analyticsTestRequest(handler, "GET", "/api/auth/get-session", "", cookie)
	if strings.TrimSpace(r.Body.String()) != "null" {
		t.Fatal("logout ineffective")
	}
	if err := service.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
}
