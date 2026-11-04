package main

import (
	"context"
	"log/slog"
	"os"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
)

func main() {
	if err := run(); err != nil {
		slog.Error("database migration stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, err := storage.Open(ctx, config.DatabasePath())
	if err != nil {
		return err
	}
	defer db.Close()
	if err := storage.ApplyMigrations(ctx, db); err != nil {
		return err
	}
	slog.Info("database migrations applied")
	return nil
}
