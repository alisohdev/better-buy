package config

import (
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	DatabasePath               string
	HTTPHost                   string
	HTTPPort                   uint16
	BetterAuthURL              string
	AppOrigin                  string
	CORSOrigins                []string
	BetterAuthSecret           string
	BoxKey                     string
	GoogleClientID             string
	GoogleClientSecret         string
	AdminEmails                []string
	WishlistScheduleEnabled    bool
	APIRateLimitsEnabled       bool
	SnappStoreCampaignsEnabled bool
	DevMode                    bool
	GeocoderBaseURL            string
	VAPIDPublicKey             string
	VAPIDPrivateKey            string
	VAPIDSubject               string
}

func Load() (Config, error) {
	get := os.Getenv
	cfg := Config{DatabasePath: DatabasePath()}

	cfg.HTTPHost = value(get, "VPS_HTTP_HOST", "127.0.0.1")
	portText := value(get, "VPS_HTTP_PORT", "8787")
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return Config{}, fmt.Errorf("VPS_HTTP_PORT must be an integer from 1 to 65535")
	}
	cfg.HTTPPort = uint16(port)

	cfg.BetterAuthURL = value(get, "BETTER_AUTH_URL", "https://better-buy.ir")
	cfg.AppOrigin = value(get, "APP_ORIGIN", cfg.BetterAuthURL)
	if err := validateOrigin(cfg.AppOrigin); err != nil {
		return Config{}, fmt.Errorf("APP_ORIGIN: %w", err)
	}
	if err := validateOrigin(cfg.BetterAuthURL); err != nil {
		return Config{}, fmt.Errorf("BETTER_AUTH_URL: %w", err)
	}
	cfg.CORSOrigins = uniqueOrigins(append([]string{cfg.AppOrigin}, origins(value(get, "CORS_ORIGIN", cfg.AppOrigin))...))
	if err := validateOrigins(cfg.CORSOrigins); err != nil {
		return Config{}, err
	}

	for name, target := range map[string]*string{
		"BETTER_AUTH_SECRET":   &cfg.BetterAuthSecret,
		"BOX_KEY":              &cfg.BoxKey,
		"GOOGLE_CLIENT_ID":     &cfg.GoogleClientID,
		"GOOGLE_CLIENT_SECRET": &cfg.GoogleClientSecret,
	} {
		*target = strings.TrimSpace(get(name))
		if *target == "" {
			return Config{}, fmt.Errorf("missing required environment variable: %s", name)
		}
	}
	cfg.AdminEmails, err = adminEmails(get("ADMIN_EMAILS"))
	if err != nil {
		return Config{}, err
	}

	cfg.WishlistScheduleEnabled, err = boolean(get, "WISHLIST_SCHEDULE_ENABLED", true)
	if err != nil {
		return Config{}, err
	}
	cfg.APIRateLimitsEnabled, err = boolean(get, "API_RATE_LIMITS_ENABLED", true)
	if err != nil {
		return Config{}, err
	}
	cfg.SnappStoreCampaignsEnabled, err = boolean(get, "SNAPP_STORE_CAMPAIGNS_ENABLED", false)
	if err != nil {
		return Config{}, err
	}
	cfg.DevMode, err = boolean(get, "DEV_MODE", false)
	if err != nil {
		return Config{}, err
	}
	cfg.GeocoderBaseURL = strings.TrimSpace(get("GEOCODER_BASE_URL"))
	cfg.VAPIDPublicKey = strings.TrimSpace(get("VAPID_PUBLIC_KEY"))
	cfg.VAPIDPrivateKey = strings.TrimSpace(get("VAPID_PRIVATE_KEY"))
	cfg.VAPIDSubject = strings.TrimSpace(get("VAPID_SUBJECT"))
	if partialVAPID(cfg) {
		return Config{}, errors.New("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT must be set together")
	}
	return cfg, nil
}

func adminEmails(value string) ([]string, error) {
	result := make([]string, 0)
	seen := make(map[string]bool)
	for _, part := range strings.Split(value, ",") {
		email := strings.ToLower(strings.TrimSpace(part))
		if email == "" {
			continue
		}
		parsed, err := mail.ParseAddress(email)
		if err != nil || parsed.Address != email || parsed.Name != "" {
			return nil, errors.New("ADMIN_EMAILS must contain comma-separated email addresses")
		}
		if !seen[email] {
			seen[email] = true
			result = append(result, email)
		}
	}
	return result, nil
}

func DatabasePath() string {
	return value(os.Getenv, "VPS_DATABASE_PATH", "../../.data/better-buy-vps.sqlite")
}

func value(get func(string) string, name, fallback string) string {
	if got := strings.TrimSpace(get(name)); got != "" {
		return got
	}
	return fallback
}

func boolean(get func(string) string, name string, fallback bool) (bool, error) {
	text := strings.TrimSpace(get(name))
	if text == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(text)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", name)
	}
	return value, nil
}

func origins(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if origin := strings.TrimSpace(part); origin != "" {
			result = append(result, origin)
		}
	}
	return result
}

func validateOrigins(origins []string) error {
	for _, origin := range origins {
		if err := validateOrigin(origin); err != nil {
			return err
		}
	}
	if len(origins) == 0 {
		return errors.New("at least one CORS origin is required")
	}
	return nil
}

func validateOrigin(origin string) error {
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("origin %q must be an absolute HTTP or HTTPS origin without a path", origin)
	}
	return nil
}

func uniqueOrigins(origins []string) []string {
	seen := make(map[string]struct{}, len(origins))
	result := make([]string, 0, len(origins))
	for _, origin := range origins {
		if _, ok := seen[origin]; ok {
			continue
		}
		seen[origin] = struct{}{}
		result = append(result, origin)
	}
	return result
}

func partialVAPID(cfg Config) bool {
	set := 0
	for _, value := range []string{cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, cfg.VAPIDSubject} {
		if value != "" {
			set++
		}
	}
	return set != 0 && set != 3
}
