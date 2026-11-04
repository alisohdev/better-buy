package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/oauth2"
	"golang.org/x/text/unicode/norm"
)

const (
	cookieName       = "better-auth.session_token"
	secureCookie     = "__Secure-better-auth.session_token"
	oauthStateCookie = "better-auth.oauth_state"
	secureOAuthState = "__Secure-better-auth.oauth_state"
	sessionDuration  = 7 * 24 * time.Hour
)

type Service struct {
	db         *sql.DB
	secret     []byte
	baseURL    string
	google     oauth2.Config
	secure     bool
	httpClient *http.Client
}

type User struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Email         string    `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	Image         *string   `json:"image"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type Session struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Identity struct {
	Session Session `json:"session"`
	User    User    `json:"user"`
}

type OAuthUser struct {
	Subject       string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
}

type oauthState struct {
	Verifier    string `json:"verifier"`
	CallbackURL string `json:"callbackURL"`
}

func New(db *sql.DB, secret, baseURL, googleClientID, googleClientSecret string) *Service {
	parsed, _ := url.Parse(baseURL)
	secure := parsed != nil && parsed.Scheme == "https"
	client := &http.Client{Timeout: 15 * time.Second}
	return &Service{
		db:         db,
		secret:     []byte(secret),
		baseURL:    strings.TrimRight(baseURL, "/"),
		secure:     secure,
		httpClient: client,
		google: oauth2.Config{
			ClientID:     googleClientID,
			ClientSecret: googleClientSecret,
			RedirectURL:  strings.TrimRight(baseURL, "/") + "/api/auth/callback/google",
			Scopes:       []string{"openid", "email", "profile"},
			Endpoint: oauth2.Endpoint{
				AuthURL:  "https://accounts.google.com/o/oauth2/v2/auth",
				TokenURL: "https://oauth2.googleapis.com/token",
			},
		},
	}
}

func (s *Service) SignUp(ctx context.Context, name, email, password string) (Identity, error) {
	name = strings.TrimSpace(name)
	email, err := normalizeEmail(email)
	if err != nil || name == "" || utf8.RuneCountInString(name) > 120 || !validPassword(password) {
		return Identity{}, ErrInvalidCredentials
	}
	hash, err := hashPassword(password)
	if err != nil {
		return Identity{}, fmt.Errorf("hash password: %w", err)
	}
	now := time.Now().UTC()
	userID, accountID := randomID(), randomID()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO "user" (id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (?,?,?,0,NULL,?,?)`, userID, name, email, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		if isUniqueConstraint(err) {
			return Identity{}, ErrEmailExists
		}
		return Identity{}, fmt.Errorf("create user: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO account (id,userId,accountId,providerId,password,createdAt,updatedAt) VALUES (?,?,?,'credential',?,?,?)`, accountID, userID, userID, hash, now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return Identity{}, fmt.Errorf("create credential account: %w", err)
	}
	identity, err := createSession(ctx, tx, userID, name, email, false, nil, now)
	if err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, fmt.Errorf("commit signup: %w", err)
	}
	return identity, nil
}

func (s *Service) SignIn(ctx context.Context, email, password string) (Identity, error) {
	email, err := normalizeEmail(email)
	if err != nil || password == "" {
		return Identity{}, ErrInvalidCredentials
	}
	var userID, name, hash string
	var verified int
	err = s.db.QueryRowContext(ctx, `SELECT u.id,u.name,u.emailVerified,a.password FROM "user" u JOIN account a ON a.userId=u.id AND a.providerId='credential' WHERE u.email=?`, email).Scan(&userID, &name, &verified, &hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Identity{}, ErrInvalidCredentials
		}
		return Identity{}, fmt.Errorf("load credential account: %w", err)
	}
	if !verifyPassword(hash, password) {
		return Identity{}, ErrInvalidCredentials
	}
	now := time.Now().UTC()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback()
	identity, err := createSession(ctx, tx, userID, name, email, verified != 0, nil, now)
	if err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, fmt.Errorf("commit signin: %w", err)
	}
	return identity, nil
}

