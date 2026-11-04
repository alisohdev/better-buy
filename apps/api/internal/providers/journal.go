package providers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

type journal struct {
	db        *sql.DB
	claim     Claim
	startedAt time.Time
}

type savedResponse struct {
	Body       []byte
	ObservedAt string
}

func (c *Collector) loadScanJob(ctx context.Context, claim Claim) (scanJob, error) {
	j := &journal{db: c.db, claim: claim}
	var job scanJob
	var contextJSON sql.NullString
	var startedAt string
	var enrichmentEnabled, manifestFrozen, contributionVersion int
	err := c.db.QueryRowContext(ctx, `SELECT s.location_id,s.source,s.threshold,s.mode,s.context_json,e.device_id,e.enrichment_enabled,e.manifest_frozen,e.campaign_contribution_version,COALESCE(s.started_at,s.created_at)
		FROM scans s JOIN scan_execution e ON e.scan_id=s.id JOIN vps_scan_jobs q ON q.scan_id=s.id
		WHERE s.id=? AND s.user_id=? AND e.user_id=? AND e.instance_id=? AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0 AND s.status='running' AND e.cancel_requested=0`, claim.ScanID, claim.UserID, claim.UserID, claim.InstanceID, claim.InstanceID, claim.OwnerBootID).Scan(&job.Input.LocationID, &job.Input.Source, &job.Threshold, &job.Input.Mode, &contextJSON, &job.DeviceID, &enrichmentEnabled, &manifestFrozen, &contributionVersion, &startedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return scanJob{}, &Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	if err != nil {
		return scanJob{}, err
	}
	if !contextJSON.Valid || contextJSON.String == "" || json.Unmarshal([]byte(contextJSON.String), &job.Context) != nil || job.Context.Location.Name == "" {
		return scanJob{}, &Failure{Code: "SCAN_CONTEXT_UNAVAILABLE", Message: "The saved scan location is unavailable.", Status: 409}
	}
	job.ID = claim.ScanID
	job.UserID = claim.UserID
	job.Input.Threshold = job.Threshold
	job.Location = scanLocation{
		ID:                 job.Input.LocationID,
		Name:               job.Context.Location.Name,
		Latitude:           job.Context.Location.Latitude,
		Longitude:          job.Context.Location.Longitude,
		CoordinateRevision: job.Context.Location.Revision,
	}
	job.EnrichmentEnabled = enrichmentEnabled == 1
	job.ManifestFrozen = manifestFrozen == 1
	job.ContributionVersion = contributionVersion
	if job.ManifestFrozen && job.Input.Source == "snappmarket" && len(job.Context.Manifest.StoreCampaigns) > 0 {
		if job.Context.Manifest.Adapter != "snapp-market-party-with-store-campaigns" || job.Context.Manifest.ContractVersion != 1 || contributionVersion < 1 {
			return scanJob{}, &Failure{Code: "SCAN_CONTRACT_UNSUPPORTED", Message: "The saved Snapp campaign collection contract is not supported.", Status: 409}
		}
	}
	job.journal = j
	parsedStart, parseErr := time.Parse(time.RFC3339Nano, startedAt)
	if parseErr != nil {
		return scanJob{}, fmt.Errorf("parse saved scan start time: %w", parseErr)
	}
	if parsedStart.IsZero() {
		return scanJob{}, errors.New("saved scan start time is zero")
	}
	j.startedAt = parsedStart
	return job, nil
}

func (j *journal) active(ctx context.Context) error {
	return j.activeOn(ctx, j.db)
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (j *journal) activeOn(ctx context.Context, queryer rowQueryer) error {
	var active int
	err := queryer.QueryRowContext(ctx, `SELECT 1 FROM scans s JOIN scan_execution e ON e.scan_id=s.id JOIN vps_scan_jobs q ON q.scan_id=s.id
		WHERE s.id=? AND s.user_id=? AND e.user_id=? AND e.instance_id=? AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0 AND s.status='running' AND e.cancel_requested=0`, j.claim.ScanID, j.claim.UserID, j.claim.UserID, j.claim.InstanceID, j.claim.InstanceID, j.claim.OwnerBootID).Scan(&active)
	if errors.Is(err, sql.ErrNoRows) {
		return &Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	return err
}

func (j *journal) claimGuest401Refresh(ctx context.Context) (bool, error) {
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err := j.activeOn(ctx, tx); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE scan_execution SET guest_401_refreshed=1 WHERE scan_id=? AND user_id=? AND instance_id=? AND cancel_requested=0 AND guest_401_refreshed=0 AND EXISTS(SELECT 1 FROM vps_scan_jobs q WHERE q.scan_id=scan_execution.scan_id AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0)`, j.claim.ScanID, j.claim.UserID, j.claim.InstanceID, j.claim.InstanceID, j.claim.OwnerBootID)
	if err != nil {
		return false, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return changed == 1, nil
}

func (j *journal) reserveRequest(ctx context.Context, operation string) error {
	if err := j.active(ctx); err != nil {
		return err
	}
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.ExecContext(ctx, `UPDATE scan_execution SET attempt_count=attempt_count+1,heartbeat_at=? WHERE scan_id=? AND user_id=? AND instance_id=? AND cancel_requested=0 AND (SELECT COUNT(*) FROM scan_attempts WHERE scan_id=? AND operation=?)<3 AND EXISTS(SELECT 1 FROM scans s JOIN vps_scan_jobs q ON q.scan_id=s.id WHERE s.id=? AND s.user_id=? AND s.status='running' AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0)`, now, j.claim.ScanID, j.claim.UserID, j.claim.InstanceID, j.claim.ScanID, operation, j.claim.ScanID, j.claim.UserID, j.claim.InstanceID, j.claim.OwnerBootID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		var cancelRequested int
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT e.cancel_requested,s.status FROM scan_execution e JOIN scans s ON s.id=e.scan_id WHERE e.scan_id=?`, j.claim.ScanID).Scan(&cancelRequested, &status); err != nil {
			return err
		}
		if cancelRequested == 1 || status == "cancelled" {
			return &Failure{Code: "SCAN_CANCELLED", Message: "The scan was cancelled.", Status: 409}
		}
		return &Failure{Code: "REQUEST_RETRIES_EXHAUSTED", Message: "Provider operation retry attempts exhausted.", Status: 502}
	}
	var ordinal int
	if err := tx.QueryRowContext(ctx, `SELECT attempt_count FROM scan_execution WHERE scan_id=?`, j.claim.ScanID).Scan(&ordinal); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_attempts(scan_id,operation,ordinal,reserved_at) VALUES(?,?,?,?)`, j.claim.ScanID, operation, ordinal, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (j *journal) loadDiscovery(ctx context.Context, key string) (savedResponse, bool, error) {
	var item savedResponse
	var observedAt sql.NullString
	err := j.db.QueryRowContext(ctx, `SELECT body_json,observed_at FROM scan_discovery WHERE scan_id=? AND request_key=?`, j.claim.ScanID, key).Scan(&item.Body, &observedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return savedResponse{}, false, nil
	}
	if err != nil {
		return savedResponse{}, false, err
	}
	if observedAt.Valid {
		item.ObservedAt = observedAt.String
	}
	return item, true, nil
}

func (j *journal) saveDiscovery(ctx context.Context, key string, body []byte) (savedResponse, error) {
	if !json.Valid(body) {
		return savedResponse{}, errors.New("refusing to persist a non-JSON provider response")
	}
	observedAt := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return savedResponse{}, err
	}
	defer tx.Rollback()
	if err := j.activeOn(ctx, tx); err != nil {
		return savedResponse{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_discovery(scan_id,request_key,body_json,observed_at) VALUES(?,?,?,?) ON CONFLICT(scan_id,request_key) DO NOTHING`, j.claim.ScanID, key, string(body), observedAt); err != nil {
		return savedResponse{}, err
	}
	var item savedResponse
	var storedAt sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT body_json,observed_at FROM scan_discovery WHERE scan_id=? AND request_key=?`, j.claim.ScanID, key).Scan(&item.Body, &storedAt); err != nil {
		return savedResponse{}, err
	}
	if storedAt.Valid {
		item.ObservedAt = storedAt.String
	}
	if len(item.Body) == 0 {
		return savedResponse{}, errors.New("provider response checkpoint was not persisted")
	}
	if err := tx.Commit(); err != nil {
		return savedResponse{}, err
	}
	return item, nil
}

func (j *journal) recordPage(ctx context.Context, page pageCheckpoint) error {
	if page.UnitID == "" || page.Page < 0 || !json.Valid(page.ResponseBody) || !json.Valid([]byte(page.Descriptor)) || !json.Valid([]byte(page.Metadata)) {
		return errors.New("invalid scan page checkpoint")
	}
	digest := sha256.Sum256(page.ResponseBody)
	digestText := hex.EncodeToString(digest[:])
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := j.activeOn(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_units(scan_id,unit_id,descriptor_json) VALUES(?,?,?) ON CONFLICT(scan_id,unit_id) DO NOTHING`, j.claim.ScanID, page.UnitID, page.Descriptor); err != nil {
		return err
	}
	var descriptor string
	if err := tx.QueryRowContext(ctx, `SELECT descriptor_json FROM scan_units WHERE scan_id=? AND unit_id=?`, j.claim.ScanID, page.UnitID).Scan(&descriptor); err != nil {
		return err
	}
	legacyBaselineReplay := false
	if descriptor != page.Descriptor {
		if page.UnitID != "market_party" || descriptor != `{"kind":"market_party"}` || page.Descriptor != `{"kind":"market_party","contractVersion":1}` {
			return fmt.Errorf("scan unit descriptor changed for %s", page.UnitID)
		}
		var legacyDigest string
		var complete int
		if err := tx.QueryRowContext(ctx, `SELECT digest,complete FROM scan_pages WHERE scan_id=? AND unit_id=? AND page=?`, j.claim.ScanID, page.UnitID, page.Page).Scan(&legacyDigest, &complete); err != nil {
			return fmt.Errorf("legacy baseline page has no saved digest: %w", err)
		}
		if legacyDigest != digestText || complete != 1 {
			return fmt.Errorf("legacy baseline page digest does not match %s page %d", page.UnitID, page.Page)
		}
		legacyBaselineReplay = true
	}
	var pageMetadata struct {
		ContractVersion int `json:"contractVersion"`
	}
	if err := json.Unmarshal([]byte(page.Metadata), &pageMetadata); err != nil || pageMetadata.ContractVersion != 1 {
		if !legacyBaselineReplay {
			return errors.New("unsupported scan page metadata version")
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_pages(scan_id,unit_id,page,digest,metadata_json,expected_chunks,complete) VALUES(?,?,?,?,?,1,0) ON CONFLICT(scan_id,unit_id,page) DO NOTHING`, j.claim.ScanID, page.UnitID, page.Page, digestText, page.Metadata); err != nil {
		return err
	}
	var savedDigest, savedMetadata string
	if err := tx.QueryRowContext(ctx, `SELECT digest,metadata_json FROM scan_pages WHERE scan_id=? AND unit_id=? AND page=?`, j.claim.ScanID, page.UnitID, page.Page).Scan(&savedDigest, &savedMetadata); err != nil {
		return err
	}
	if savedDigest != digestText || (!legacyBaselineReplay && savedMetadata != page.Metadata) {
		return fmt.Errorf("scan page evidence changed for %s page %d", page.UnitID, page.Page)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_chunks(scan_id,unit_id,page,chunk,digest) VALUES(?,?,?,0,?) ON CONFLICT(scan_id,unit_id,page,chunk) DO NOTHING`, j.claim.ScanID, page.UnitID, page.Page, digestText); err != nil {
		return err
	}
	var savedChunkDigest string
	if err := tx.QueryRowContext(ctx, `SELECT digest FROM scan_chunks WHERE scan_id=? AND unit_id=? AND page=? AND chunk=0`, j.claim.ScanID, page.UnitID, page.Page).Scan(&savedChunkDigest); err != nil {
		return err
	}
	if savedChunkDigest != digestText {
		return fmt.Errorf("scan page chunk digest changed for %s page %d", page.UnitID, page.Page)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_pages SET complete=1 WHERE scan_id=? AND unit_id=? AND page=?`, j.claim.ScanID, page.UnitID, page.Page); err != nil {
		return err
	}
	if page.Terminal {
		if _, err := tx.ExecContext(ctx, `UPDATE scan_units SET terminal=1,terminal_evidence=? WHERE scan_id=? AND unit_id=? AND terminal=0`, page.TerminalNote, j.claim.ScanID, page.UnitID); err != nil {
			return err
		}
		var evidence sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT terminal_evidence FROM scan_units WHERE scan_id=? AND unit_id=?`, j.claim.ScanID, page.UnitID).Scan(&evidence); err != nil {
			return err
		}
		if evidence.String != page.TerminalNote {
			return fmt.Errorf("scan unit terminal evidence changed for %s", page.UnitID)
		}
	}
	for _, contribution := range page.Contributions {
		if contribution.DealKey == "" || contribution.Signature == "" {
			return errors.New("invalid campaign contribution")
		}
		encoded, err := json.Marshal(contribution)
		if err != nil {
			return err
		}
		var state string
		var priorJSON sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT state,offer_json FROM scan_campaign_contributions WHERE scan_id=? AND unit_id=? AND deal_key=?`, j.claim.ScanID, page.UnitID, contribution.DealKey).Scan(&state, &priorJSON)
		if errors.Is(err, sql.ErrNoRows) {
			if _, err := tx.ExecContext(ctx, `INSERT INTO scan_campaign_contributions(scan_id,unit_id,deal_key,state,offer_json) VALUES(?,?,?,'accepted',?)`, j.claim.ScanID, page.UnitID, contribution.DealKey, string(encoded)); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if state == "quarantined" {
			continue
		}
		var prior campaignContribution
		if !priorJSON.Valid || json.Unmarshal([]byte(priorJSON.String), &prior) != nil {
			return errors.New("invalid saved campaign contribution")
		}
		if prior.Signature != contribution.Signature {
			if _, err := tx.ExecContext(ctx, `UPDATE scan_campaign_contributions SET state='quarantined',offer_json=NULL WHERE scan_id=? AND unit_id=? AND deal_key=? AND state='accepted'`, j.claim.ScanID, page.UnitID, contribution.DealKey); err != nil {
				return err
			}
		}
	}
	for _, observation := range page.Observations {
		if (observation.Kind != "vendor" && observation.Kind != "product") || observation.Identity == "" {
			return errors.New("invalid scan observation")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO scan_observations(scan_id,kind,identity) VALUES(?,?,?) ON CONFLICT(scan_id,kind,identity) DO NOTHING`, j.claim.ScanID, observation.Kind, observation.Identity); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE scan_execution SET heartbeat_at=? WHERE scan_id=? AND user_id=? AND instance_id=?`, time.Now().UTC().Format(time.RFC3339Nano), j.claim.ScanID, j.claim.UserID, j.claim.InstanceID); err != nil {
		return err
	}
	return tx.Commit()
}

func (j *journal) progress(ctx context.Context, vendors, products int) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := j.db.ExecContext(ctx, `UPDATE scans SET vendor_count=?,product_count=? WHERE id=? AND user_id=? AND status='running' AND EXISTS(SELECT 1 FROM scan_execution e JOIN vps_scan_jobs q ON q.scan_id=e.scan_id WHERE e.scan_id=scans.id AND e.instance_id=? AND e.cancel_requested=0 AND q.instance_id=? AND q.owner_boot_id=? AND q.state='running' AND q.stop_requested=0)`, vendors, products, j.claim.ScanID, j.claim.UserID, j.claim.InstanceID, j.claim.InstanceID, j.claim.OwnerBootID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return &Failure{Code: "COLLECTION_CLAIM_LOST", Message: "The scan is no longer active.", Status: 409}
	}
	_, err = j.db.ExecContext(ctx, `UPDATE scan_execution SET heartbeat_at=? WHERE scan_id=? AND user_id=? AND instance_id=?`, now, j.claim.ScanID, j.claim.UserID, j.claim.InstanceID)
	return err
}

func (j *journal) freezeSnappManifest(ctx context.Context, source string, threshold int, current Context, scopes []CampaignScope) (Context, error) {
	if source != "snappmarket" {
		return Context{}, errors.New("campaign manifest can only be frozen for Snapp Market")
	}
	unique := make(map[string]CampaignScope, len(scopes))
	for _, scope := range scopes {
		if scope.VendorID <= 0 || scope.CollectionID <= 0 || scope.VendorCode == "" {
			return Context{}, errors.New("invalid Snapp campaign scope")
		}
		key := fmt.Sprintf("%s:%d:%d", scope.Source, scope.VendorID, scope.CollectionID)
		unique[key] = scope
	}
	ordered := make([]CampaignScope, 0, len(unique))
	for _, scope := range unique {
		ordered = append(ordered, scope)
	}
	sort.Slice(ordered, func(a, b int) bool {
		if ordered[a].VendorID != ordered[b].VendorID {
			return ordered[a].VendorID < ordered[b].VendorID
		}
		sourceA, sourceB := normalizedCampaignSource(ordered[a]), normalizedCampaignSource(ordered[b])
		if sourceA != sourceB {
			return sourceA < sourceB
		}
		return ordered[a].CollectionID < ordered[b].CollectionID
	})
	if len(ordered) == 0 {
		return current, nil
	}
	feedKinds := []string{"market_party"}
	feedSeen := map[string]struct{}{"market_party": {}}
	collectionSet := make(map[int64]struct{})
	storeSet := make(map[int64]struct{})
	for _, scope := range ordered {
		feed := normalizedCampaignSource(scope)
		if _, exists := feedSeen[feed]; !exists {
			feedSeen[feed] = struct{}{}
			feedKinds = append(feedKinds, feed)
		}
		collectionSet[scope.CollectionID] = struct{}{}
		storeSet[scope.VendorID] = struct{}{}
	}
	collectionIDs := make([]int64, 0, len(collectionSet))
	for id := range collectionSet {
		collectionIDs = append(collectionIDs, id)
	}
	storeIDs := make([]int64, 0, len(storeSet))
	for id := range storeSet {
		storeIDs = append(storeIDs, id)
	}
	sort.Slice(collectionIDs, func(a, b int) bool { return collectionIDs[a] < collectionIDs[b] })
	sort.Slice(storeIDs, func(a, b int) bool { return storeIDs[a] < storeIDs[b] })
	current.Manifest = Manifest{Adapter: "snapp-market-party-with-store-campaigns", ContractVersion: 1, FeedKinds: feedKinds, CollectionIDs: collectionIDs, StoreIDs: storeIDs, StoreCampaigns: ordered}
	identity, err := json.Marshal([]any{source, current.Manifest, threshold, current.EligibilityVersion, current.OfferKeyVersion})
	if err != nil {
		return Context{}, err
	}
	scopeDigest := sha256.Sum256(identity)
	current.ScopeHash = hex.EncodeToString(scopeDigest[:])
	encoded, err := json.Marshal(current)
	if err != nil {
		return Context{}, err
	}
	tx, err := j.db.BeginTx(ctx, nil)
	if err != nil {
		return Context{}, err
	}
	defer tx.Rollback()
	if err := j.activeOn(ctx, tx); err != nil {
		return Context{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO scan_units(scan_id,unit_id,descriptor_json) VALUES(?, 'market_party', ?) ON CONFLICT(scan_id,unit_id) DO NOTHING`, j.claim.ScanID, `{"kind":"market_party","contractVersion":1}`); err != nil {
		return Context{}, err
	}
	for _, scope := range ordered {
		descriptor, err := campaignUnitDescriptor(scope)
		if err != nil {
			return Context{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO scan_units(scan_id,unit_id,descriptor_json) VALUES(?,?,?) ON CONFLICT(scan_id,unit_id) DO NOTHING`, j.claim.ScanID, campaignUnitID(scope), string(descriptor)); err != nil {
			return Context{}, err
		}
	}
	result, err := tx.ExecContext(ctx, `UPDATE scans SET context_json=? WHERE id=? AND user_id=? AND status='running' AND json_extract(context_json,'$.manifest.storeCampaigns') IS NULL`, string(encoded), j.claim.ScanID, j.claim.UserID)
	if err != nil {
		return Context{}, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return Context{}, err
	}
	if changed != 1 {
		return Context{}, errors.New("Snapp campaign manifest was already frozen")
	}
	result, err = tx.ExecContext(ctx, `UPDATE scan_execution SET manifest_frozen=1 WHERE scan_id=? AND user_id=? AND instance_id=? AND manifest_frozen=0`, j.claim.ScanID, j.claim.UserID, j.claim.InstanceID)
	if err != nil {
		return Context{}, err
	}
	changed, err = result.RowsAffected()
	if err != nil {
		return Context{}, err
	}
	if changed != 1 {
		return Context{}, errors.New("Snapp campaign manifest freeze was not recorded")
	}
	if err := tx.Commit(); err != nil {
		return Context{}, err
	}
	return current, nil
}

func (j *journal) loadCampaignContributions(ctx context.Context) ([]campaignContribution, error) {
	if err := j.active(ctx); err != nil {
		return nil, err
	}
	rows, err := j.db.QueryContext(ctx, `SELECT offer_json FROM scan_campaign_contributions WHERE scan_id=? AND state='accepted' ORDER BY unit_id,deal_key`, j.claim.ScanID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]campaignContribution, 0)
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, err
		}
		var item campaignContribution
		if err := json.Unmarshal([]byte(encoded), &item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

func (j *journal) hasCampaignQuarantines(ctx context.Context) (bool, error) {
	if err := j.active(ctx); err != nil {
		return false, err
	}
	var found int
	err := j.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM scan_campaign_contributions WHERE scan_id=? AND state='quarantined')`, j.claim.ScanID).Scan(&found)
	return found == 1, err
}
