package scans

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/discounts"
	"github.com/alirezasoheili/better-buy/apps/api/internal/providers"
)

type Input struct {
	LocationID string `json:"locationId"`
	Source     string `json:"source"`
	Threshold  int    `json:"threshold"`
	Mode       string `json:"mode"`
}

type Location struct {
	ID                 string  `json:"id"`
	Name               string  `json:"name"`
	Latitude           float64 `json:"latitude"`
	Longitude          float64 `json:"longitude"`
	CoordinateRevision int     `json:"coordinateRevision"`
}

type Context = providers.Context

type Manifest = providers.Manifest

type Execution struct {
	Kind            string  `json:"kind"`
	Phase           string  `json:"phase"`
	CompletedUnits  int     `json:"completedUnits"`
	TotalUnits      int     `json:"totalUnits"`
	CompletedPages  int     `json:"completedPages"`
	ObservedRows    int     `json:"observedRows"`
	EligibleOffers  int     `json:"eligibleOffers"`
	AttemptCount    int     `json:"attemptCount"`
	HeartbeatAt     *string `json:"heartbeatAt"`
	DeadlineAt      *string `json:"deadlineAt"`
	DispatchState   string  `json:"dispatchState"`
	CancelRequested bool    `json:"cancelRequested"`
}

type Record struct {
	ID           string     `json:"id"`
	LocationID   string     `json:"locationId"`
	LocationName string     `json:"locationName"`
	Threshold    int        `json:"threshold"`
	Source       string     `json:"source"`
	Mode         string     `json:"mode"`
	Status       string     `json:"status"`
	CreatedAt    string     `json:"createdAt"`
	StartedAt    *string    `json:"startedAt"`
	FinishedAt   *string    `json:"finishedAt"`
	VendorCount  int        `json:"vendorCount"`
	ProductCount int        `json:"productCount"`
	DealCount    int        `json:"dealCount"`
	ErrorCode    *string    `json:"errorCode"`
	ErrorMessage *string    `json:"errorMessage"`
	Context      *Context   `json:"context"`
	Execution    *Execution `json:"execution,omitempty"`
}

type Deal = providers.Deal

type HistoryPage struct {
	Items      []Record `json:"items"`
	NextCursor *string  `json:"nextCursor"`
	ActiveScan *Record  `json:"activeScan"`
}

