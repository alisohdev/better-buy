package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/alirezasoheili/better-buy/apps/api/internal/auth"
)

type credentials struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
}

func registerAuth(mux *http.ServeMux, service *auth.Service, devMode bool) {
	mux.HandleFunc("POST /api/auth/test-login", func(w http.ResponseWriter, r *http.Request) {
		if !devMode {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "NOT_FOUND"})
			return
		}
		identity, err := service.TestLogin(r.Context())
		if err != nil {
			writeAuthError(w, http.StatusInternalServerError, "Local sign in failed.")
			return
		}
		service.SetSessionCookie(w, identity.Session.Token)
		writeJSON(w, http.StatusOK, map[string]any{"data": map[string]bool{"ok": true}})
	})
	mux.HandleFunc("GET /api/auth/get-session", func(w http.ResponseWriter, r *http.Request) {
		identity, err := service.Session(r)
		if err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": map[string]string{"message": "Could not read the current session."}})
			return
		}
		writeJSON(w, http.StatusOK, identity)
	})
	mux.HandleFunc("POST /api/auth/sign-up/email", func(w http.ResponseWriter, r *http.Request) {
		var input credentials
		if !decodeAuthBody(w, r, &input) {
			writeAuthError(w, http.StatusBadRequest, "Invalid request.")
			return
		}
		identity, err := service.SignUp(r.Context(), input.Name, input.Email, input.Password)
		if err != nil {
			switch {
			case errors.Is(err, auth.ErrEmailExists):
				writeAuthError(w, http.StatusConflict, "An account already exists for this email.")
			case errors.Is(err, auth.ErrInvalidCredentials):
				writeAuthError(w, http.StatusBadRequest, "Check the email and password and try again.")
			default:
				writeAuthError(w, http.StatusInternalServerError, "Could not create the account.")
			}
			return
		}
		service.SetSessionCookie(w, identity.Session.Token)
		writeJSON(w, http.StatusOK, map[string]any{"token": identity.Session.Token, "user": identity.User})
	})
	mux.HandleFunc("POST /api/auth/sign-in/email", func(w http.ResponseWriter, r *http.Request) {
		var input credentials
		if !decodeAuthBody(w, r, &input) {
			writeAuthError(w, http.StatusBadRequest, "Invalid request.")
			return
		}
		identity, err := service.SignIn(r.Context(), input.Email, input.Password)
		if err != nil {
			if errors.Is(err, auth.ErrInvalidCredentials) {
				writeAuthError(w, http.StatusUnauthorized, "Invalid email or password.")
			} else {
				writeAuthError(w, http.StatusInternalServerError, "Could not sign in.")
			}
			return
		}
		service.SetSessionCookie(w, identity.Session.Token)
		writeJSON(w, http.StatusOK, map[string]any{"token": identity.Session.Token, "user": identity.User})
	})
	mux.HandleFunc("POST /api/auth/sign-out", func(w http.ResponseWriter, r *http.Request) {
		if err := service.SignOut(r.Context(), r); err != nil {
			writeAuthError(w, http.StatusInternalServerError, "Could not sign out.")
			return
		}
		service.ClearSessionCookie(w)
		writeJSON(w, http.StatusOK, map[string]bool{"success": true})
	})
	mux.HandleFunc("GET /api/auth/google/start", func(w http.ResponseWriter, r *http.Request) {
		if err := service.BeginGoogle(w, r); err != nil {
			writeAuthError(w, http.StatusBadRequest, "Could not start Google sign in.")
		}
	})
	mux.HandleFunc("GET /api/auth/callback/google", func(w http.ResponseWriter, r *http.Request) {
		if err := service.CompleteGoogle(w, r); err != nil {
			service.ClearSessionCookie(w)
			http.Redirect(w, r, "/?authError=google", http.StatusSeeOther)
		}
	})
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
