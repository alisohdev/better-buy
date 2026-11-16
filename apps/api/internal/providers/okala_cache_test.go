package providers

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSharedOkalaCacheCoalescesAndExpires(t *testing.T) {
	db := openJournalTestDB(t)
	c := &Collector{db: db}
	var calls atomic.Int32
	fetch := func() (response, error) {
		calls.Add(1)
		time.Sleep(30 * time.Millisecond)
		return response{status: 200, body: []byte(`{"success":true,"data":[]}`), observedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
	}
	var wg sync.WaitGroup
	observations := make(chan string, 12)
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := c.sharedOkalaResponse(context.Background(), "same-store-category", fetch)
			if err != nil {
				t.Error(err)
				return
			}
			observations <- r.observedAt
		}()
	}
	wg.Wait()
	close(observations)
	if calls.Load() != 1 {
		t.Fatalf("upstream calls=%d, want 1", calls.Load())
	}
	first := ""
	for observed := range observations {
		if first == "" {
			first = observed
		}
		if observed != first {
			t.Fatal("cache changed observation time")
		}
	}
	if _, err := db.Exec(`UPDATE okala_offer_cache SET reusable_until='2000-01-01T00:00:00Z'`); err != nil {
		t.Fatal(err)
	}
	if _, err := c.sharedOkalaResponse(context.Background(), "same-store-category", fetch); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatal("expired cache did not refresh")
	}
}
func TestSharedOkalaWaiterCancellation(t *testing.T) {
	db := openJournalTestDB(t)
	c := &Collector{db: db}
	now := time.Now().UTC()
	_, err := db.Exec(`INSERT INTO okala_offer_cache(request_key,state,lease_until,fencing_token,updated_at) VALUES('busy','fetching',?,'owner',?)`, now.Add(time.Minute).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = c.sharedOkalaResponse(ctx, "busy", func() (response, error) { t.Error("cancelled waiter fetched"); return response{}, nil })
	if err == nil {
		t.Fatal("cancelled waiter succeeded")
	}
}

func TestOkalaCachePinsOriginalObservationAndKeepsNearbyFresh(t *testing.T) {
	var calls atomic.Int32
	c := &Collector{db: openJournalTestDB(t), client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "" || len(r.Cookies()) > 0 {
			t.Error("private credentials sent to public catalogue")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"success":true,"data":[]}`)), Request: r}, nil
	})}}
	var observed string
	for _, id := range []string{"cache-owner", "cache-other"} {
		job := stressJob(t, c, id)
		result, err := c.okalaRequest(context.Background(), "GET", "/unicorn/v2/products/store/1", url.Values{"cId": {"1"}}, nil, &job)
		if err != nil {
			t.Fatal(err)
		}
		if observed == "" {
			observed = result.observedAt
		} else if observed != result.observedAt {
			t.Fatal("shared price falsely timestamped as freshly observed")
		}
		if _, err := c.okalaRequest(context.Background(), "GET", "/opex/v4/stores/nearby", url.Values{"latitude": {"35.7"}}, nil, &job); err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 3 {
		t.Fatalf("calls=%d want one catalogue + two fresh nearby calls", calls.Load())
	}
}
func TestOkalaStaleCacheOwnerCannotOverwriteWinner(t *testing.T) {
	c := &Collector{db: openJournalTestDB(t)}
	started, release := make(chan struct{}), make(chan struct{})
	done := make(chan response, 1)
	fail := make(chan error, 1)
	go func() {
		result, err := c.sharedOkalaResponse(context.Background(), "fenced", func() (response, error) {
			close(started)
			<-release
			return response{body: []byte(`{"success":true,"data":[],"tag":"old"}`), observedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
		})
		if err != nil {
			fail <- err
		} else {
			done <- result
		}
	}()
	<-started
	winner := `{"success":true,"data":[],"tag":"new"}`
	now := time.Now().UTC()
	if _, err := c.db.Exec(`UPDATE okala_offer_cache SET state='ready',fencing_token='winner',payload_json=?,observed_at=?,reusable_until=? WHERE request_key='fenced'`, winner, now.Format(time.RFC3339Nano), now.Add(time.Minute).Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case result := <-done:
		if string(result.body) != winner {
			t.Fatal("stale owner overwrote winner")
		}
	case err := <-fail:
		t.Fatal(err)
	case <-time.After(2 * time.Second):
		t.Fatal("cache owner did not drain")
	}
}

func TestOkalaHonorsThrottleBackoff(t *testing.T) {
	var calls atomic.Int32
	c := &Collector{db: openJournalTestDB(t), client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		status := 200
		headers := make(http.Header)
		body := `{"success":true,"data":[]}`
		if calls.Add(1) == 1 {
			status = 429
			headers.Set("Retry-After", "1")
			body = `{}`
		}
		return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}}
	job := stressJob(t, c, "throttled")
	started := time.Now()
	if _, err := c.okalaRequest(context.Background(), "GET", "/opex/v4/stores/nearby", nil, nil, &job); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || time.Since(started) < time.Second {
		t.Fatal("retry ignored throttle backoff")
	}
}

func TestOkalaCancellationAfterFetchReleasesLease(t *testing.T) {
	c := &Collector{db: openJournalTestDB(t)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err := c.sharedOkalaResponse(ctx, "cancel-after-response", func() (response, error) {
		cancel()
		return response{body: []byte(`{"success":true,"data":[]}`), observedAt: time.Now().UTC().Format(time.RFC3339Nano)}, nil
	})
	if err == nil {
		t.Fatal("cancelled cache commit succeeded")
	}
	var count int
	if err := c.db.QueryRow(`SELECT COUNT(*) FROM okala_offer_cache WHERE state='fetching'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("cancelled commit left %d cache owners: %v", count, err)
	}
}
