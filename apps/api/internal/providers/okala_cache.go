package providers

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const okalaCacheTTL = 3 * time.Minute
const okalaCacheLease = 45 * time.Second

var okalaSlots = make(chan struct{}, okalaConcurrency)
var okalaCooldown struct {
	sync.Mutex
	until time.Time
}

type okalaBackoffTransport struct{ base http.RoundTripper }

func (t okalaBackoffTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err == nil && response.StatusCode == http.StatusTooManyRequests {
		until := time.Now().Add(max(time.Second, retryAfter(response.Header.Get("Retry-After"))))
		okalaCooldown.Lock()
		if until.After(okalaCooldown.until) {
			okalaCooldown.until = until
		}
		okalaCooldown.Unlock()
	}
	return response, err
}
func waitOkalaCooldown(ctx context.Context) error {
	for {
		okalaCooldown.Lock()
		delay := time.Until(okalaCooldown.until)
		okalaCooldown.Unlock()
		if delay <= 0 {
			return ctx.Err()
		}
		if !sleep(ctx, delay) {
			return ctx.Err()
		}
	}
}

// Coordinate only public store/category responses. Nearby-store eligibility is
// always resolved afresh for this location and is never shared between visitors.
func (c *Collector) okalaRequest(ctx context.Context, method, endpoint string, query url.Values, payload []byte, job *scanJob) (response, error) {
	target := "https://apigateway.okala.com/api" + endpoint
	if encoded := query.Encode(); encoded != "" {
		target += "?" + encoded
	}
	key := discoveryRequestKey("okala", method, target)
	if method == http.MethodPost {
		key += fmt.Sprintf(":%x", sha256.Sum256(payload))
	}
	saved, found, err := job.LoadDiscovery(ctx, key)
	if err != nil {
		return response{}, err
	}
	if found {
		return response{status: 200, body: saved.Body, observedAt: saved.ObservedAt}, nil
	}
	fetch := func() (response, error) {
		if err := waitOkalaCooldown(ctx); err != nil {
			return response{}, err
		}
		select {
		case okalaSlots <- struct{}{}:
		case <-ctx.Done():
			return response{}, ctx.Err()
		}
		defer func() { <-okalaSlots }()
		headers := http.Header{"Accept": {"application/json"}, "Origin": {"https://www.okala.com"}, "Source": {"okala"}, "Ui-Version": {"2.0"}}
		if method == http.MethodPost {
			headers.Set("Content-Type", "application/json")
		}
		reserve := func(ctx context.Context, operation string) error {
			if err := waitOkalaCooldown(ctx); err != nil {
				return err
			}
			if method == http.MethodPost {
				operation += fmt.Sprintf(":%x", sha256.Sum256(payload))
			}
			return job.ReserveRequest(ctx, operation)
		}
		client := *c.client
		base := client.Transport
		if base == nil {
			base = http.DefaultTransport
		}
		client.Transport = okalaBackoffTransport{base: base}
		copy := *c
		copy.client = &client
		result, err := copy.request(ctx, method, target, headers, payload, "Okala", 3, false, reserve)
		if err == nil {
			result.observedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		return result, err
	}
	var value response
	if method == http.MethodGet && (endpoint == "/unicorn/v3/categories/nearby" || strings.HasPrefix(endpoint, "/unicorn/v2/products/store/")) {
		value, err = c.sharedOkalaResponse(ctx, "catalogue-v2:"+key, fetch)
	} else {
		value, err = fetch()
	}
	if err != nil {
		return response{}, err
	}
	if json.Valid(value.body) {
		saved, err = job.journal.saveDiscovery(ctx, key, value.body, value.observedAt)
		if err != nil {
			return response{}, err
		}
		value.body = saved.Body
		value.observedAt = saved.ObservedAt
	}
	return value, nil
}

func validSharedOkalaBody(body []byte) bool {
	var envelope struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(body, &envelope) != nil || !envelope.Success {
		return false
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return false
	}
	if envelope.Data[0] == '[' {
		var values []json.RawMessage
		return json.Unmarshal(envelope.Data, &values) == nil
	}
	var categories struct {
		Categories []json.RawMessage `json:"categories"`
	}
	return json.Unmarshal(envelope.Data, &categories) == nil && categories.Categories != nil
}

func (c *Collector) sharedOkalaResponse(ctx context.Context, key string, fetch func() (response, error)) (response, error) {
	for {
		now := time.Now().UTC()
		nowText := now.Format(time.RFC3339Nano)
		var body, observedAt, expires string
		err := c.db.QueryRowContext(ctx, `SELECT payload_json,observed_at,reusable_until FROM okala_offer_cache WHERE request_key=? AND state='ready'`, key).Scan(&body, &observedAt, &expires)
		if err == nil {
			expiry, parseErr := time.Parse(time.RFC3339Nano, expires)
			_, observedErr := time.Parse(time.RFC3339Nano, observedAt)
			if parseErr != nil || observedErr != nil || !validSharedOkalaBody([]byte(body)) {
				if _, err := c.db.ExecContext(ctx, `DELETE FROM okala_offer_cache WHERE request_key=? AND state='ready' AND payload_json=?`, key, body); err != nil {
					return response{}, err
				}
			}
			if parseErr == nil && observedErr == nil && expiry.After(now) && validSharedOkalaBody([]byte(body)) {
				return response{status: 200, body: []byte(body), observedAt: observedAt}, nil
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return response{}, err
		}
		tokenBytes := make([]byte, 16)
		if _, err := rand.Read(tokenBytes); err != nil {
			return response{}, err
		}
		token := hex.EncodeToString(tokenBytes)
		var claimed string
		err = c.db.QueryRowContext(ctx, `INSERT INTO okala_offer_cache(request_key,state,lease_until,fencing_token,updated_at) VALUES(?,'fetching',?,?,?) ON CONFLICT(request_key) DO UPDATE SET state='fetching',payload_json=NULL,observed_at=NULL,reusable_until=NULL,lease_until=excluded.lease_until,fencing_token=excluded.fencing_token,updated_at=excluded.updated_at WHERE (okala_offer_cache.state!='fetching' AND (okala_offer_cache.reusable_until IS NULL OR julianday(okala_offer_cache.reusable_until)<=julianday(?))) OR (okala_offer_cache.state='fetching' AND (okala_offer_cache.lease_until IS NULL OR julianday(okala_offer_cache.lease_until)<=julianday(?))) RETURNING fencing_token`, key, now.Add(okalaCacheLease).Format(time.RFC3339Nano), token, nowText, nowText, nowText).Scan(&claimed)
		if errors.Is(err, sql.ErrNoRows) {
			if !sleep(ctx, 50*time.Millisecond) {
				return response{}, ctx.Err()
			}
			continue
		}
		if err != nil {
			return response{}, err
		}

		// Cancellation can happen after fetch succeeds but before the ready update.
		// Always release this token on return; ready rows and newer owners are protected.
		defer func(token string) {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, _ = c.db.ExecContext(cleanupCtx, `DELETE FROM okala_offer_cache WHERE request_key=? AND fencing_token=? AND state='fetching'`, key, token)
		}(claimed)

		// Renew ownership while requests wait for a global slot or upstream backoff.
		renewalCtx, stopRenewal := context.WithCancel(ctx)
		renewed := make(chan struct{})
		go func() {
			defer close(renewed)
			ticker := time.NewTicker(okalaCacheLease / 3)
			defer ticker.Stop()
			for {
				select {
				case <-renewalCtx.Done():
					return
				case <-ticker.C:
					_, err := c.db.ExecContext(renewalCtx, `UPDATE okala_offer_cache SET lease_until=? WHERE request_key=? AND fencing_token=? AND state='fetching'`, time.Now().UTC().Add(okalaCacheLease).Format(time.RFC3339Nano), key, claimed)
					if err != nil {
						return
					}
				}
			}
		}()
		value, fetchErr := fetch()
		stopRenewal()
		<-renewed

		if fetchErr != nil || !validSharedOkalaBody(value.body) {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, _ = c.db.ExecContext(cleanupCtx, `DELETE FROM okala_offer_cache WHERE request_key=? AND fencing_token=?`, key, claimed)
			cancel()
			return value, fetchErr
		}
		observed, err := time.Parse(time.RFC3339Nano, value.observedAt)
		if err != nil {
			return response{}, err
		}
		result, err := c.db.ExecContext(ctx, `UPDATE okala_offer_cache SET state='ready',payload_json=?,observed_at=?,reusable_until=?,lease_until=NULL,updated_at=? WHERE request_key=? AND fencing_token=? AND state='fetching'`, string(value.body), value.observedAt, observed.Add(okalaCacheTTL).Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano), key, claimed)
		if err != nil {
			return response{}, err
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return response{}, err
		}
		if changed == 1 {
			return value, nil
		}
		// An expired owner cannot replace a newer response. Read the winner instead.
	}
}
