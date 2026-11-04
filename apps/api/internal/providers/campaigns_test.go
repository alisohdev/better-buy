package providers

import (
	"testing"
	"time"
)

func TestStableObservedAtUsesScanStart(t *testing.T) {
	startedAt := time.Date(2026, time.November, 2, 9, 30, 0, 0, time.UTC)

	got, err := stableObservedAt("", startedAt)
	if err != nil {
		t.Fatal(err)
	}
	if want := startedAt.Format(time.RFC3339Nano); got != want {
		t.Fatalf("stableObservedAt() = %q, want %q", got, want)
	}
}

func TestStableObservedAtRejectsMissingScanStart(t *testing.T) {
	if _, err := stableObservedAt("", time.Time{}); err == nil {
		t.Fatal("stableObservedAt() accepted a missing scan start time")
	}
}

func TestStableObservedAtPreservesNonemptyObservation(t *testing.T) {
	for _, observedAt := range []string{
		"2026-11-02T10:00:00+03:30",
		"not-a-time",
		" ",
		"0001-01-01T00:00:00Z",
	} {
		t.Run(observedAt, func(t *testing.T) {
			got, err := stableObservedAt(observedAt, time.Time{})
			if err != nil {
				t.Fatal(err)
			}
			if got != observedAt {
				t.Fatalf("stableObservedAt() = %q, want %q", got, observedAt)
			}
		})
	}
}
