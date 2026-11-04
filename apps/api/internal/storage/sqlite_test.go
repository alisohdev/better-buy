package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenCreatesDatabaseAtPlatformPath(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	db, err := Open(ctx, filepath.Join(t.TempDir(), "better-buy.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
}
