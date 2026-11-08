package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	cookieName      = "better-auth.session_token"
	secureCookie    = "__Secure-better-auth.session_token"
	sessionDuration = 30 * 24 * time.Hour
)

type Service struct {
	otpSecret []byte
	db        *sql.DB
	secret    []byte
	secure    bool
	SMS       SMSProvider
}
type User struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Phone         string    `json:"phone"`
	PhoneVerified bool      `json:"phoneVerified"`
	Image         *string   `json:"image"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}
type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Token     string    `json:"-"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type Identity struct {
	Session Session `json:"session"`
	User    User    `json:"user"`
}

func New(db *sql.DB, secret, baseURL string, unused ...string) *Service {
	s := &Service{db: db, secret: []byte(secret), secure: strings.HasPrefix(baseURL, "https://")}
	if value := os.Getenv("OTP_SECRET"); value != "" {
		s.otpSecret = []byte(value)
	} else {
		s.otpSecret = s.secret
	}
	return s
}

func sessionCookie(r *http.Request) (string, error) {
	for _, n := range []string{secureCookie, cookieName} {
		if c, e := r.Cookie(n); e == nil {
			return c.Value, nil
		}
	}
	return "", http.ErrNoCookie
}
func (s *Service) Session(r *http.Request) (*Identity, error) {
	raw, err := sessionCookie(r)
	if err != nil {
		return nil, nil
	}
	decoded, err := url.QueryUnescape(raw)
	if err != nil {
		return nil, nil
	}
	parts := strings.Split(decoded, ".")
	if len(parts) != 2 || parts[0] == "" {
		return nil, nil
	}
	signature, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, nil
	}
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, nil
	}
	var identity Identity
	var sessionExpires, sessionCreated, sessionUpdated string
	var userCreated, userUpdated string
	var phoneVerified int
	err = s.db.QueryRowContext(r.Context(), `SELECT s.id,s.userId,s.token,s.expiresAt,s.createdAt,s.updatedAt,u.id,u.name,COALESCE(u.phone,''),u.phoneVerified,u.image,u.createdAt,u.updatedAt FROM session s JOIN "user" u ON u.id=s.userId WHERE s.token=?`, parts[0]).Scan(
		&identity.Session.ID, &identity.Session.UserID, &identity.Session.Token,
		&sessionExpires, &sessionCreated, &sessionUpdated,
		&identity.User.ID, &identity.User.Name, &identity.User.Phone, &phoneVerified,
		&identity.User.Image, &userCreated, &userUpdated,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("read session: %w", err)
	}
	identity.Session.ExpiresAt = parseTime(sessionExpires)
	identity.Session.CreatedAt = parseTime(sessionCreated)
	identity.Session.UpdatedAt = parseTime(sessionUpdated)
	identity.User.PhoneVerified = phoneVerified != 0
	identity.User.CreatedAt = parseTime(userCreated)
	identity.User.UpdatedAt = parseTime(userUpdated)
	if !identity.Session.ExpiresAt.After(time.Now()) {
		_, err := s.db.ExecContext(r.Context(), `DELETE FROM session WHERE id=?`, identity.Session.ID)
		if err != nil {
			return nil, fmt.Errorf("delete expired session: %w", err)
		}
		return nil, nil
	}
	return &identity, nil
}

func (s *Service) SignOut(ctx context.Context, r *http.Request) error {
	raw, err := sessionCookie(r)
	if err != nil {
		return nil
	}
	decoded, err := url.QueryUnescape(raw)
	if err != nil {
		return nil
	}
	parts := strings.Split(decoded, ".")
	if len(parts) != 2 {
		return nil
	}
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(parts[0]))
	sig, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM session WHERE token=?`, parts[0])
	return err
}

func (s *Service) SetSessionCookie(w http.ResponseWriter, token string) {
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write([]byte(token))
	value := url.QueryEscape(token + "." + base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	name := cookieName
	if s.secure {
		name = secureCookie
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: int(sessionDuration.Seconds())})
}

func (s *Service) ClearSessionCookie(w http.ResponseWriter) {
	name := cookieName
	if s.secure {
		name = secureCookie
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0)})
}

func createSession(ctx context.Context, tx *sql.Tx, userID, name, phone string, verified bool, image *string, now time.Time) (Identity, error) {
	token := randomToken(32)
	if token == "" {
		return Identity{}, errors.New("generate session token")
	}
	sessionID := randomID()
	if sessionID == "" {
		return Identity{}, errors.New("generate session id")
	}
	nowText := now.Format(time.RFC3339Nano)
	expires := now.Add(sessionDuration)
	if _, err := tx.ExecContext(ctx, `INSERT INTO session (id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`, sessionID, userID, token, expires.Format(time.RFC3339Nano), nowText, nowText); err != nil {
		return Identity{}, fmt.Errorf("create session: %w", err)
	}
	return Identity{
		Session: Session{ID: sessionID, UserID: userID, Token: token, ExpiresAt: expires, CreatedAt: now, UpdatedAt: now},
		User:    User{ID: userID, Name: name, Phone: phone, PhoneVerified: verified, Image: image, CreatedAt: now, UpdatedAt: now},
	}, nil
}

func randomToken(bytes int) string {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(value)
}

func randomID() string {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return ""
	}
	encoded := hex.EncodeToString(bytes)
	return encoded[:8] + "-" + encoded[8:12] + "-4" + encoded[13:16] + "-a" + encoded[17:20] + "-" + encoded[20:32]
}

func parseTime(value string) time.Time {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	if parsed.IsZero() {
		parsed, _ = time.Parse("2006-01-02 15:04:05", value)
	}
	return parsed
}

func isUniqueConstraint(err error) bool {
	return err != nil && (strings.Contains(strings.ToLower(err.Error()), "unique constraint") || strings.Contains(strings.ToLower(err.Error()), "constraint failed"))
}
