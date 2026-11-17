// Package push provides authenticated subscription storage and server-side sending.
package push

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	webpush "github.com/SherClockHolmes/webpush-go"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"
)

type PushConfig struct{ PublicKey, PrivateKey, Subject string }
type pushSubscription struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256DH string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}
type Service struct {
	DB     *sql.DB
	Config PushConfig
	BoxKey string
	Client *http.Client
}

// Identity must come from trusted authentication middleware, never client JSON.
type Identity func(*http.Request) (string, bool)

func (s *Service) Register(mux *http.ServeMux, identity Identity) {
	mux.HandleFunc("GET /api/push/config", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := identity(r); !ok {
			http.Error(w, "Unauthorized", 401)
			return
		}
		if ValidatePushConfig(s.Config) != nil {
			http.Error(w, "Push not configured", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"publicKey": s.Config.PublicKey})
	})
	mux.HandleFunc("POST /api/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		user, ok := identity(r)
		if !ok {
			http.Error(w, "Unauthorized", 401)
			return
		}
		if ValidatePushConfig(s.Config) != nil {
			http.Error(w, "Push not configured", 503)
			return
		}
		var sub pushSubscription
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&sub) != nil || !validSubscription(sub) {
			http.Error(w, "Invalid subscription", 400)
			return
		}
		id := subscriptionID(sub.Endpoint)
		clear, _ := json.Marshal(sub)
		encrypted, err := encrypt(clear, s.BoxKey, "push:"+user+":"+id)
		if err != nil {
			http.Error(w, "Storage failed", 500)
			return
		}
		var saved string
		err = s.DB.QueryRowContext(r.Context(), `INSERT INTO push_subscriptions(id,user_id,encrypted_subscription,created_at)
   SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?)<5
   OR EXISTS(SELECT 1 FROM push_subscriptions WHERE user_id=? AND id=?)
   ON CONFLICT(id) DO UPDATE SET encrypted_subscription=excluded.encrypted_subscription
   WHERE user_id=excluded.user_id RETURNING id`, id, user, encrypted, time.Now().UTC().Format(time.RFC3339Nano), user, user, id).Scan(&saved)
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, "Subscription conflict or limit", 409)
			return
		}
		if err != nil {
			http.Error(w, "Storage failed", 500)
			return
		}
		w.WriteHeader(201)
	})
	mux.HandleFunc("DELETE /api/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		user, ok := identity(r)
		if !ok {
			http.Error(w, "Unauthorized", 401)
			return
		}
		var body struct {
			Endpoint string `json:"endpoint"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body) != nil || len(body.Endpoint) > 2048 {
			http.Error(w, "Invalid input", 400)
			return
		}
		_, err := s.DB.ExecContext(r.Context(), "DELETE FROM push_subscriptions WHERE id=? AND user_id=?", subscriptionID(body.Endpoint), user)
		if err != nil {
			http.Error(w, "Storage failed", 500)
			return
		}
		w.WriteHeader(204)
	})
}

type Message struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
}

// SendToUser is called by trusted backend business code. Do not expose it as an unrestricted HTTP route.
// Returns push-service acceptance counts, not device delivery receipts. This minimal version has no durable retry queue.
func (s *Service) SendToUser(ctx context.Context, user string, message Message) (int, int, error) {
	if err := ValidatePushConfig(s.Config); err != nil {
		return 0, 0, err
	}
	payload, err := json.Marshal(message)
	if err != nil {
		return 0, 0, err
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT id,encrypted_subscription FROM push_subscriptions WHERE user_id=?", user)
	if err != nil {
		return 0, 0, err
	}
	type stored struct{ id, encrypted string }
	var subs []stored
	for rows.Next() {
		var v stored
		if err = rows.Scan(&v.id, &v.encrypted); err != nil {
			rows.Close()
			return 0, 0, err
		}
		subs = append(subs, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, 0, err
	}
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	accepted, failed := 0, 0
	for _, v := range subs {
		status, e := sendPush(ctx, client, s.Config, s.BoxKey, user, v.id, v.encrypted, payload)
		if status == 404 || status == 410 {
			if _, err = s.DB.ExecContext(ctx, "DELETE FROM push_subscriptions WHERE id=? AND user_id=?", v.id, user); err != nil {
				return accepted, failed, err
			}
		}
		if e == nil {
			accepted++
		} else {
			failed++
		}
	}
	return accepted, failed, nil
}
func decrypt(value, secret, aad string) ([]byte, error) {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(boxKey(secret))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < gcm.NonceSize() {
		return nil, errors.New("invalid ciphertext")
	}
	return gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], []byte(aad))
}
func validSubscription(subscription pushSubscription) bool {
	parsed, err := url.Parse(subscription.Endpoint)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.Fragment != "" || len(subscription.Endpoint) > 2048 {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	validHost := host == "fcm.googleapis.com" || host == "web.push.apple.com" || host == "updates.push.services.mozilla.com" || strings.HasSuffix(host, ".push.services.mozilla.com") || strings.HasSuffix(host, ".notify.windows.com")
	if !validHost {
		return false
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(subscription.Keys.P256DH)
	if err != nil || len(publicKey) != 65 || publicKey[0] != 4 {
		return false
	}
	auth, err := base64.RawURLEncoding.DecodeString(subscription.Keys.Auth)
	return err == nil && len(auth) == 16
}

func subscriptionID(endpoint string) string {
	digest := sha256.Sum256([]byte(endpoint))
	return hex.EncodeToString(digest[:])
}

func encrypt(plaintext []byte, secret, aad string) (string, error) {
	block, err := aes.NewCipher(boxKey(secret))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, plaintext, []byte(aad))
	return base64.StdEncoding.EncodeToString(append(iv, sealed...)), nil
}

func boxKey(secret string) []byte {
	if len(secret) == 64 {
		if decoded, err := hex.DecodeString(secret); err == nil && len(decoded) == 32 {
			return decoded
		}
	}
	material := []byte(secret)
	if len(material) > 32 {
		material = material[:32]
	}
	for len(material) < 32 {
		material = append(material, '0')
	}
	return material
}

// ValidatePushConfig checks that the configured VAPID keys form a P-256 pair.
func ValidatePushConfig(c PushConfig) error {
	pub, e1 := base64.RawURLEncoding.DecodeString(c.PublicKey)
	priv, e2 := base64.RawURLEncoding.DecodeString(c.PrivateKey)
	if e1 != nil || e2 != nil || len(pub) != 65 || len(priv) != 32 {
		return errors.New("invalid or missing VAPID keys")
	}
	d := new(big.Int).SetBytes(priv)
	curve := elliptic.P256()
	if d.Sign() <= 0 || d.Cmp(curve.Params().N) >= 0 {
		return errors.New("invalid VAPID private key")
	}
	x, y := curve.ScalarBaseMult(priv)
	if string(elliptic.Marshal(curve, x, y)) != string(pub) {
		return errors.New("VAPID keys do not match")
	}
	if strings.HasPrefix(c.Subject, "mailto:") {
		address := strings.TrimPrefix(c.Subject, "mailto:")
		parsed, err := mail.ParseAddress(address)
		if err == nil && parsed.Address == address && parsed.Name == "" {
			return nil
		}
	} else if u, err := url.Parse(c.Subject); err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil {
		return nil
	}
	return errors.New("VAPID subject must be a mailto address or HTTPS URL")
}

// sendPush returns an HTTP status when the provider responded. It deliberately
// suppresses errors that can contain a secret subscription endpoint.
func sendPush(ctx context.Context, client *http.Client, config PushConfig, boxKey, userID, subscriptionID, encrypted string, payload []byte) (int, error) {
	clear, err := decrypt(encrypted, boxKey, "push:"+userID+":"+subscriptionID)
	if err != nil {
		return 0, errors.New("invalid stored subscription")
	}
	var sub pushSubscription
	if json.Unmarshal(clear, &sub) != nil || !validSubscription(sub) {
		return 0, errors.New("invalid stored subscription")
	}
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, err := webpush.SendNotificationWithContext(requestCtx, payload, &webpush.Subscription{Endpoint: sub.Endpoint, Keys: webpush.Keys{P256dh: sub.Keys.P256DH, Auth: sub.Keys.Auth}}, &webpush.Options{HTTPClient: client, Subscriber: config.Subject, VAPIDPublicKey: config.PublicKey, VAPIDPrivateKey: config.PrivateKey, TTL: 3600, Urgency: webpush.UrgencyNormal})
	if err != nil {
		var netErr net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
			return 0, errors.New("timeout")
		}
		return 0, errors.New("push request failed")
	}
	if response == nil {
		return 0, errors.New("push request failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return response.StatusCode, fmt.Errorf("push endpoint returned status %d", response.StatusCode)
	}
	return response.StatusCode, nil
}
