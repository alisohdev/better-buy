package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/wishlist"
	_ "modernc.org/sqlite"
)

func main() {
	email := flag.String("email", "", "account email")
	userID := flag.String("user-id", "", "account ID")
	flag.Parse()
	if err := run(*email, *userID); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(email, userID string) error {
	if (email == "") == (userID == "") || flag.NArg() != 0 {
		return errors.New("provide exactly one of --email or --user-id")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	path, err := filepath.Abs(cfg.DatabasePath)
	if err != nil {
		return errors.New("invalid database path")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("configured database does not exist or is not a regular file")
	}
	u := url.URL{Scheme: "file", Path: filepath.ToSlash(path)}
	if filepath.VolumeName(path) != "" {
		u.Path = "/" + u.Path
	}
	query := url.Values{}
	query.Set("mode", "rw")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(ON)")
	u.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return errors.New("could not open database")
	}
	defer db.Close()
	if err := db.PingContext(context.Background()); err != nil {
		return errors.New("could not open existing database")
	}
	return wishlist.SendTestPush(context.Background(), db, cfg.BoxKey, wishlist.PushConfig{PublicKey: cfg.VAPIDPublicKey, PrivateKey: cfg.VAPIDPrivateKey, Subject: cfg.VAPIDSubject}, email, userID, os.Stdout)
}
