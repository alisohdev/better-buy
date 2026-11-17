// One-off bounded cleanup; the API runs the same operation every 30 seconds.
package main

import (
	"context"
	"fmt"
	"github.com/alirezasoheili/better-buy/apps/api/internal/config"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
	"github.com/alirezasoheili/better-buy/apps/api/internal/storage"
	"log"
	"os"
	"time"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	db, err := storage.Open(ctx, config.DatabasePath())
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	if err = storage.ApplyMigrations(ctx, db); err != nil {
		log.Fatal(err)
	}
	if len(os.Args) > 1 && os.Args[1] == "--offline" {
		// Used only while the API is stopped, immediately before VACUUM rewrites the file.
		if _, err = db.ExecContext(ctx, "PRAGMA secure_delete=OFF"); err != nil {
			log.Fatal(err)
		}
	}
	q, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		log.Fatal(err)
	}
	for i := 0; i < 10000; i++ {
		var after int
		metric := `SELECT
 (SELECT count(*) FROM scans s WHERE s.status IN ('succeeded','failed','cancelled') AND s.id NOT IN (SELECT id FROM retained_scan_history) AND NOT EXISTS(SELECT 1 FROM vps_scan_jobs j WHERE j.scan_id=s.id AND j.state='running'))+
 (SELECT count(*) FROM scan_discovery t JOIN scans s ON s.id=t.scan_id WHERE s.status IN ('succeeded','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM vps_scan_jobs j WHERE j.scan_id=s.id AND j.state='running'))+
 (SELECT count(*) FROM scan_campaign_contributions t JOIN scans s ON s.id=t.scan_id WHERE s.status IN ('succeeded','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM vps_scan_jobs j WHERE j.scan_id=s.id AND j.state='running'))+
 (SELECT count(*) FROM okala_offer_cache WHERE julianday(reusable_until)<=julianday('now') OR julianday(lease_until)<=julianday('now'))`
		if err = q.MaintainRetention(ctx, time.Now().UTC()); err != nil {
			log.Fatal(err)
		}
		if i%20 != 0 {
			continue
		}
		if err = db.QueryRowContext(ctx, metric).Scan(&after); err != nil {
			log.Fatal(err)
		}
		if i%20 == 0 {
			fmt.Printf("batch=%d remaining_records=%d\n", i, after)
		}
		if after == 0 {
			fmt.Println("cleanup complete; active work is preserved")
			return
		}
	}
	log.Fatal("cleanup batch limit reached")
}
