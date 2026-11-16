package providers

import (
	"context"
	"io"
	"net/http"
	"os"
	"sync/atomic"
	"testing"
	"time"
)

type liveTimingBody struct {
	io.ReadCloser
	release func()
}

func (b liveTimingBody) Close() error { err := b.ReadCloser.Close(); b.release(); return err }

type liveTimingTransport struct {
	slots               chan struct{}
	calls, active, peak *atomic.Int32
}

func (t liveTimingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	select {
	case t.slots <- struct{}{}:
	case <-r.Context().Done():
		return nil, r.Context().Err()
	}
	t.calls.Add(1)
	n := t.active.Add(1)
	for {
		p := t.peak.Load()
		if n <= p || t.peak.CompareAndSwap(p, n) {
			break
		}
	}
	release := func() { t.active.Add(-1); <-t.slots }
	response, err := http.DefaultTransport.RoundTrip(r)
	if err != nil {
		release()
		return nil, err
	}
	response.Body = liveTimingBody{response.Body, release}
	return response, nil
}

// Opt-in: reads public Okala data into disposable test databases, never production.
func TestOkalaLiveTiming(t *testing.T) {
	if os.Getenv("OKALA_LIVE_TIMING") != "1" {
		t.Skip("set OKALA_LIVE_TIMING=1 to measure public API")
	}
	for _, limit := range []int{12, okalaConcurrency} {
		var calls, active, peak atomic.Int32
		c := &Collector{db: openJournalTestDB(t), client: &http.Client{Timeout: 8 * time.Second, Transport: liveTimingTransport{make(chan struct{}, limit), &calls, &active, &peak}}}
		job := stressJob(t, c, "live-timing")
		job.Threshold = 15
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		first := make(chan time.Duration, 1)
		observeCtx, stopObserve := context.WithCancel(ctx)
		started := time.Now()
		go func() {
			for {
				if observeCtx.Err() != nil {
					return
				}
				var count int
				if c.db.QueryRowContext(observeCtx, `SELECT COUNT(*) FROM scan_live_offers WHERE offer_json IS NOT NULL`).Scan(&count) == nil && count > 0 {
					select {
					case first <- time.Since(started):
					default:
					}
					return
				}
				if !sleep(observeCtx, 10*time.Millisecond) {
					return
				}
			}
		}()
		result, err := c.collectOkalaStores(ctx, &job, []int64{2223}, map[int64]string{2223: "Store 2223"}, nil)
		elapsed := time.Since(started)
		stopObserve()
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if result.Coverage != "complete" {
			t.Fatalf("live run returned %q coverage", result.Coverage)
		}
		var firstTime time.Duration
		select {
		case firstTime = <-first:
		default:
		}
		t.Logf("LIVE workers=%d elapsed=%s first_results=%s upstream_requests=%d peak=%d products=%d discounts=%d", limit, elapsed, firstTime, calls.Load(), peak.Load(), result.ProductCount, len(result.Deals))
		before := calls.Load()
		warm := stressJob(t, c, "live-warm")
		warm.Threshold = 15
		started = time.Now()
		again, err := c.collectOkalaStores(context.Background(), &warm, []int64{2223}, map[int64]string{2223: "Store 2223"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if again.Coverage != "complete" || len(again.Deals) != len(result.Deals) {
			t.Fatal("warm result count changed")
		}
		t.Logf("LIVE warm workers=%d elapsed=%s upstream_requests=%d discounts=%d", limit, time.Since(started), calls.Load()-before, len(again.Deals))
	}
}