type historyPosition struct {
	Version   int    `json:"v"`
	Context   string `json:"context"`
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

type Collector interface {
	Collect(context.Context, providers.Claim) (providers.Completed, error)
}

type Error = providers.Failure

type Options struct {
	SnappStoreCampaignsEnabled bool
}

type Queue struct {
	db        *sql.DB
	collector Collector
	options   Options
	mu        sync.Mutex
	active    map[string]context.CancelFunc
	bootID    string
}

func NewQueue(db *sql.DB, collector Collector, options Options) (*Queue, error) {
	bootID, err := newID()
	if err != nil {
		return nil, err
	}
	return &Queue{db: db, collector: collector, options: options, active: make(map[string]context.CancelFunc), bootID: bootID}, nil
}

func (q *Queue) Enqueue(ctx context.Context, userID string, input Input, idempotencyKey string) (Record, error) {
	if !ValidUUID(input.LocationID) || input.Source == "" || input.Mode == "" || !discounts.Valid(input.Threshold) {
		return Record{}, &Error{Code: "INVALID_INPUT", Message: "Invalid scan request.", Status: 400}
	}
	if input.Source != "snappmarket" && input.Source != "okala" && input.Source != "digikalajet" {
		return Record{}, &Error{Code: "INVALID_INPUT", Message: "Invalid scan request.", Status: 400}
	}
	if input.Mode != "partial" && input.Mode != "full" {
		return Record{}, &Error{Code: "INVALID_INPUT", Message: "Invalid scan request.", Status: 400}
	}
	if idempotencyKey != "" && !ValidUUID(idempotencyKey) {
		return Record{}, &Error{Code: "INVALID_IDEMPOTENCY_KEY", Message: "Start intent must be a UUID.", Status: 400}
	}
	fingerprint, err := digest([]any{input.LocationID, input.Source, input.Threshold, input.Mode})
	if err != nil {
		return Record{}, err
	}
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback()
	if idempotencyKey != "" {
		var priorFingerprint, priorScanID string
		err := tx.QueryRowContext(ctx, `SELECT fingerprint,scan_id FROM scan_start_intents WHERE user_id=? AND idempotency_key=?`, userID, idempotencyKey).Scan(&priorFingerprint, &priorScanID)
		if err == nil {
			if priorFingerprint != fingerprint {
				return Record{}, &Error{Code: "IDEMPOTENCY_CONFLICT", Message: "This start intent belongs to another request.", Status: 409}
			}
			return readRecord(ctx, tx, userID, priorScanID)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Record{}, err
		}
	}
	if input.Source == "digikalajet" {
		return Record{}, &Error{Code: "PROVIDER_UNAVAILABLE", Message: "This retailer is not available for new scans.", Status: 409}
	}
	var location Location
	err = tx.QueryRowContext(ctx, `SELECT id,name,latitude,longitude,coordinate_revision FROM locations WHERE user_id=? AND id=?`, userID, input.LocationID).Scan(&location.ID, &location.Name, &location.Latitude, &location.Longitude, &location.CoordinateRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, &Error{Code: "LOCATION_NOT_FOUND", Message: "Delivery location is unavailable.", Status: 404}
	}
	if err != nil {
		return Record{}, err
	}
	if !withinTehran(location.Latitude, location.Longitude) {
		return Record{}, &Error{Code: "OUTSIDE_TEHRAN", Message: "Delivery location is outside the supported service area.", Status: 422}
	}
	var activeID string
	err = tx.QueryRowContext(ctx, `SELECT id FROM scans WHERE user_id=? AND source=? AND status IN ('queued','running') LIMIT 1`, userID, input.Source).Scan(&activeID)
	if err == nil {
		return Record{}, &Error{Code: "SCAN_IN_PROGRESS", Message: activeID, Status: 409}
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Record{}, err
	}
	threshold := discounts.Minimum
	contextRecord := newContext(location, input, threshold)
	contextJSON, err := json.Marshal(contextRecord)
	if err != nil {
		return Record{}, err
	}
	scanID, err := newID()
	if err != nil {
		return Record{}, err
	}
	deviceID, err := newID()
	if err != nil {
		return Record{}, err
	}
	at := time.Now().UTC()
	atText := at.Format(time.RFC3339Nano)
	if input.LocationID != location.ID {
		return Record{}, &Error{Code: "LOCATION_NOT_FOUND", Message: "Delivery location is unavailable.", Status: 404}
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at,context_json) SELECT ?,?,?,?,?,?,'queued',?,? WHERE EXISTS(SELECT 1 FROM locations WHERE id=? AND user_id=? AND coordinate_revision=? AND latitude=? AND longitude=? AND name=?)`, scanID, userID, location.ID, threshold, input.Source, input.Mode, atText, string(contextJSON), location.ID, userID, location.CoordinateRevision, location.Latitude, location.Longitude, location.Name)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "scans.user_id") {
			return Record{}, &Error{Code: "SCAN_IN_PROGRESS", Message: "A scan is already active for this account.", Status: 409}
		}
		return Record{}, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return Record{}, &Error{Code: "LOCATION_NOT_FOUND", Message: "Delivery location is unavailable.", Status: 404}
	}
	instanceID := "scan-" + scanID
	queuedUntil := at.Add(10 * time.Minute).Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_execution(scan_id,user_id,execution_kind,instance_id,device_id,enrichment_enabled,campaign_contribution_version,dispatch_state,phase,queued_until,created_at) VALUES(?,?,'workflow',?,?,?,1,'dispatched','queued',?,?)`, scanID, userID, instanceID, deviceID, boolInt(q.options.SnappStoreCampaignsEnabled), queuedUntil, atText); err != nil {
		return Record{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO vps_scan_jobs(instance_id,scan_id,state,ready_at,created_at,updated_at) VALUES(?,?,'queued',?,?,?)`, instanceID, scanID, at.UnixMilli(), atText, atText); err != nil {
		return Record{}, err
	}
	if idempotencyKey != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO scan_start_intents(user_id,idempotency_key,fingerprint,scan_id) VALUES(?,?,?,?)`, userID, idempotencyKey, fingerprint, scanID); err != nil {
			return Record{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "scans.user_id") {
			return Record{}, &Error{Code: "SCAN_IN_PROGRESS", Message: "A scan is already active for this account.", Status: 409}
		}
		return Record{}, err
	}
	return q.Get(ctx, userID, scanID)
}

func (q *Queue) Get(ctx context.Context, userID, scanID string) (Record, error) {
	return readRecord(ctx, q.db, userID, scanID)
}

func (q *Queue) Offers(ctx context.Context, userID, scanID string) ([]Deal, error) {
	item, err := q.Get(ctx, userID, scanID)
	if err != nil {
		return nil, err
	}
	if item.Status != "succeeded" {
		return nil, &Error{Code: "SCAN_NOT_PUBLISHED", Message: "Scan results are not available yet.", Status: 409}
	}
	rows, err := q.db.QueryContext(ctx, `SELECT deal_key,product_variation_id,vendor_id,title,image,vendor_title,vendor_code,category_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json FROM deals WHERE scan_id=? ORDER BY discount_ratio DESC,final_price_rials`, scanID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deals := make([]Deal, 0)
	for rows.Next() {
		var deal Deal
		var facts sql.NullString
		if err := rows.Scan(&deal.Key, &deal.ProductVariationID, &deal.VendorID, &deal.Title, &deal.Image, &deal.VendorTitle, &deal.VendorCode, &deal.CategoryTitle, &deal.PriceRials, &deal.DiscountRials, &deal.FinalPriceRials, &deal.DiscountRatio, &deal.Stock, &facts); err != nil {
			return nil, err
		}
		if facts.Valid {
			deal.Facts = json.RawMessage(facts.String)
		}
		deals = append(deals, deal)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return deals, nil
}

func (q *Queue) List(ctx context.Context, userID string) ([]Record, error) {
	rows, err := q.db.QueryContext(ctx, `SELECT id FROM scans WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 101`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, 101)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	items := make([]Record, 0, len(ids))
	for _, id := range ids {
		item, err := q.Get(ctx, userID, id)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

func (q *Queue) Active(ctx context.Context, userID string) (*Record, error) {
	return q.activeForSource(ctx, userID, "")
}

func (q *Queue) activeForSource(ctx context.Context, userID, source string) (*Record, error) {
	var scanID string
	err := q.db.QueryRowContext(ctx, `SELECT id FROM scans WHERE user_id=? AND (?='' OR source=?) AND status IN ('queued','running') ORDER BY created_at DESC,id DESC LIMIT 1`, userID, source, source).Scan(&scanID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item, err := q.Get(ctx, userID, scanID)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (q *Queue) FindStartIntent(ctx context.Context, userID, key string) (*Record, error) {
	var scanID string
	err := q.db.QueryRowContext(ctx, `SELECT scan_id FROM scan_start_intents WHERE user_id=? AND idempotency_key=?`, userID, key).Scan(&scanID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item, err := q.Get(ctx, userID, scanID)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (q *Queue) History(ctx context.Context, userID, boxKey, locationID, source string, limit int, cursor string) (HistoryPage, error) {
	if limit < 1 || limit > 100 || len(locationID) > 100 || (source != "" && source != "snappmarket" && source != "okala" && source != "digikalajet") || len(cursor) > 2000 {
		return HistoryPage{}, &Error{Code: "INVALID_INPUT", Message: "Invalid history request.", Status: 400}
	}
	var contextLocation any
	if locationID != "" {
		contextLocation = locationID
	}
	var contextSource any
	if source != "" {
		contextSource = source
	}
	contextKey, err := digest([]any{userID, contextLocation, contextSource})
	if err != nil {
		return HistoryPage{}, err
	}
	var before *historyPosition
	if cursor != "" {
		parts := strings.Split(cursor, ".")
		if len(parts) != 2 {
			return HistoryPage{}, &Error{Code: "INVALID_CURSOR", Message: "Invalid history cursor.", Status: 400}
		}
		payload, decodeErr := base64.RawURLEncoding.DecodeString(parts[0])
		signature, signatureErr := base64.RawURLEncoding.DecodeString(parts[1])
		keyBytes := []byte("history-v1:" + boxKey)
		mac := hmac.New(sha256.New, keyBytes)
		_, _ = mac.Write(payload)
		if decodeErr != nil || signatureErr != nil || !hmac.Equal(signature, mac.Sum(nil)) {
			return HistoryPage{}, &Error{Code: "INVALID_CURSOR", Message: "Invalid history cursor.", Status: 400}
		}
		var position historyPosition
		if json.Unmarshal(payload, &position) != nil || position.Version != 1 || position.Context != contextKey || position.ID == "" || position.CreatedAt == "" {
			return HistoryPage{}, &Error{Code: "INVALID_CURSOR", Message: "Invalid history cursor.", Status: 400}
		}
		if _, err := time.Parse(time.RFC3339Nano, position.CreatedAt); err != nil {
			return HistoryPage{}, &Error{Code: "INVALID_CURSOR", Message: "Invalid history cursor.", Status: 400}
		}
		before = &position
	}
	conditions := []string{"user_id=?"}
	args := []any{userID}
	if locationID != "" {
		conditions = append(conditions, "location_id=?")
		args = append(args, locationID)
	}
	if source != "" {
		conditions = append(conditions, "source=?")
		args = append(args, source)
	}
	if before != nil {
		conditions = append(conditions, "(created_at < ? OR (created_at=? AND id<?))")
		args = append(args, before.CreatedAt, before.CreatedAt, before.ID)
	}
	args = append(args, limit+1)
	rows, err := q.db.QueryContext(ctx, `SELECT id FROM scans WHERE `+strings.Join(conditions, " AND ")+` ORDER BY created_at DESC,id DESC LIMIT ?`, args...)
	if err != nil {
		return HistoryPage{}, err
	}
	ids := make([]string, 0, limit+1)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return HistoryPage{}, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return HistoryPage{}, err
	}
	if err := rows.Close(); err != nil {
		return HistoryPage{}, err
	}
	more := len(ids) > limit
	if more {
		ids = ids[:limit]
	}
	items := make([]Record, 0, len(ids))
	for _, id := range ids {
		item, err := q.Get(ctx, userID, id)
		if err != nil {
			return HistoryPage{}, err
		}
		items = append(items, item)
	}
	page := HistoryPage{Items: items}
	if more && len(items) > 0 {
		last := items[len(items)-1]
		position := historyPosition{Version: 1, Context: contextKey, CreatedAt: last.CreatedAt, ID: last.ID}
		payload, err := json.Marshal(position)
		if err != nil {
			return HistoryPage{}, err
		}
		mac := hmac.New(sha256.New, []byte("history-v1:"+boxKey))
		_, _ = mac.Write(payload)
		token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		page.NextCursor = &token
	}
	page.ActiveScan, err = q.activeForSource(ctx, userID, source)
	if err != nil {
		return HistoryPage{}, err
	}
	return page, nil
}

func (q *Queue) Cancel(ctx context.Context, userID, scanID string) (Record, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return Record{}, err
	}
	defer tx.Rollback()
	var status string
	err = tx.QueryRowContext(ctx, `SELECT status FROM scans WHERE id=? AND user_id=?`, scanID, userID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, &Error{Code: "NOT_FOUND", Message: "Scan not found.", Status: 404}
	}
	if err != nil {
		return Record{}, err
	}
	if status == "succeeded" || status == "failed" || status == "cancelled" {
		return Record{}, &Error{Code: "SCAN_TERMINAL", Message: "This scan can no longer be cancelled.", Status: 409}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scans SET status='cancelled',finished_at=?,error_code='CANCELLED',context_json=CASE WHEN context_json IS NULL THEN NULL ELSE json_set(context_json,'$.coverage','incomplete') END WHERE id=? AND user_id=? AND status IN ('queued','running')`, now, scanID, userID); err != nil {
		return Record{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET cancel_requested=1,phase='cancelled',heartbeat_at=? WHERE scan_id=? AND user_id=?`, now, scanID, userID); err != nil {
		return Record{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET stop_requested=1,state=CASE WHEN state IN ('queued','waiting') THEN 'stopped' ELSE state END,stop_reason=CASE WHEN state IN ('queued','waiting') THEN 'terminated' ELSE stop_reason END,owner_boot_id=CASE WHEN state IN ('queued','waiting') THEN NULL ELSE owner_boot_id END,updated_at=? WHERE scan_id=?`, now, scanID); err != nil {
		return Record{}, err
	}
	if err := tx.Commit(); err != nil {
		return Record{}, err
	}
	q.mu.Lock()
	if cancel := q.active[scanID]; cancel != nil {
		cancel()
	}
	q.mu.Unlock()
	return q.Get(ctx, userID, scanID)
}

func (q *Queue) Run(ctx context.Context) error {
	if err := q.recoverInterrupted(ctx); err != nil {
		return err
	}
	workerContext, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	slots := make(chan struct{}, 2)
	defer func() {
		cancel()
		workers.Wait()
	}()
	for workerContext.Err() == nil {
		select {
		case slots <- struct{}{}:
		case <-workerContext.Done():
			return nil
		}
		job, ok, err := q.claimNext(workerContext)
		if err != nil {
			<-slots
			if workerContext.Err() != nil {
				return nil
			}
			return err
		}
		if !ok {
			<-slots
			if !pause(workerContext, 500*time.Millisecond) {
				return nil
			}
			continue
		}
		workers.Add(1)
		go func(claim providers.Claim) {
			defer workers.Done()
			defer func() { <-slots }()
			q.runJob(workerContext, claim)
		}(job)
	}
	return nil
}

func (q *Queue) Reconcile(ctx context.Context) error {
	now := time.Now().UTC()
	cutoff := now.Add(-5 * time.Minute).Format(time.RFC3339Nano)
	rows, err := q.db.QueryContext(ctx, `SELECT j.instance_id,j.scan_id,j.worker_failures,s.status
		FROM vps_scan_jobs j JOIN scans s ON s.id=j.scan_id JOIN scan_execution e ON e.scan_id=s.id
		WHERE j.state='running' AND (e.heartbeat_at IS NULL OR e.heartbeat_at<=?) ORDER BY j.created_at`, cutoff)
	if err != nil {
		return err
	}
	type staleJob struct {
		instanceID string
		scanID     string
		failures   int
		status     string
	}
	stale := make([]staleJob, 0)
	for rows.Next() {
		var item staleJob
		if err := rows.Scan(&item.instanceID, &item.scanID, &item.failures, &item.status); err != nil {
			_ = rows.Close()
			return err
		}
		stale = append(stale, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	q.mu.Lock()
	active := make(map[string]struct{}, len(q.active))
	for scanID := range q.active {
		active[scanID] = struct{}{}
	}
	q.mu.Unlock()
	for _, item := range stale {
		if _, running := active[item.scanID]; running {
			continue
		}
		if err := q.reconcileStaleJob(ctx, now, item.instanceID, item.scanID); err != nil {
			return err
		}
	}
	return nil
}

func (q *Queue) reconcileStaleJob(ctx context.Context, now time.Time, instanceID, scanID string) error {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	var failures int
	err = tx.QueryRowContext(ctx, `SELECT s.status,j.worker_failures FROM scans s JOIN vps_scan_jobs j ON j.scan_id=s.id
		WHERE s.id=? AND j.instance_id=? AND j.state='running'`, scanID, instanceID).Scan(&status, &failures)
	if errors.Is(err, sql.ErrNoRows) {
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	nowText := now.Format(time.RFC3339Nano)
	if status == "cancelled" || status == "succeeded" || status == "failed" {
		reason := "terminated"
		if status == "succeeded" {
			reason = "complete"
		} else if status == "failed" {
			reason = "errored"
		}
		if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason=?,owner_boot_id=NULL,updated_at=? WHERE instance_id=? AND state='running'`, reason, nowText, instanceID); err != nil {
			return err
		}
		return tx.Commit()
	}
	failures++
	if failures >= 3 {
		if _, err := tx.ExecContext(ctx, `UPDATE scans SET status='failed',finished_at=?,error_code='ENGINE_RESTART_EXHAUSTED',error_message='The update could not complete; previous results remain available.',context_json=CASE WHEN context_json IS NULL THEN NULL ELSE json_set(context_json,'$.coverage','incomplete') END WHERE id=? AND status IN ('queued','running')`, nowText, scanID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET phase='failed',heartbeat_at=? WHERE scan_id=?`, nowText, scanID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='errored',owner_boot_id=NULL,worker_failures=?,updated_at=? WHERE instance_id=? AND state='running'`, failures, nowText, instanceID); err != nil {
			return err
		}
		return tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='queued',ready_at=?,worker_failures=?,owner_boot_id=NULL,updated_at=? WHERE instance_id=? AND state='running'`, now.Add(time.Duration(failures)*time.Second).UnixMilli(), failures, nowText, instanceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET phase='queued',heartbeat_at=NULL WHERE scan_id=?`, scanID); err != nil {
		return err
	}
	return tx.Commit()
}

func (q *Queue) recoverInterrupted(ctx context.Context) error {
	rows, err := q.db.QueryContext(ctx, `SELECT j.instance_id,j.scan_id,j.worker_failures,s.status FROM vps_scan_jobs j JOIN scans s ON s.id=j.scan_id WHERE j.state='running' ORDER BY j.created_at`)
	if err != nil {
		return err
	}
	type interruptedJob struct {
		instance, scanID, status string
		failures                 int
	}
	interrupted := make([]interruptedJob, 0)
	for rows.Next() {
		var item interruptedJob
		if err := rows.Scan(&item.instance, &item.scanID, &item.failures, &item.status); err != nil {
			_ = rows.Close()
			return err
		}
		interrupted = append(interrupted, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, job := range interrupted {
		if job.status == "cancelled" {
			if _, err := q.db.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',owner_boot_id=NULL,updated_at=? WHERE instance_id=?`, now.Format(time.RFC3339Nano), job.instance); err != nil {
				return err
			}
			continue
		}
		if job.status == "succeeded" || job.status == "failed" {
			if _, err := q.db.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='complete',owner_boot_id=NULL,updated_at=? WHERE instance_id=?`, now.Format(time.RFC3339Nano), job.instance); err != nil {
				return err
			}
			continue
		}
		failures := job.failures + 1
		if failures >= 3 {
			if err := q.fail(ctx, job.instance, job.scanID, "ENGINE_RESTART_EXHAUSTED", failures); err != nil {
				return err
			}
			continue
		}
		if _, err := q.db.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='queued',ready_at=?,owner_boot_id=NULL,worker_failures=?,updated_at=? WHERE instance_id=?`, now.UnixMilli(), failures, now.Format(time.RFC3339Nano), job.instance); err != nil {
			return err
		}
	}
	_, err = q.db.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='queued',updated_at=? WHERE state='waiting' AND ready_at<=? AND stop_requested=0`, now.Format(time.RFC3339Nano), now.UnixMilli())
	if err != nil {
		return err
	}
	_, err = q.db.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',owner_boot_id=NULL,updated_at=? WHERE stop_requested=1 AND state IN ('queued','waiting')`, now.Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	_, err = q.db.ExecContext(ctx, `UPDATE vps_scan_jobs SET owner_boot_id=NULL WHERE state<>'running'`)
	return err
}

func (q *Queue) claimNext(ctx context.Context) (providers.Claim, bool, error) {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return providers.Claim{}, false, err
	}
	defer tx.Rollback()
	now := time.Now().UTC()
	nowText := now.Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='queued',updated_at=? WHERE state='waiting' AND ready_at<=? AND stop_requested=0`, nowText, now.UnixMilli()); err != nil {
		return providers.Claim{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',owner_boot_id=NULL,updated_at=? WHERE stop_requested=1 AND state IN ('queued','waiting')`, nowText); err != nil {
		return providers.Claim{}, false, err
	}
	var claim providers.Claim
	var instanceID string
	err = tx.QueryRowContext(ctx, `SELECT j.instance_id,j.scan_id,s.user_id FROM vps_scan_jobs j JOIN scans s ON s.id=j.scan_id WHERE j.state='queued' AND j.ready_at<=? AND j.stop_requested=0 ORDER BY j.ready_at,j.created_at LIMIT 1`, now.UnixMilli()).Scan(&instanceID, &claim.ScanID, &claim.UserID)
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return providers.Claim{}, false, err
		}
		return providers.Claim{}, false, nil
	}
	if err != nil {
		return providers.Claim{}, false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='running',owner_boot_id=?,updated_at=? WHERE instance_id=? AND state='queued' AND stop_requested=0`, q.bootID, nowText, instanceID)
	if err != nil {
		return providers.Claim{}, false, err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return providers.Claim{}, false, nil
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scans SET status='running',started_at=COALESCE(started_at,?) WHERE id=? AND user_id=? AND status IN ('queued','running')`, nowText, claim.ScanID, claim.UserID); err != nil {
		return providers.Claim{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET phase='collecting',heartbeat_at=? WHERE scan_id=? AND user_id=?`, nowText, claim.ScanID, claim.UserID); err != nil {
		return providers.Claim{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return providers.Claim{}, false, err
	}
	claim.InstanceID = instanceID
	claim.OwnerBootID = q.bootID
	return claim, true, nil
}

func (q *Queue) runJob(parent context.Context, claim providers.Claim) {
	ctx, cancel := context.WithCancel(parent)
	q.mu.Lock()
	q.active[claim.ScanID] = cancel
	q.mu.Unlock()
	defer func() {
		cancel()
		q.mu.Lock()
		delete(q.active, claim.ScanID)
		q.mu.Unlock()
	}()
	watchDone := make(chan struct{})
	watchStop := make(chan struct{})
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-watchStop:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := q.heartbeat(ctx, claim); err != nil {
					cancel()
					return
				}
				cancelled, err := q.cancellationRequested(ctx, claim.ScanID)
				if err != nil || cancelled {
					cancel()
					return
				}
			}
		}
	}()
	if q.collector == nil {
		q.finishFailure(context.Background(), claim, "PROVIDER_ADAPTER_UNAVAILABLE")
		return
	}
	completed, err := q.collector.Collect(ctx, claim)
	close(watchStop)
	<-watchDone
	if parent.Err() != nil {
		q.requeueOnShutdown(claim)
		return
	}
	if q.isCancelled(claim.ScanID) {
		q.stopCancelled(claim.ScanID)
		return
	}
	if err != nil {
		var collectorErr *providers.Failure
		if errors.As(err, &collectorErr) && collectorErr.Retryable {
			q.retry(claim, collectorErr)
			return
		}
		code := "COLLECTION_FAILED"
		if errors.As(err, &collectorErr) && collectorErr.Code != "" {
			code = collectorErr.Code
		}
		q.finishFailure(context.Background(), claim, code)
		return
	}
	if err := q.finishSuccess(context.Background(), claim, completed); err != nil {
		q.finishFailure(context.Background(), claim, "PERSISTENCE_ERROR")
	}
}

func (q *Queue) finishSuccess(ctx context.Context, claim providers.Claim, completed providers.Completed) error {
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var currentStatus, contextJSON string
	var cancelRequested int
	err = tx.QueryRowContext(ctx, `SELECT s.status,s.context_json,e.cancel_requested FROM scans s JOIN scan_execution e ON e.scan_id=s.id JOIN vps_scan_jobs q ON q.scan_id=s.id WHERE s.id=? AND s.user_id=? AND e.user_id=? AND e.instance_id=? AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0`, claim.ScanID, claim.UserID, claim.UserID, claim.InstanceID, claim.InstanceID, claim.OwnerBootID).Scan(&currentStatus, &contextJSON, &cancelRequested)
	if errors.Is(err, sql.ErrNoRows) {
		return &providers.Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	if err != nil {
		return err
	}
	if currentStatus == "cancelled" || cancelRequested == 1 {
		if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',owner_boot_id=NULL,updated_at=? WHERE scan_id=? AND instance_id=? AND owner_boot_id=? AND state='running'`, now, claim.ScanID, claim.InstanceID, claim.OwnerBootID); err != nil {
			return err
		}
		return tx.Commit()
	}
	if currentStatus != "running" {
		return &providers.Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	var unfinishedUnits, incompletePages int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM scan_units WHERE scan_id=? AND terminal=0`, claim.ScanID).Scan(&unfinishedUnits); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM scan_pages WHERE scan_id=? AND complete=0`, claim.ScanID).Scan(&incompletePages); err != nil {
		return err
	}
	if unfinishedUnits != 0 || incompletePages != 0 {
		return &providers.Failure{Code: "INCOMPLETE_PAGINATION", Message: "The scan still has unfinished provider pages.", Status: 502}
	}
	summary := completed.Summary()
	if summary.ScanID != claim.ScanID || summary.VendorCount < 0 || summary.ProductCount < 0 {
		return errors.New("provider completion does not match the active scan")
	}
	var contextRecord Context
	if contextJSON == "" || json.Unmarshal([]byte(contextJSON), &contextRecord) != nil || contextRecord.ScopeHash == "" || contextRecord.ScopeHash != summary.ScopeHash {
		return errors.New("provider completion does not match the saved scan context")
	}
	deals := completed.Offers()
	for _, deal := range deals {
		dealID, err := newID()
		if err != nil {
			return err
		}
		facts := string(deal.Facts)
		if facts == "" {
			facts = "{}"
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,image,vendor_title,vendor_code,category_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock,facts_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,deal_key) DO UPDATE SET product_variation_id=excluded.product_variation_id,vendor_id=excluded.vendor_id,title=excluded.title,image=excluded.image,vendor_title=excluded.vendor_title,vendor_code=excluded.vendor_code,category_title=excluded.category_title,price_rials=excluded.price_rials,discount_rials=excluded.discount_rials,final_price_rials=excluded.final_price_rials,discount_ratio=excluded.discount_ratio,stock=excluded.stock,facts_json=excluded.facts_json`, dealID, claim.ScanID, deal.Key, deal.ProductVariationID, deal.VendorID, deal.Title, deal.Image, deal.VendorTitle, deal.VendorCode, deal.CategoryTitle, deal.PriceRials, deal.DiscountRials, deal.FinalPriceRials, deal.DiscountRatio, deal.Stock, facts); err != nil {
			return err
		}
	}
	coverage := summary.Coverage
	if coverage != "complete" && coverage != "incomplete" {
		coverage = "complete"
	}
	contextRecord.Coverage = coverage
	contextBytes, err := json.Marshal(contextRecord)
	if err != nil {
		return err
	}
	update, err := tx.ExecContext(ctx, `UPDATE scans SET status='succeeded',finished_at=?,vendor_count=?,product_count=?,deal_count=?,context_json=? WHERE id=? AND user_id=? AND status='running' AND EXISTS(SELECT 1 FROM scan_execution e WHERE e.scan_id=scans.id AND e.instance_id=? AND e.cancel_requested=0)`, now, summary.VendorCount, summary.ProductCount, len(deals), string(contextBytes), claim.ScanID, claim.UserID, claim.InstanceID)
	if err != nil {
		return err
	}
	changed, err := update.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return &providers.Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET phase='complete',heartbeat_at=? WHERE scan_id=? AND user_id=? AND instance_id=?`, now, claim.ScanID, claim.UserID, claim.InstanceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='complete',worker_failures=0,owner_boot_id=NULL,updated_at=? WHERE scan_id=? AND instance_id=? AND owner_boot_id=? AND state='running'`, now, claim.ScanID, claim.InstanceID, claim.OwnerBootID); err != nil {
		return err
	}
	return tx.Commit()
}

func (q *Queue) retry(claim providers.Claim, collectorErr *providers.Failure) {
	var failures int
	err := q.db.QueryRow(`SELECT worker_failures FROM vps_scan_jobs WHERE scan_id=? AND instance_id=? AND owner_boot_id=? AND state='running'`, claim.ScanID, claim.InstanceID, claim.OwnerBootID).Scan(&failures)
	if err != nil {
		return
	}
	failures++
	if failures >= 3 {
		q.finishFailure(context.Background(), claim, collectorErr.Code)
		return
	}
	delay := time.Duration(failures) * time.Second
	now := time.Now().UTC()
	_, _ = q.db.Exec(`UPDATE vps_scan_jobs SET state='waiting',ready_at=?,worker_failures=?,owner_boot_id=NULL,updated_at=? WHERE scan_id=? AND instance_id=? AND owner_boot_id=? AND state='running'`, now.Add(delay).UnixMilli(), failures, now.Format(time.RFC3339Nano), claim.ScanID, claim.InstanceID, claim.OwnerBootID)
}

func (q *Queue) finishFailure(ctx context.Context, claim providers.Claim, code string) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	update, err := tx.ExecContext(ctx, `UPDATE scans SET status='failed',finished_at=?,error_code=?,error_message='The update could not complete; previous results remain available.',context_json=CASE WHEN context_json IS NULL THEN NULL ELSE json_set(context_json,'$.coverage','incomplete') END WHERE id=? AND user_id=? AND status='running' AND EXISTS(SELECT 1 FROM scan_execution e WHERE e.scan_id=scans.id AND e.instance_id=? AND e.cancel_requested=0) AND EXISTS(SELECT 1 FROM vps_scan_jobs q WHERE q.scan_id=scans.id AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0)`, now, code, claim.ScanID, claim.UserID, claim.InstanceID, claim.InstanceID, claim.OwnerBootID)
	if err != nil {
		return
	}
	changed, err := update.RowsAffected()
	if err != nil || changed != 1 {
		return
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET phase='failed',heartbeat_at=? WHERE scan_id=? AND user_id=? AND instance_id=?`, now, claim.ScanID, claim.UserID, claim.InstanceID); err != nil {
		return
	}
	update, err = tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='errored',owner_boot_id=NULL,updated_at=? WHERE scan_id=? AND instance_id=? AND owner_boot_id=? AND state='running' AND stop_requested=0`, now, claim.ScanID, claim.InstanceID, claim.OwnerBootID)
	if err != nil {
		return
	}
	changed, err = update.RowsAffected()
	if err != nil || changed != 1 {
		return
	}
	_ = tx.Commit()
}

func (q *Queue) fail(ctx context.Context, instanceID, scanID, code string, failures int) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE scans SET status='failed',finished_at=?,error_code=?,error_message='The update could not complete; previous results remain available.',context_json=CASE WHEN context_json IS NULL THEN NULL ELSE json_set(context_json,'$.coverage','incomplete') END WHERE id=? AND status IN ('queued','running')`, now, code, scanID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET phase='failed',heartbeat_at=? WHERE scan_id=?`, now, scanID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE vps_scan_jobs SET state='stopped',stop_reason='errored',owner_boot_id=NULL,worker_failures=?,updated_at=? WHERE instance_id=?`, failures, now, instanceID); err != nil {
		return err
	}
	return tx.Commit()
}

func (q *Queue) requeueOnShutdown(claim providers.Claim) {
	now := time.Now().UTC()
	_, _ = q.db.Exec(`UPDATE vps_scan_jobs SET state='queued',ready_at=?,owner_boot_id=NULL,updated_at=? WHERE scan_id=? AND instance_id=? AND owner_boot_id=? AND state='running'`, now.UnixMilli(), now.Format(time.RFC3339Nano), claim.ScanID, claim.InstanceID, claim.OwnerBootID)
}

func (q *Queue) heartbeat(ctx context.Context, claim providers.Claim) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := q.db.ExecContext(ctx, `UPDATE scan_execution SET heartbeat_at=? WHERE scan_id=? AND user_id=? AND instance_id=? AND cancel_requested=0 AND EXISTS(SELECT 1 FROM scans s JOIN vps_scan_jobs q ON q.scan_id=s.id WHERE s.id=scan_execution.scan_id AND s.user_id=? AND s.status='running' AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0)`, now, claim.ScanID, claim.UserID, claim.InstanceID, claim.UserID, claim.InstanceID, claim.OwnerBootID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return &providers.Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	return nil
}

func (q *Queue) stopCancelled(scanID string) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = q.db.Exec(`UPDATE vps_scan_jobs SET state='stopped',stop_reason='terminated',owner_boot_id=NULL,updated_at=? WHERE scan_id=?`, now, scanID)
}

func (q *Queue) cancellationRequested(ctx context.Context, scanID string) (bool, error) {
	var cancelRequested int
	var status string
	err := q.db.QueryRowContext(ctx, `SELECT e.cancel_requested,s.status FROM scan_execution e JOIN scans s ON s.id=e.scan_id WHERE e.scan_id=?`, scanID).Scan(&cancelRequested, &status)
	return cancelRequested == 1 || status == "cancelled", err
}

func (q *Queue) isCancelled(scanID string) bool {
	cancelled, err := q.cancellationRequested(context.Background(), scanID)
	return err == nil && cancelled
}

func readRecord(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, userID, scanID string) (Record, error) {
	var item Record
	var startedAt, finishedAt, errorCode, errorMessage, contextJSON sql.NullString
	var executionPhase, dispatchState, heartbeatAt sql.NullString
	var completedUnits, totalUnits, completedPages, attemptCount, cancelRequested int
	err := queryer.QueryRowContext(ctx, `SELECT s.id,s.location_id,COALESCE(json_extract(s.context_json,'$.location.name'),l.name),s.threshold,s.source,s.mode,s.status,s.created_at,s.started_at,s.finished_at,s.vendor_count,s.product_count,s.deal_count,s.error_code,s.error_message,s.context_json,e.phase,e.dispatch_state,e.heartbeat_at,e.attempt_count,e.cancel_requested,(SELECT COUNT(*) FROM scan_units u WHERE u.scan_id=s.id AND u.terminal=1),(SELECT COUNT(*) FROM scan_units u WHERE u.scan_id=s.id),(SELECT COUNT(*) FROM scan_pages p WHERE p.scan_id=s.id AND p.complete=1) FROM scans s JOIN locations l ON l.id=s.location_id AND l.user_id=s.user_id LEFT JOIN scan_execution e ON e.scan_id=s.id WHERE s.user_id=? AND s.id=?`, userID, scanID).Scan(
		&item.ID, &item.LocationID, &item.LocationName, &item.Threshold, &item.Source, &item.Mode, &item.Status, &item.CreatedAt, &startedAt, &finishedAt, &item.VendorCount, &item.ProductCount, &item.DealCount, &errorCode, &errorMessage, &contextJSON, &executionPhase, &dispatchState, &heartbeatAt, &attemptCount, &cancelRequested, &completedUnits, &totalUnits, &completedPages,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Record{}, &Error{Code: "NOT_FOUND", Message: "Scan not found.", Status: 404}
	}
	if err != nil {
		return Record{}, err
	}
	item.StartedAt = nullString(startedAt)
	item.FinishedAt = nullString(finishedAt)
	item.ErrorCode = nullString(errorCode)
	item.ErrorMessage = nullString(errorMessage)
	if contextJSON.Valid && contextJSON.String != "" {
		var value Context
		if err := json.Unmarshal([]byte(contextJSON.String), &value); err != nil {
			return Record{}, fmt.Errorf("decode scan context: %w", err)
		}
		item.Context = &value
	}
	if executionPhase.Valid {
		item.Execution = &Execution{Kind: "workflow", Phase: executionPhase.String, CompletedUnits: completedUnits, TotalUnits: totalUnits, CompletedPages: completedPages, ObservedRows: item.ProductCount, EligibleOffers: item.DealCount, AttemptCount: attemptCount, HeartbeatAt: nullString(heartbeatAt), DispatchState: dispatchState.String, CancelRequested: cancelRequested != 0}
	}
	return item, nil
}

func newContext(location Location, input Input, threshold int) Context {
	manifest := Manifest{Adapter: "snapp-market-party", ContractVersion: 1, FeedKinds: []string{"market_party"}}
	if input.Source == "okala" {
		manifest = Manifest{Adapter: "okala-public-campaigns", ContractVersion: 1, FeedKinds: []string{"public_campaign_feed"}}
	}
	scope, _ := digest([]any{input.Source, manifest, threshold, 1, 1})
	value := Context{RequestedThreshold: input.Threshold, EffectiveThreshold: threshold, PolicyVersion: "automatic-v1", Manifest: manifest, ScopeHash: scope, EligibilityVersion: 1, OfferKeyVersion: 1, Coverage: "pending"}
	value.Location.Name = location.Name
	value.Location.Latitude = location.Latitude
	value.Location.Longitude = location.Longitude
	value.Location.Revision = location.CoordinateRevision
	return value
}

func digest(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func newID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(bytes)
	return hexValue[:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:], nil
}

func ValidUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	if !strings.ContainsRune("12345678", rune(value[14])) || !strings.ContainsRune("89abAB", rune(value[19])) {
		return false
	}
	_, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil
}

func withinTehran(latitude, longitude float64) bool {
	return latitude >= 35.56 && latitude <= 35.82 && longitude >= 51.18 && longitude <= 51.66
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func pause(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
