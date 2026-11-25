package mobileengine

import (
	"encoding/json"
	"sync"
	"testing"
	"time"
)

func TestConcurrentCancellationAllowsNextScan(t *testing.T) {
	e := New()
	seen := map[string]bool{}
	for range 20 {
		if code := e.Start(); code != "OK" {
			t.Fatalf("start after prior cancellation: %s", code)
		}
		var callers sync.WaitGroup
		for range 4 {
			callers.Go(func() {
				e.Cancel()
				_ = e.Status()
			})
		}
		callers.Wait()
		deadline := time.Now().Add(2 * time.Second)
		for {
			var s snapshot
			if err := json.Unmarshal([]byte(e.Status()), &s); err != nil {
				t.Fatal(err)
			}
			if s.State == "cancelled" {
				if s.ID == "" || seen[s.ID] || len(s.Offers) != 0 {
					t.Fatalf("invalid cancelled result: %+v", s)
				}
				seen[s.ID] = true
				break
			}
			if s.State != "running" || time.Now().After(deadline) {
				t.Fatalf("worker did not settle as cancelled: %+v", s)
			}
			time.Sleep(time.Millisecond)
		}
	}
}

func TestFixtureLifecycle(t *testing.T) {
	e := New()
	if e.Start() != "OK" || e.Start() != "BUSY" {
		t.Fatal("expected one active scan")
	}
	wait := func(want string) snapshot {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			var s snapshot
			if err := json.Unmarshal([]byte(e.Status()), &s); err != nil {
				t.Fatal(err)
			}
			if s.State == want {
				return s
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("wanted %s, got %s", want, e.Status())
		return snapshot{}
	}
	e.Cancel()
	wait("cancelled")
	if e.Start() != "OK" {
		t.Fatal("restart after cancel")
	}
	if s := wait("running"); s.Progress >= 3 {
		t.Fatalf("running progress should be provisional: %+v", s)
	}
	s := wait("complete")
	if s.ID == "" || s.Progress != 3 || len(s.Offers) != 2 || s.Offers[0].Price != 800 || s.Requests != 0 {
		t.Fatalf("%+v", s)
	}
	if e.ControlledError() != "FIXTURE_ERROR" || !json.Valid([]byte(e.Logs())) {
		t.Fatal(e.Logs())
	}
	t.Logf("fixture duration: %d ms; diagnostic JSON: %d bytes", s.Duration, len(e.Logs()))
}

func TestDiagnosticExportIsBounded(t *testing.T) {
	e := New()
	for range 64 {
		e.ControlledError()
	}
	var rows []map[string]any
	if err := json.Unmarshal([]byte(e.Logs()), &rows); err != nil || len(rows) != 32 {
		t.Fatalf("expected 32 valid events, got %d (%v)", len(rows), err)
	}
	for _, row := range rows {
		if row["code"] != "FIXTURE_ERROR" || row["engineVersion"] != e.Version() {
			t.Fatalf("unexpected diagnostics: %v", row)
		}
		for key := range row {
			switch key {
			case "time", "level", "msg", "engineVersion", "code":
			default:
				t.Fatalf("unexpected diagnostics field %q", key)
			}
		}
	}
}
