package providers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
)

func TestLoadScanJobUsesCreatedAtForNullStartedAt(t *testing.T) {
	db := openJournalTestDB(t)
	createdAt := "2026-11-02T10:00:00.123456789+03:30"
	claim := insertRunningJournalScan(t, db, "scan-null-start", nil, createdAt)

	job, err := (&Collector{db: db}).loadScanJob(context.Background(), claim)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := job.StartedAt().Format(time.RFC3339Nano), createdAt; got != want {
		t.Fatalf("StartedAt() = %q, want %q", got, want)
	}
}

func TestLoadScanJobRejectsInvalidStartedAt(t *testing.T) {
	for i, startedAt := range []string{"", "not-a-time", "0001-01-01T00:00:00Z"} {
		t.Run(startedAt, func(t *testing.T) {
			db := openJournalTestDB(t)
			claim := insertRunningJournalScan(t, db, "scan-invalid-"+string(rune('a'+i)), startedAt, "2026-11-02T10:00:00Z")
			if _, err := (&Collector{db: db}).loadScanJob(context.Background(), claim); err == nil {
				t.Fatal("loadScanJob() accepted an invalid non-NULL start")
			}
		})
	}
}

func TestLegacyDiscoveryConflictKeepsBodyAndUsesStableStartFallback(t *testing.T) {
	for _, observation := range []struct {
		name      string
		value     any
		validText bool
	}{
		{name: "null"},
		{name: "empty", value: "", validText: true},
	} {
		t.Run(observation.name, func(t *testing.T) {
			db := openJournalTestDB(t)
			startedAt := "2026-11-02T10:00:00.123456789+03:30"
			claim := insertRunningJournalScan(t, db, "scan-legacy-"+observation.name, startedAt, "2026-11-02T09:00:00Z")
			job, err := (&Collector{db: db}).loadScanJob(context.Background(), claim)
			if err != nil {
				t.Fatal(err)
			}

			const key = "legacy-response"
			originalBody := []byte(`{"legacy":true}`)
			if _, err := db.ExecContext(context.Background(), `INSERT INTO scan_discovery(scan_id,request_key,body_json,observed_at) VALUES(?,?,?,?)`, claim.ScanID, key, string(originalBody), observation.value); err != nil {
				t.Fatal(err)
			}

			want := "2026-11-02T06:30:00.123456789Z"
			for range 2 {
				loaded, found, err := job.LoadDiscovery(context.Background(), key)
				if err != nil {
					t.Fatal(err)
				}
				if !found || !bytes.Equal(loaded.Body, originalBody) {
					t.Fatalf("LoadDiscovery() = (%q, %v), want original response", loaded.Body, found)
				}
				resolved, err := stableObservedAt(loaded.ObservedAt, job.StartedAt())
				if err != nil {
					t.Fatal(err)
				}
				if resolved != want {
					t.Fatalf("resolved observation = %q, want %q", resolved, want)
				}
			}

			saved, err := job.SaveDiscovery(context.Background(), key, []byte(`{"new":true}`))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(saved.Body, originalBody) || saved.ObservedAt != "" {
				t.Fatalf("SaveDiscovery() conflict = (%q, %q), want original body and missing time", saved.Body, saved.ObservedAt)
			}
			contribution, _, err := campaignProduct(map[string]any{
				"id": 1, "vendor_id": 42, "document_id": "1-42", "title": "Test product",
				"price": 100, "discount": 50, "discountRatio": 50, "stock": 2,
			}, CampaignScope{VendorID: 42, VendorCode: "test-vendor", CollectionID: 7}, "Test vendor", 40, saved.ObservedAt, job.StartedAt())
			if err != nil {
				t.Fatal(err)
			}
			if contribution.Offer == nil {
				t.Fatal("campaignProduct() returned no eligible offer")
			}
			var facts struct {
				ObservedAt string `json:"observedAt"`
			}
			if err := json.Unmarshal(contribution.Offer.Facts, &facts); err != nil {
				t.Fatal(err)
			}
			if facts.ObservedAt != want {
				t.Fatalf("offer observation = %q, want %q", facts.ObservedAt, want)
			}

			var storedBody string
			var storedAt sql.NullString
			if err := db.QueryRowContext(context.Background(), `SELECT body_json,observed_at FROM scan_discovery WHERE scan_id=? AND request_key=?`, claim.ScanID, key).Scan(&storedBody, &storedAt); err != nil {
				t.Fatal(err)
			}
			if storedBody != string(originalBody) {
				t.Fatalf("stored body = %q, want original response", storedBody)
			}
			if storedAt.Valid != observation.validText || storedAt.Valid && storedAt.String != observation.value {
				t.Fatalf("stored observation = (%q, %v), want (%v, %v)", storedAt.String, storedAt.Valid, observation.value, observation.validText)
			}
		})
	}
}

func openJournalTestDB(t *testing.T) *sql.DB {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "journal.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.ApplyMigrations(ctx, db); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func insertRunningJournalScan(t *testing.T, db *sql.DB, scanID string, startedAt any, createdAt string) Claim {
	t.Helper()
	ctx := context.Background()
	claim := Claim{ScanID: scanID, UserID: "journal-test-user", InstanceID: "instance-" + scanID, OwnerBootID: "boot-test"}
	var scanContext Context
	scanContext.Location.Name = "Journal test location"
	scanContext.Location.Latitude = 35.6892
	scanContext.Location.Longitude = 51.3890
	scanContext.Location.Revision = 1
	scanContext.RequestedThreshold = 40
	scanContext.EffectiveThreshold = 40
	encodedContext, err := json.Marshal(scanContext)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,started_at,created_at,context_json) VALUES(?,?,?,?,?,?,'running',?,?,?)`, claim.ScanID, claim.UserID, "journal-location", 40, "snappmarket", "partial", startedAt, createdAt, string(encodedContext)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO scan_execution(scan_id,user_id,instance_id,device_id,queued_until,created_at) VALUES(?,?,?,?,?,?)`, claim.ScanID, claim.UserID, claim.InstanceID, "device-test", createdAt, createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO vps_scan_jobs(instance_id,scan_id,state,ready_at,owner_boot_id,created_at,updated_at) VALUES(?,?,'running',0,?,?,?)`, claim.InstanceID, claim.ScanID, claim.OwnerBootID, createdAt, createdAt); err != nil {
		t.Fatal(err)
	}
	return claim
}
