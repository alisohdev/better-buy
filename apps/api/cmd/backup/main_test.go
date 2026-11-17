package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPruneBackupsKeepsOnlyCompletedNewest(t *testing.T) {
	dir := t.TempDir()
	keep := "better-buy-20261117T000000Z.sqlite"
	old := "better-buy-20261116T000000Z.sqlite"
	for _, name := range []string{keep, old, "unrelated.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("backup"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := pruneBackups(dir, keep); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, old)); !os.IsNotExist(err) {
		t.Fatal("previous backup retained")
	}
	for _, name := range []string{keep, "unrelated.txt"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
}
func TestPruneBackupsDoesNotDeleteWithoutCompletedBackup(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "better-buy-20261116T000000Z.sqlite")
	os.WriteFile(old, []byte("backup"), 0600)
	if err := pruneBackups(dir, "better-buy-20261117T000000Z.sqlite"); err == nil {
		t.Fatal("missing backup accepted")
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal("prior backup lost", err)
	}
}
