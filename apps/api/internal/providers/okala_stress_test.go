package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func stressJob(t *testing.T, c *Collector, id string) scanJob {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	claim := insertRunningJournalScan(t, c.db, id, now, now)
	claim.UserID = "stress-user-" + id
	if _, err := c.db.Exec(`UPDATE scans SET user_id=? WHERE id=?`, claim.UserID, id); err != nil {
		t.Fatal(err)
	}
	if _, err := c.db.Exec(`UPDATE scan_execution SET user_id=? WHERE scan_id=?`, claim.UserID, id); err != nil {
		t.Fatal(err)
	}
	job, err := c.loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	return job
}
func catalogueTransport(delay time.Duration, gate chan struct{}, active, peak, calls *atomic.Int32) http.RoundTripper {
	return okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		var body any
		if strings.Contains(r.URL.Path, "categories") {
			categories := []any{}
			for i := 1; i <= 36; i++ {
				categories = append(categories, map[string]any{"id": i, "name": "Category"})
			}
			body = map[string]any{"success": true, "data": map[string]any{"categories": categories}}
		} else {
			if gate != nil {
				select {
				case gate <- struct{}{}:
				case <-r.Context().Done():
					return nil, r.Context().Err()
				}
				defer func() { <-gate }()
			}
			n := active.Add(1)
			defer active.Add(-1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			if !sleep(r.Context(), delay) {
				return nil, r.Context().Err()
			}
			store, _ := strconv.Atoi(r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:])
			id, _ := strconv.Atoi(r.URL.Query().Get("cId"))
			body = map[string]any{"success": true, "data": []any{map[string]any{"id": id, "name": fmt.Sprintf("Product %d", id), "storeId": store, "price": 1000, "okPrice": 600, "quantity": 2, "hasQuantity": true, "discountPercent": 40}}}
		}
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(encoded))), Request: r}, nil
	})
}
func TestOkalaGlobalTwentyFourRequestStress(t *testing.T) {
	var active, peak, calls atomic.Int32
	var responseActive, responsePeak atomic.Int32
	base := catalogueTransport(20*time.Millisecond, nil, &responseActive, &responsePeak, &calls)
	ready := make(chan struct{})
	var once sync.Once
	transport := okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "products") {
			n := active.Add(1)
			defer active.Add(-1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			if n == okalaConcurrency {
				once.Do(func() { close(ready) })
			}
			select {
			case <-ready:
			case <-time.After(10 * time.Second):
				return nil, fmt.Errorf("all %d workers did not enter transport", okalaConcurrency)
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		return base.RoundTrip(r)
	})
	c := &Collector{db: openJournalTestDB(t), client: &http.Client{Transport: transport}}
	jobs := []scanJob{stressJob(t, c, "stress-a"), stressJob(t, c, "stress-b")}
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			store := int64(i + 1)
			result, err := c.collectOkalaStores(context.Background(), &jobs[i], []int64{store}, map[int64]string{store: "Store"}, nil)
			if err != nil {
				t.Error(err)
				return
			}
			if len(result.Deals) != 36 || result.VendorCount != 1 {
				t.Errorf("lost results: %+v", result)
			}
		}(i)
	}
	wg.Wait()
	if peak.Load() != okalaConcurrency || active.Load() != 0 {
		t.Fatalf("peak=%d active=%d, expected %d and fully drained", peak.Load(), active.Load(), okalaConcurrency)
	}
	var count int
	if err := c.db.QueryRow(`SELECT COUNT(*) FROM scan_live_offers WHERE offer_json IS NOT NULL`).Scan(&count); err != nil || count != 72 {
		t.Fatalf("live rows=%d err=%v", count, err)
	}
	if err := c.db.QueryRow(`SELECT COUNT(*) FROM deals`).Scan(&count); err != nil || count != 0 {
		t.Fatal("provisional offers published to history", count, err)
	}
}
func TestOkalaCancellationDrainsWorkers(t *testing.T) {
	var active, peak, calls atomic.Int32
	c := &Collector{db: openJournalTestDB(t), client: &http.Client{Transport: catalogueTransport(time.Hour, nil, &active, &peak, &calls)}}
	job := stressJob(t, c, "stress-cancel")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := c.collectOkalaStores(ctx, &job, []int64{1}, nil, nil); done <- err }()
	deadline := time.Now().Add(3 * time.Second)
	for active.Load() < 6 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if active.Load() != 6 {
		t.Fatal("workers did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error=%v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not drain workers")
	}
	if active.Load() != 0 {
		t.Fatal("workers still fetching after cancellation")
	}
	var count int
	if err := c.db.QueryRow(`SELECT COUNT(*) FROM okala_offer_cache WHERE state='fetching'`).Scan(&count); err != nil || count != 0 {
		t.Fatal("abandoned cache owners", count, err)
	}
}
func TestOkalaSerialConcurrentAndWarmTiming(t *testing.T) {
	var durations [3]time.Duration
	for i := 0; i < 2; i++ {
		var active, peak, calls atomic.Int32
		var gate chan struct{}
		if i == 0 {
			gate = make(chan struct{}, 1)
		}
		c := &Collector{db: openJournalTestDB(t), client: &http.Client{Transport: catalogueTransport(50*time.Millisecond, gate, &active, &peak, &calls)}}
		job := stressJob(t, c, fmt.Sprintf("timing-%d", i))
		start := time.Now()
		result, err := c.collectOkalaStores(context.Background(), &job, []int64{1}, nil, nil)
		if err != nil || len(result.Deals) != 36 {
			t.Fatalf("result=%d err=%v", len(result.Deals), err)
		}
		durations[i] = time.Since(start)
		if i == 1 {
			before := calls.Load()
			warm := stressJob(t, c, "timing-warm")
			start = time.Now()
			result, err = c.collectOkalaStores(context.Background(), &warm, []int64{1}, nil, nil)
			if err != nil || len(result.Deals) != 36 {
				t.Fatal("warm cache lost results", err)
			}
			durations[2] = time.Since(start)
			if calls.Load() != before {
				t.Fatal("warm scan issued upstream requests")
			}
		}
	}
	t.Logf("36 categories at 50ms: serial=%s twelve-concurrent=%s warm=%s speedup=%.2fx", durations[0], durations[1], durations[2], float64(durations[0])/float64(durations[1]))
}

func TestOkalaLiveResultsArriveBeforeScanCompletes(t *testing.T) {
	var active, peak, calls atomic.Int32
	base := catalogueTransport(time.Millisecond, nil, &active, &peak, &calls)
	blocked := make(chan struct{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := &Collector{db: openJournalTestDB(t), client: &http.Client{Transport: okalaTestTransport(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "products") && r.URL.Query().Get("cId") != "1" {
			select {
			case <-blocked:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		return base.RoundTrip(r)
	})}}
	job := stressJob(t, c, "live-before-complete")
	done := make(chan error, 1)
	go func() { _, err := c.collectOkalaStores(ctx, &job, []int64{1}, nil, nil); done <- err }()
	var count int
	for ctx.Err() == nil {
		if err := c.db.QueryRow(`SELECT COUNT(*) FROM scan_live_offers WHERE offer_json IS NOT NULL`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if count == 0 {
		t.Fatal("no provisional results before completion")
	}
	select {
	case err := <-done:
		t.Fatal("scan unexpectedly completed", err)
	default:
	}
	close(blocked)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
