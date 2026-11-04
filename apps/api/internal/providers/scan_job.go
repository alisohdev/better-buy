package providers

import (
	"context"
	"time"
)

type scanInput struct {
	LocationID string
	Source     string
	Threshold  int
	Mode       string
}

type scanLocation struct {
	ID                 string
	Name               string
	Latitude           float64
	Longitude          float64
	CoordinateRevision int
}

type scanResult struct {
	VendorCount  int
	ProductCount int
	Deals        []Deal
	Coverage     string
}

type campaignContribution struct {
	DealKey   string
	Signature string
	Offer     *Deal
}

type scanObservation struct {
	Kind     string
	Identity string
}

type pageCheckpoint struct {
	UnitID        string
	Descriptor    string
	Page          int
	ResponseBody  []byte
	Metadata      string
	Terminal      bool
	TerminalNote  string
	Contributions []campaignContribution
	Observations  []scanObservation
}

type scanJob struct {
	ID                  string
	UserID              string
	Input               scanInput
	Threshold           int
	Location            scanLocation
	DeviceID            string
	Context             Context
	EnrichmentEnabled   bool
	ManifestFrozen      bool
	ContributionVersion int
	journal             *journal
}

func (j *scanJob) ClaimGuest401Refresh(ctx context.Context) (bool, error) {
	return j.journal.claimGuest401Refresh(ctx)
}

func (j *scanJob) ReserveRequest(ctx context.Context, operation string) error {
	return j.journal.reserveRequest(ctx, operation)
}

func (j *scanJob) LoadDiscovery(ctx context.Context, key string) (savedResponse, bool, error) {
	return j.journal.loadDiscovery(ctx, key)
}

func (j *scanJob) SaveDiscovery(ctx context.Context, key string, body []byte) (savedResponse, error) {
	return j.journal.saveDiscovery(ctx, key, body)
}

func (j *scanJob) RecordPage(ctx context.Context, page pageCheckpoint) error {
	return j.journal.recordPage(ctx, page)
}

func (j *scanJob) FreezeSnappManifest(ctx context.Context, scopes []CampaignScope) error {
	if len(scopes) == 0 {
		return nil
	}
	updated, err := j.journal.freezeSnappManifest(ctx, j.Input.Source, j.Threshold, j.Context, scopes)
	if err != nil {
		return err
	}
	j.Context = updated
	j.ManifestFrozen = true
	return nil
}

func (j *scanJob) CampaignContributions(ctx context.Context) ([]campaignContribution, error) {
	return j.journal.loadCampaignContributions(ctx)
}

func (j *scanJob) Progress(ctx context.Context, vendors, products int) error {
	return j.journal.progress(ctx, vendors, products)
}

func (j *scanJob) StartedAt() time.Time {
	return j.journal.startedAt
}
