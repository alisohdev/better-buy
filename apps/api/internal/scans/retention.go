package scans

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const MaxScanAge = 24 * time.Hour

func Expired(scan Record, now time.Time) bool {
	stamp := scan.CreatedAt
	if scan.StartedAt != nil {
		stamp = *scan.StartedAt
	}
	at, err := time.Parse(time.RFC3339Nano, stamp)
	return err != nil || !now.Before(at.Add(MaxScanAge))
}

// MaintainRetention runs bounded batches; it never loads response payloads into Go.
func (q *Queue) MaintainRetention(ctx context.Context, now time.Time) error {
	// Cancel requested scans using the normal claim-aware cancellation path.
	rows, err := q.db.QueryContext(ctx, `SELECT s.id,s.user_id FROM scans s JOIN scan_delete_requests d ON d.scan_id=s.id WHERE s.status IN ('queued','running') LIMIT 10`)
	if err != nil {
		return err
	}
	type item struct{ id, user string }
	items := []item{}
	for rows.Next() {
		var v item
		if err = rows.Scan(&v.id, &v.user); err != nil {
			rows.Close()
			return err
		}
		items = append(items, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range items {
		if _, err = q.Cancel(ctx, v.user, v.id); err != nil {
			return err
		}
	}
	// Remove raw resume material only after the collector releases its job.
	for _, table := range []string{"scan_discovery", "scan_campaign_contributions"} {
		_, err = q.db.ExecContext(ctx, `DELETE FROM `+table+` WHERE rowid IN (SELECT t.rowid FROM `+table+` t JOIN scans s ON s.id=t.scan_id WHERE s.status IN ('succeeded','failed','cancelled') AND (s.status!='cancelled' OR ?!='scan_campaign_contributions') AND NOT EXISTS(SELECT 1 FROM vps_scan_jobs j WHERE j.scan_id=s.id AND j.state='running') LIMIT 100)`, table)
		if err != nil {
			return err
		}
	}
	// One scan per transaction bounds writer lock duration and WAL growth.
	var id string
	err = q.db.QueryRowContext(ctx, `SELECT s.id FROM scans s WHERE s.status IN ('succeeded','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM vps_scan_jobs j WHERE j.scan_id=s.id AND j.state='running') AND (EXISTS(SELECT 1 FROM scan_delete_requests d WHERE d.scan_id=s.id) OR s.id NOT IN (SELECT id FROM retained_scan_history)) ORDER BY s.created_at LIMIT 1`).Scan(&id)
	if err == nil {
		tx, e := q.db.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		defer tx.Rollback()
		if _, e = tx.ExecContext(ctx, `DELETE FROM deals WHERE scan_id=?`, id); e != nil {
			return e
		}
		// Avoid cached baseline projections pointing at a deleted scan.
		if _, e = tx.ExecContext(ctx, `DELETE FROM product_projection_scans WHERE baseline_scan_id=?`, id); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `DELETE FROM scans WHERE id=? AND status IN ('succeeded','failed','cancelled')`, id); e != nil {
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = q.db.ExecContext(ctx, `DELETE FROM okala_offer_cache WHERE request_key IN (SELECT request_key FROM okala_offer_cache WHERE (reusable_until IS NOT NULL AND reusable_until<=?) OR (lease_until IS NOT NULL AND lease_until<=?) LIMIT 100)`, now.UTC().Format(time.RFC3339Nano), now.UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	cutoff := now.Add(-72 * time.Hour).UTC().Format(time.RFC3339Nano)
	for _, qtext := range []string{`DELETE FROM scan_diagnostics WHERE scan_id IN (SELECT scan_id FROM scan_diagnostics WHERE updated_at<? LIMIT 100)`, `DELETE FROM admin_scan_audit WHERE id IN (SELECT id FROM admin_scan_audit WHERE created_at<? LIMIT 100)`} {
		if _, err = q.db.ExecContext(ctx, qtext, cutoff); err != nil {
			return err
		}
	}
	return nil
}