func (s *Service) TestLogin(ctx context.Context) (Identity, error) {
	const email = "test@better-buy.local"
	now := time.Now().UTC()
	nowText := now.Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback()
	var user User
	var verified int
	var createdAt, updatedAt string
	err = tx.QueryRowContext(ctx, `SELECT id,name,email,emailVerified,image,createdAt,updatedAt FROM "user" WHERE email=?`, email).Scan(&user.ID, &user.Name, &user.Email, &verified, &user.Image, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		user.ID, user.Name, user.Email = randomID(), "Test", email
		if user.ID == "" {
			return Identity{}, errors.New("generate test user id")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO "user" (id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (?,?,?,1,NULL,?,?)`, user.ID, user.Name, user.Email, nowText, nowText); err != nil {
			return Identity{}, fmt.Errorf("create test user: %w", err)
		}
		verified, createdAt, updatedAt = 1, nowText, nowText
	} else if err != nil {
		return Identity{}, fmt.Errorf("load test user: %w", err)
	}
	var hasLocation int
	err = tx.QueryRowContext(ctx, "SELECT 1 FROM locations WHERE user_id=? LIMIT 1", user.ID).Scan(&hasLocation)
	if errors.Is(err, sql.ErrNoRows) {
		locationID := randomID()
		if locationID == "" {
			return Identity{}, errors.New("generate test location id")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at,coordinate_revision) VALUES (?,?,?,?,?,1,?,?,1)`, locationID, user.ID, "Test location", 35.7, 51.4, nowText, nowText); err != nil {
			return Identity{}, fmt.Errorf("create test location: %w", err)
		}
	} else if err != nil {
		return Identity{}, fmt.Errorf("check test location: %w", err)
	}
	user.EmailVerified = verified != 0
	user.CreatedAt = parseTime(createdAt)
	user.UpdatedAt = parseTime(updatedAt)
	identity, err := createSession(ctx, tx, user.ID, user.Name, user.Email, user.EmailVerified, user.Image, now)
	if err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, fmt.Errorf("commit test login: %w", err)
	}
	return identity, nil
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
	var emailVerified int
	err = s.db.QueryRowContext(r.Context(), `SELECT s.id,s.userId,s.token,s.expiresAt,s.createdAt,s.updatedAt,u.id,u.name,u.email,u.emailVerified,u.image,u.createdAt,u.updatedAt FROM session s JOIN "user" u ON u.id=s.userId WHERE s.token=?`, parts[0]).Scan(
		&identity.Session.ID, &identity.Session.UserID, &identity.Session.Token,
		&sessionExpires, &sessionCreated, &sessionUpdated,
		&identity.User.ID, &identity.User.Name, &identity.User.Email, &emailVerified,
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
	identity.User.EmailVerified = emailVerified != 0
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

func (s *Service) BeginGoogle(w http.ResponseWriter, r *http.Request) error {
	callbackURL := safeCallback(r.URL.Query().Get("callbackURL"))
	if callbackURL == "" {
		return ErrInvalidCallback
	}
	state, verifier, err := randomToken(32), randomToken(48), error(nil)
	if state == "" || verifier == "" {
		return errors.New("generate oauth state")
	}
	value, err := json.Marshal(oauthState{Verifier: verifier, CallbackURL: callbackURL})
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	_, err = s.db.ExecContext(r.Context(), `INSERT INTO verification (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`, randomID(), "google_oauth:"+state, string(value), now.Add(10*time.Minute).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("save oauth state: %w", err)
	}
	name := oauthStateCookie
	if s.secure {
		name = secureOAuthState
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: state, Path: "/api/auth/callback/google", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	url := s.google.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oauth2.SetAuthURLParam("include_granted_scopes", "true"))
	http.Redirect(w, r, url, http.StatusFound)
	return nil
}

func (s *Service) CompleteGoogle(w http.ResponseWriter, r *http.Request) error {
	stateCookie, err := r.Cookie(oauthStateCookie)
	if s.secure {
		stateCookie, err = r.Cookie(secureOAuthState)
	}
	if err != nil || stateCookie.Value == "" || r.URL.Query().Get("state") == "" || !hmac.Equal([]byte(stateCookie.Value), []byte(r.URL.Query().Get("state"))) {
		return ErrInvalidOAuthState
	}
	var stateJSON string
	var verificationID string
	var expires string
	err = s.db.QueryRowContext(r.Context(), `SELECT id,value,expiresAt FROM verification WHERE identifier=?`, "google_oauth:"+stateCookie.Value).Scan(&verificationID, &stateJSON, &expires)
	if err != nil || !parseTime(expires).After(time.Now()) {
		return ErrInvalidOAuthState
	}
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM verification WHERE id=?`, verificationID); err != nil {
		return fmt.Errorf("consume oauth state: %w", err)
	}
	var saved oauthState
	if json.Unmarshal([]byte(stateJSON), &saved) != nil || saved.Verifier == "" || safeCallback(saved.CallbackURL) != saved.CallbackURL {
		return ErrInvalidOAuthState
	}
	if providerError := r.URL.Query().Get("error"); providerError != "" {
		return fmt.Errorf("google authorization failed: %s", providerError)
	}
	ctx := context.WithValue(r.Context(), oauth2.HTTPClient, s.httpClient)
	token, err := s.google.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(saved.Verifier))
	if err != nil {
		return fmt.Errorf("exchange google authorization code: %w", err)
	}
	client := s.google.Client(ctx, token)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://openidconnect.googleapis.com/v1/userinfo", nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("request google user profile: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("google user profile returned %s", response.Status)
	}
	var profile OAuthUser
	if err := json.NewDecoder(http.MaxBytesReader(w, response.Body, 1<<20)).Decode(&profile); err != nil {
		return fmt.Errorf("decode google user profile: %w", err)
	}
	if profile.Subject == "" || !profile.EmailVerified {
		return ErrUnverifiedOAuthEmail
	}
	identity, err := s.signInGoogle(ctx, profile)
	if err != nil {
		return err
	}
	s.SetSessionCookie(w, identity.Session.Token)
	clearOAuthCookie(w, s.secure)
	http.Redirect(w, r, s.baseURL+saved.CallbackURL, http.StatusFound)
	return nil
}

func (s *Service) signInGoogle(ctx context.Context, profile OAuthUser) (Identity, error) {
	email, err := normalizeEmail(profile.Email)
	if err != nil {
		return Identity{}, ErrUnverifiedOAuthEmail
	}
	name := strings.TrimSpace(profile.Name)
	if name == "" {
		name = email
	}
	now := time.Now().UTC()
	nowText := now.Format(time.RFC3339Nano)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Identity{}, err
	}
	defer tx.Rollback()
	var userID string
	err = tx.QueryRowContext(ctx, `SELECT userId FROM account WHERE providerId='google' AND accountId=?`, profile.Subject).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		err = tx.QueryRowContext(ctx, `SELECT id FROM "user" WHERE email=?`, email).Scan(&userID)
		if errors.Is(err, sql.ErrNoRows) {
			userID = randomID()
			var picture any
			if profile.Picture != "" {
				picture = profile.Picture
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO "user" (id,name,email,emailVerified,image,createdAt,updatedAt) VALUES (?,?,?,1,?,?,?)`, userID, name, email, picture, nowText, nowText)
		} else if err == nil {
			_, err = tx.ExecContext(ctx, `UPDATE "user" SET emailVerified=1,updatedAt=? WHERE id=?`, nowText, userID)
		}
		if err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO account (id,userId,accountId,providerId,createdAt,updatedAt) VALUES (?,?,?,'google',?,?)`, randomID(), userID, profile.Subject, nowText, nowText)
		}
	}
	if err != nil {
		return Identity{}, fmt.Errorf("link google account: %w", err)
	}
	var user User
	var verified int
	var createdAt, updatedAt string
	err = tx.QueryRowContext(ctx, `SELECT id,name,email,emailVerified,image,createdAt,updatedAt FROM "user" WHERE id=?`, userID).Scan(&user.ID, &user.Name, &user.Email, &verified, &user.Image, &createdAt, &updatedAt)
	if err != nil {
		return Identity{}, fmt.Errorf("read google user: %w", err)
	}
	identity, err := createSession(ctx, tx, userID, user.Name, user.Email, verified != 0, user.Image, now)
	if err != nil {
		return Identity{}, err
	}
	if err := tx.Commit(); err != nil {
		return Identity{}, fmt.Errorf("commit google sign in: %w", err)
	}
	return identity, nil
}

func createSession(ctx context.Context, tx *sql.Tx, userID, name, email string, verified bool, image *string, now time.Time) (Identity, error) {
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
		User:    User{ID: userID, Name: name, Email: email, EmailVerified: verified, Image: image, CreatedAt: now, UpdatedAt: now},
	}, nil
}

func hashPassword(password string) (string, error) {
	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", err
	}
	salt := hex.EncodeToString(saltBytes)
	key, err := scrypt.Key([]byte(norm.NFKC.String(password)), []byte(salt), 1<<14, 16, 1, 64)
	if err != nil {
		return "", err
	}
	return salt + ":" + hex.EncodeToString(key), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, ":")
	if len(parts) != 2 || parts[0] == "" || len(parts[1]) != 128 {
		return false
	}
	expected, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	actual, err := scrypt.Key([]byte(norm.NFKC.String(password)), []byte(parts[0]), 1<<14, 16, 1, 64)
	return err == nil && hmac.Equal(actual, expected)
}

func validPassword(password string) bool {
	count := utf8.RuneCountInString(password)
	return utf8.ValidString(password) && count >= 8 && count <= 128
}

func normalizeEmail(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(norm.NFKC.String(email)))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 320 {
		return "", ErrInvalidCredentials
	}
	return email, nil
}

func safeCallback(candidate string) string {
	if candidate == "" {
		return "/"
	}
	parsed, err := url.Parse(candidate)
	if err != nil || !parsed.IsAbs() && !strings.HasPrefix(candidate, "/") || parsed.IsAbs() || strings.HasPrefix(candidate, "//") || strings.ContainsAny(candidate, "\r\n") {
		return ""
	}
	return candidate
}

func sessionCookie(r *http.Request) (string, error) {
	for _, name := range []string{secureCookie, cookieName} {
		if cookie, err := r.Cookie(name); err == nil {
			return cookie.Value, nil
		}
	}
	return "", http.ErrNoCookie
}

func clearOAuthCookie(w http.ResponseWriter, secure bool) {
	name := oauthStateCookie
	if secure {
		name = secureOAuthState
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/api/auth/callback/google", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, MaxAge: -1, Expires: time.Unix(1, 0)})
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

var (
	ErrInvalidCredentials   = errors.New("invalid email or password")
	ErrEmailExists          = errors.New("an account already exists for this email")
	ErrInvalidCallback      = errors.New("invalid callback URL")
	ErrInvalidOAuthState    = errors.New("invalid or expired sign-in request")
	ErrUnverifiedOAuthEmail = errors.New("Google did not verify this email address")
)
