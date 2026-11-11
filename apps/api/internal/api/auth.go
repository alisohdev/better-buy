package api

import (
	"encoding/json"
	"errors"
	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
	"io"
	"net"
	"net/http"
	"strings"
)

type credentials struct {
	Name        string `json:"name"`
	Phone       string `json:"phone"`
	Password    string `json:"password"`
	Purpose     string `json:"purpose"`
	ChallengeID string `json:"challengeId"`
	Code        string `json:"code"`
	Ticket      string `json:"ticket"`
}

func registerAuth(mux *http.ServeMux, service *auth.Service, devMode bool) {
	mux.HandleFunc("GET /api/auth/get-session", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		identity, e := service.Session(r)
		if e != nil {
			writeAuthError(w, 503, "دریافت نشست ممکن نشد.")
			return
		}
		writeJSON(w, 200, identity)
	})
	for _, path := range []string{"otp/start", "otp/verify", "sign-up/phone", "sign-in/phone", "password/reset", "sign-out"} {
		mux.HandleFunc("POST /api/auth/"+path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			ip, _, _ := net.SplitHostPort(r.RemoteAddr)
			if e := service.Limit(r.Context(), "ip:"+ip, 900, 60); e != nil {
				writeAuthError(w, 429, auth.ErrLimited.Error())
				return
			}
			var input credentials
			if path != "sign-out" && !decodeAuthBody(w, r, &input) {
				writeAuthError(w, 400, "درخواست معتبر نیست.")
				return
			}
			var result any = map[string]bool{"success": true}
			var e error
			var identity auth.Identity
			switch path {
			case "otp/start":
				if e = service.Limit(r.Context(), "sms-ip:"+ip, 86400, 30); e == nil {
					var id string
					id, e = service.Start(r.Context(), input.Phone, input.Purpose)
					result = map[string]any{"challengeId": id, "expiresIn": 180, "resendAfter": 60}
				}
			case "otp/verify":
				var ticket string
				ticket, e = service.Verify(r.Context(), input.ChallengeID, input.Code)
				result = map[string]string{"ticket": ticket}
			case "sign-up/phone":
				identity, e = service.Complete(r.Context(), input.Ticket, input.Name, input.Password, false)
			case "sign-in/phone":
				phone, _ := auth.NormalizePhone(input.Phone)
				if e = service.Limit(r.Context(), "login:"+phone, 900, 15); e == nil {
					identity, e = service.SignIn(r.Context(), input.Phone, input.Password)
				}
			case "password/reset":
				_, e = service.Complete(r.Context(), input.Ticket, "", input.Password, true)
			case "sign-out":
				e = service.SignOut(r.Context(), r)
				service.ClearSessionCookie(w)
			}
			if e != nil {
				status := 400
				message := auth.ErrInvalidCredentials.Error()
				if errors.Is(e, auth.ErrNotRegistered) {
					status = 404
					message = e.Error()
				}
				if errors.Is(e, auth.ErrLimited) {
					status = 429
					message = e.Error()
				}
				if errors.Is(e, auth.ErrDelivery) {
					status = 503
					message = e.Error()
				}
				writeAuthError(w, status, message)
				return
			}
			if identity.User.ID != "" {
				service.SetSessionCookie(w, identity.Session.Token)
				result = map[string]any{"user": identity.User}
			}
			_ = service.Cleanup(r.Context())
			writeJSON(w, 200, result)
		})
	}
}
func decodeAuthBody(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return false
	}
	var extra any
	return errors.Is(decoder.Decode(&extra), io.EOF)
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "status": status}})
}

func authRequestPath(path string) bool {
	return strings.HasPrefix(path, "/api/auth/")
}
