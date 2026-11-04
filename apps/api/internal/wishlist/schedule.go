package wishlist

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	_ "time/tzdata"

	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

type scheduleJob struct {
	userID           string
	date             string
	slot             string
	source           string
	attempts         int
	locationID       string
	locationRevision int
	latitude         float64
	longitude        float64
}

func (m *Maintainer) runSchedule(ctx context.Context, now time.Time) error {
	if !m.scheduleEnabled {
		return nil
	}
	tehran, err := time.LoadLocation("Asia/Tehran")
	if err != nil {
		return err
	}
	local := now.In(tehran)
	minute := local.Minute()
	var slot string
	if local.Hour() == 9 && minute < 5 {
		slot = "morning"
	} else if local.Hour() == 18 && minute < 5 {
		slot = "evening"
	}
	nowText := isoTime(now)
	freshSince := isoTime(now.Add(-jobFreshness))
	if slot != "" {
		date := local.Format("2006-01-02")
		_, err = m.store.db.ExecContext(ctx, `INSERT OR IGNORE INTO wishlist_scan_schedule
			(user_id,schedule_date,schedule_slot,location_id,location_revision,latitude,longitude,created_at)
			SELECT p.user_id,?,?,l.id,l.coordinate_revision,l.latitude,l.longitude,?
			FROM wishlist_preferences p JOIN locations l ON l.id=p.default_location_id AND l.user_id=p.user_id
			WHERE EXISTS(SELECT 1 FROM wishlist_items i WHERE i.user_id=p.user_id)`, date, slot, nowText)
		if err != nil {
			return err
		}
		for _, source := range []string{"snappmarket", "okala"} {
			_, err = m.store.db.ExecContext(ctx, `INSERT OR IGNORE INTO wishlist_scan_schedule_jobs
				(user_id,schedule_date,schedule_slot,source,retry_after,updated_at)
				SELECT user_id,schedule_date,schedule_slot,?,?,? FROM wishlist_scan_schedule WHERE schedule_date=? AND schedule_slot=?`, source, nowText, nowText, date, slot)
			if err != nil {
				return err
			}
		}
	}
	if _, err := m.store.db.ExecContext(ctx, `UPDATE wishlist_scan_schedule_jobs SET state='pending',retry_after=?,updated_at=?
		WHERE state='running' AND updated_at<? AND EXISTS (
			SELECT 1 FROM wishlist_scan_schedule s WHERE s.user_id=wishlist_scan_schedule_jobs.user_id
			AND s.schedule_date=wishlist_scan_schedule_jobs.schedule_date AND s.schedule_slot=wishlist_scan_schedule_jobs.schedule_slot AND s.created_at>=?)`,
		nowText, nowText, isoTime(now.Add(-2*time.Minute)), freshSince); err != nil {
		return err
	}
	if _, err := m.store.db.ExecContext(ctx, `UPDATE wishlist_scan_schedule_jobs SET state='skipped',last_error='schedule_expired',updated_at=?
		WHERE state IN ('pending','running') AND EXISTS (
			SELECT 1 FROM wishlist_scan_schedule s WHERE s.user_id=wishlist_scan_schedule_jobs.user_id
			AND s.schedule_date=wishlist_scan_schedule_jobs.schedule_date AND s.schedule_slot=wishlist_scan_schedule_jobs.schedule_slot AND s.created_at<?)`, nowText, freshSince); err != nil {
		return err
	}
	for range jobBudget {
		job, err := m.pendingScheduleJob(ctx, now)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			return err
		}
		claimed, err := m.claimScheduleJob(ctx, now, job)
		if err != nil {
			return err
		}
		if !claimed {
			continue
		}
		if err := m.dispatchScheduleJob(ctx, now, job); err != nil {
			return err
		}
	}
	return nil
}

func (m *Maintainer) pendingScheduleJob(ctx context.Context, now time.Time) (scheduleJob, error) {
	var job scheduleJob
	err := m.store.db.QueryRowContext(ctx, `SELECT j.user_id,j.schedule_date,j.schedule_slot,j.source,j.attempts,
		s.location_id,s.location_revision,s.latitude,s.longitude
		FROM wishlist_scan_schedule_jobs j JOIN wishlist_scan_schedule s USING(user_id,schedule_date,schedule_slot)
		WHERE j.state='pending' AND j.retry_after<=? AND s.created_at>=?
		ORDER BY j.attempts,j.retry_after,j.user_id,j.schedule_date,j.schedule_slot,j.source LIMIT 1`, isoTime(now), isoTime(now.Add(-jobFreshness))).Scan(
		&job.userID, &job.date, &job.slot, &job.source, &job.attempts, &job.locationID, &job.locationRevision, &job.latitude, &job.longitude)
	return job, err
}

