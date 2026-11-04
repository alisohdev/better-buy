package storage

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
)

//go:embed migrations
var migrationFiles embed.FS

var migrationName = regexp.MustCompile(`^\d{4}_[a-z0-9_-]+\.sql$`)

type migrationSet struct {
	directory string
	ledger    string
}

func ApplyMigrations(ctx context.Context, db *sql.DB) error {
	sets := []migrationSet{
		{directory: "migrations/app", ledger: "d1_migrations"},
		{directory: "migrations/engine", ledger: "vps_migrations"},
	}
	for _, set := range sets {
		if err := applySet(ctx, db, set); err != nil {
			return err
		}
	}
	return nil
}

func applySet(ctx context.Context, db *sql.DB, set migrationSet) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS `+set.ledger+` (
		name TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`); err != nil {
		return fmt.Errorf("create %s ledger: %w", set.ledger, err)
	}

	rows, err := db.QueryContext(ctx, `SELECT name FROM `+set.ledger)
	if err != nil {
		return fmt.Errorf("read %s ledger: %w", set.ledger, err)
	}
	applied := make(map[string]struct{})
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			_ = rows.Close()
			return fmt.Errorf("read %s migration name: %w", set.ledger, err)
		}
		applied[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate %s ledger: %w", set.ledger, err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close %s ledger rows: %w", set.ledger, err)
	}

	entries, err := fs.ReadDir(migrationFiles, set.directory)
	if err != nil {
		return fmt.Errorf("read %s migrations: %w", set.directory, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && migrationName.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		if _, ok := applied[name]; ok {
			continue
		}
		if err := applyMigration(ctx, db, set.ledger, path.Join(set.directory, name), name); err != nil {
			return err
		}
	}
	return nil
}

func applyMigration(ctx context.Context, db *sql.DB, ledger, filename, name string) error {
	sqlText, err := migrationFiles.ReadFile(filename)
	if err != nil {
		return fmt.Errorf("read migration %s: %w", filename, err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration %s: %w", name, err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, strings.TrimSpace(string(sqlText))); err != nil {
		return fmt.Errorf("apply migration %s: %w", name, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO `+ledger+` (name) VALUES (?)`, name); err != nil {
		return fmt.Errorf("record migration %s: %w", name, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration %s: %w", name, err)
	}
	return nil
}
