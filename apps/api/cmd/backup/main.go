package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
)

var backupName = regexp.MustCompile(`^better-buy-\d{8}T\d{6}Z\.sqlite$`)

func main() {
	if err := run(); err != nil {
		slog.Error("SQLite backup failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	retentionDays := 14
	if value := strings.TrimSpace(os.Getenv("VPS_BACKUP_RETENTION_DAYS")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return errors.New("VPS_BACKUP_RETENTION_DAYS must be between 1 and 365")
		}
		retentionDays = parsed
	}
	if retentionDays < 1 || retentionDays > 365 {
		return errors.New("VPS_BACKUP_RETENTION_DAYS must be between 1 and 365")
	}

	source, err := filepath.Abs(config.DatabasePath())
	if err != nil {
		return fmt.Errorf("resolve source database path: %w", err)
	}
	if info, err := os.Stat(source); err != nil {
		return fmt.Errorf("stat source database: %w", err)
	} else if !info.Mode().IsRegular() {
		return errors.New("source database is not a regular file")
	}

	backupDirectory := strings.TrimSpace(os.Getenv("VPS_BACKUP_DIR"))
	if backupDirectory == "" {
		backupDirectory = "../../.data/vps-backups"
	}
	backupDirectory, err = filepath.Abs(backupDirectory)
	if err != nil {
		return fmt.Errorf("resolve backup directory: %w", err)
	}
	if err := os.MkdirAll(backupDirectory, 0o750); err != nil {
		return fmt.Errorf("create backup directory: %w", err)
	}

	now := time.Now().UTC()
	name := "better-buy-" + now.Format("20060102T150405Z") + ".sqlite"
	destination := filepath.Join(backupDirectory, name)
	temporaryDestination := destination + ".tmp"
	destinationAbs, err := filepath.Abs(destination)
	if err != nil {
		return fmt.Errorf("resolve backup destination: %w", err)
	}
	if filepath.Clean(source) == filepath.Clean(destinationAbs) {
		return errors.New("backup destination must differ from the live database")
	}
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("backup already exists: %s", destination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("check backup destination: %w", err)
	}
	if _, err := os.Lstat(temporaryDestination); err == nil {
		return fmt.Errorf("temporary backup already exists: %s", temporaryDestination)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("check temporary backup destination: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	db, err := storage.Open(ctx, source)
	if err != nil {
		return err
	}
	quotedPath := strings.ReplaceAll(temporaryDestination, "'", "''")
	_, backupErr := db.ExecContext(ctx, "VACUUM INTO '"+quotedPath+"'")
	closeErr := db.Close()
	if backupErr != nil {
		_ = os.Remove(temporaryDestination)
		return fmt.Errorf("create consistent SQLite backup: %w", backupErr)
	}
	if closeErr != nil {
		_ = os.Remove(temporaryDestination)
		return fmt.Errorf("close source database: %w", closeErr)
	}
	if err := os.Rename(temporaryDestination, destination); err != nil {
		_ = os.Remove(temporaryDestination)
		return fmt.Errorf("publish backup atomically: %w", err)
	}
	if err := pruneBackups(backupDirectory, now.Add(-time.Duration(retentionDays)*24*time.Hour)); err != nil {
		return err
	}
	slog.Info("SQLite backup completed", "destination", destination)
	return nil
}

func pruneBackups(directory string, cutoff time.Time) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("list backup directory: %w", err)
	}
	for _, entry := range entries {
		if !backupName.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("inspect backup %q: %w", entry.Name(), err)
		}
		if !info.Mode().IsRegular() || !info.ModTime().Before(cutoff) {
			continue
		}
		if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
			return fmt.Errorf("remove expired backup %q: %w", entry.Name(), err)
		}
	}
	return nil
}