func (m *Maintainer) claimScheduleJob(ctx context.Context, now time.Time, job scheduleJob) (bool, error) {
	result, err := m.store.db.ExecContext(ctx, `UPDATE wishlist_scan_schedule_jobs SET state='running',attempts=attempts+1,updated_at=?
		WHERE user_id=? AND schedule_date=? AND schedule_slot=? AND source=? AND state='pending'`, isoTime(now), job.userID, job.date, job.slot, job.source)
	if err != nil {
		return false, err
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}

func (m *Maintainer) dispatchScheduleJob(ctx context.Context, now time.Time, job scheduleJob) error {
	var location, preference int
	err := m.store.db.QueryRowContext(ctx, `SELECT 1 FROM locations WHERE id=? AND user_id=? AND coordinate_revision=? AND latitude=? AND longitude=?`, job.locationID, job.userID, job.locationRevision, job.latitude, job.longitude).Scan(&location)
	if errors.Is(err, sql.ErrNoRows) {
		return m.finishScheduleJob(ctx, now, job, "skipped", nil, "default_location_changed")
	}
	if err != nil {
		return err
	}
	err = m.store.db.QueryRowContext(ctx, "SELECT 1 FROM wishlist_preferences WHERE user_id=? AND default_location_id=?", job.userID, job.locationID).Scan(&preference)
	if errors.Is(err, sql.ErrNoRows) {
		return m.finishScheduleJob(ctx, now, job, "skipped", nil, "default_location_changed")
	}
	if err != nil {
		return err
	}
	key := scheduleIdempotencyKey(job.userID, job.date, job.slot, job.source)
	scan, err := m.queue.Enqueue(ctx, job.userID, scans.Input{LocationID: job.locationID, Source: job.source, Threshold: discounts.Minimum, Mode: "full"}, key)
	if err == nil {
		return m.finishScheduleJob(ctx, now, job, "done", &scan.ID, "")
	}
	code := "DISPATCH_ERROR"
	var scanError *scans.Error
	if errors.As(err, &scanError) && scanError.Code != "" {
		code = scanError.Code
	}
	if retryableScheduleError(code) {
		exponent := min(job.attempts, 5)
		delay := min(10*time.Minute, 30*time.Second*time.Duration(1<<exponent))
		_, updateErr := m.store.db.ExecContext(ctx, `UPDATE wishlist_scan_schedule_jobs SET state='pending',retry_after=?,last_error=?,updated_at=?
			WHERE user_id=? AND schedule_date=? AND schedule_slot=? AND source=? AND state='running'`,
			isoTime(now.Add(delay)), truncateRunes(code, 100), isoTime(now), job.userID, job.date, job.slot, job.source)
		return updateErr
	}
	return m.finishScheduleJob(ctx, now, job, "skipped", nil, truncateRunes(code, 100))
}

func (m *Maintainer) finishScheduleJob(ctx context.Context, now time.Time, job scheduleJob, state string, scanID *string, reason string) error {
	_, err := m.store.db.ExecContext(ctx, `UPDATE wishlist_scan_schedule_jobs SET state=?,scan_id=?,last_error=?,updated_at=?
		WHERE user_id=? AND schedule_date=? AND schedule_slot=? AND source=?`, state, scanID, nullableString(reason), isoTime(now), job.userID, job.date, job.slot, job.source)
	return err
}

func scheduleIdempotencyKey(userID, date, slot, source string) string {
	digest := sha256.Sum256([]byte(strings.Join([]string{userID, date, slot, source}, "\x00")))
	key := append([]byte(nil), digest[:16]...)
	key[6] = (key[6] & 0x0f) | 0x50
	key[8] = (key[8] & 0x3f) | 0x80
	value := hex.EncodeToString(key)
	return fmt.Sprintf("%s-%s-%s-%s-%s", value[:8], value[8:12], value[12:16], value[16:20], value[20:])
}

func retryableScheduleError(code string) bool {
	switch code {
	case "SCAN_IN_PROGRESS", "ACTIVE_SCAN_EXISTS", "SCAN_CAPACITY", "SCAN_CAPACITY_REACHED", "CONCURRENCY_LIMIT", "GLOBAL_CONCURRENCY_LIMIT", "DISPATCH_ERROR", "PERSISTENCE_ERROR":
		return true
	default:
		return false
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}
