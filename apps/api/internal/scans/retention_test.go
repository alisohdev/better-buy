package scans

import (
	"context"
	"fmt"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
	"path/filepath"
	"testing"
	"time"
)

func TestScanRetentionScopeAgeAndRawCleanup(t *testing.T) {
	ctx := context.Background()
	db, err := storage.Open(ctx, filepath.Join(t.TempDir(), "retention.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = storage.ApplyMigrations(ctx, db); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	insert := func(id, user, location, source, status string, age time.Duration) {
		t.Helper()
		stamp := now.Add(-age).Format(time.RFC3339Nano)
		_, err := db.Exec(`INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at) VALUES(?,?,?,15,?,'full',?,?)`, id, user, location, source, status, stamp)
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 5; i++ {
		insert(fmt.Sprint(i), "u", "home", "okala", "succeeded", time.Duration(i+1)*time.Hour)
	}
	insert("other-user", "v", "home", "okala", "succeeded", time.Hour)
	insert("other-store", "u", "home", "snappmarket", "succeeded", time.Hour)
	insert("other-location", "u", "office", "okala", "succeeded", time.Hour)
	insert("expired", "u", "home", "okala", "succeeded", 25*time.Hour)
	insert("active", "u", "home", "okala", "running", 25*time.Hour)
	for _, id := range []string{"0", "active"} {
		if _, err = db.Exec(`INSERT INTO scan_discovery(scan_id,request_key,body_json) VALUES(?,'key','{}')`, id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec(`INSERT INTO scan_diagnostics VALUES('old-log','u','okala','failed','TEST',?,?,0,0,0)`, now.Add(-96*time.Hour).Format(time.RFC3339Nano), now.Add(-96*time.Hour).Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	q, err := NewQueue(db, nil, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err = q.MaintainRetention(ctx, now); err != nil {
			t.Fatal(err)
		}
	}
	var count int
	db.QueryRow(`SELECT count(*) FROM scans`).Scan(&count)
	if count != 7 {
		t.Fatalf("retained %d scans, want 7", count)
	}
	db.QueryRow(`SELECT count(*) FROM scans WHERE id='active'`).Scan(&count)
	if count != 1 {
		t.Fatal("active scan removed")
	}
	db.QueryRow(`SELECT count(*) FROM scan_discovery WHERE scan_id='active'`).Scan(&count)
	if count != 1 {
		t.Fatal("active checkpoint removed")
	}
	db.QueryRow(`SELECT count(*) FROM scan_discovery WHERE scan_id='0'`).Scan(&count)
	if count != 0 {
		t.Fatal("terminal raw response retained")
	}
	db.QueryRow(`SELECT count(*) FROM scan_diagnostics WHERE scan_id='old-log'`).Scan(&count)
	if count != 0 {
		t.Fatal("old diagnostic retained")
	}
	if !Expired(Record{CreatedAt: now.Add(-24 * time.Hour).Format(time.RFC3339Nano)}, now) {
		t.Fatal("24 hour result remained fresh")
	}
	if _, err = db.Exec(`INSERT INTO scan_delete_requests VALUES('0',?)`, now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	if err = q.MaintainRetention(ctx, now); err != nil {
		t.Fatal(err)
	}
	db.QueryRow(`SELECT count(*) FROM scans WHERE id='0'`).Scan(&count)
	if count != 0 {
		t.Fatal("requested fresh scan not removed")
	}
	db.QueryRow(`SELECT count(*) FROM scans WHERE id='other-user'`).Scan(&count)
	if count != 1 {
		t.Fatal("another user affected")
	}

}
