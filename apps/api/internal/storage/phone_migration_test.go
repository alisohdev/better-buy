package storage

import (
	"context"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

func TestPhoneMigrationPreservesOwnership(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "legacy.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("CREATE TABLE d1_migrations(name TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)"); err != nil {
		t.Fatal(err)
	}
	files, err := fs.ReadDir(migrationFiles, "migrations/app")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".sql") || file.Name() >= "0021" {
			continue
		}
		data, err := migrationFiles.ReadFile("migrations/app/" + file.Name())
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(data)); err != nil {
			t.Fatal(file.Name(), err)
		}
		if _, err = db.Exec("INSERT INTO d1_migrations(name) VALUES(?)", file.Name()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = db.Exec("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('preserved','Fixture','fixture@example.test','2026-01-01','2026-01-01'); INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at) VALUES('place','preserved','Home',35,51,1,'2026-01-01','2026-01-01')"); err != nil {
		t.Fatal(err)
	}
	if err = ApplyMigrations(ctx, db); err != nil {
		t.Fatal(err)
	}
	var id, label string
	err = db.QueryRow("SELECT u.id,u.legacy_identity FROM user u JOIN locations l ON l.user_id=u.id WHERE l.id='place'").Scan(&id, &label)
	if err != nil || id != "preserved" || label != "fixture@example.test" {
		t.Fatal(id, label, err)
	}
	if err = ApplyMigrations(ctx, db); err != nil {
		t.Fatal("migration not idempotent", err)
	}
}
