package wishlist

import (
	"context"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

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
