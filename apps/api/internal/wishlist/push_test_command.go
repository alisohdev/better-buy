package wishlist

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/alirezasoheili/better-buy/apps/api/internal/products"
	"github.com/alirezasoheili/better-buy/apps/api/internal/scans"
)

// SendTestPush sends one test to every subscription owned by exactly one user.
func SendTestPush(ctx context.Context, db *sql.DB, boxKey string, cfg PushConfig, email, userID string, output io.Writer) error {
	return sendTestPush(ctx, db, boxKey, cfg, email, userID, output, &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, selectTestProduct)
}

type testProductSelector func(context.Context, *sql.DB, string, string) (Match, string, error)

func sendTestPush(ctx context.Context, db *sql.DB, boxKey string, cfg PushConfig, email, userID string, output io.Writer, client *http.Client, selectProduct testProductSelector) error {
	email, userID = strings.TrimSpace(email), strings.TrimSpace(userID)
	if (email == "") == (userID == "") {
		return errors.New("provide exactly one of --email or --user-id")
	}
	if boxKey == "" {
		return errors.New("BOX_KEY is missing")
	}
	if err := ValidatePushConfig(cfg); err != nil {
		return err
	}
	var selected string
	var err error
	if email != "" {
		err = db.QueryRowContext(ctx, `SELECT id FROM "user" WHERE email=? COLLATE NOCASE`, email).Scan(&selected)
	} else {
		err = db.QueryRowContext(ctx, `SELECT id FROM "user" WHERE id=?`, userID).Scan(&selected)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("account not found")
	}
	if err != nil {
		return errors.New("could not read account from database")
	}
	rows, err := db.QueryContext(ctx, `SELECT id, encrypted_subscription FROM push_subscriptions WHERE user_id=? ORDER BY id`, selected)
	if err != nil {
		return errors.New("could not read subscriptions from database")
	}
	type subscription struct{ id, encrypted string }
	var subscriptions []subscription
	for rows.Next() {
		var s subscription
		if rows.Scan(&s.id, &s.encrypted) != nil {
			rows.Close()
			return errors.New("could not read subscriptions")
		}
		subscriptions = append(subscriptions, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return errors.New("could not read subscriptions")
	}
	fmt.Fprintf(output, "Subscriptions: %d\n", len(subscriptions))
	if len(subscriptions) == 0 {
		return errors.New("no subscriptions for this account; enable push on your phone")
	}
	match, scanID, err := selectProduct(ctx, db, boxKey, selected)
	if err != nil {
		return err
	}
	id, err := newID()
	if err != nil {
		return errors.New("could not generate test ID")
	}
	payload, err := json.Marshal(map[string]string{"id": "test-" + id, "title": "آزمایش اعلان بهتر بخر", "body": productPushBody(match, 0), "url": productDetailURL(scanID, match.ProductKey)})
	if err != nil {
		return err
	}
	accepted, failed := 0, 0
	for _, sub := range subscriptions {
		status, sendErr := sendPush(ctx, client, cfg, boxKey, selected, sub.id, sub.encrypted, payload)
		result := "accepted"
		if status == http.StatusGone || status == http.StatusNotFound {
			result = "expired"
			if _, err := db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE id=? AND user_id=?`, sub.id, selected); err != nil {
				result = "expired (cleanup failed)"
			}
		} else if sendErr != nil {
			result = sendErr.Error()
		}
		if sendErr == nil {
			accepted++
		} else {
			failed++
		}
		fmt.Fprintf(output, "%s: %s\n", sub.id, result)
	}
	fmt.Fprintf(output, "Accepted: %d; failed: %d\n", accepted, failed)
	if failed != 0 {
		return errors.New("one or more pushes failed")
	}
	return nil
}

func selectTestProduct(ctx context.Context, db *sql.DB, boxKey, userID string) (Match, string, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, source FROM scans WHERE user_id=? AND status='succeeded' ORDER BY created_at DESC LIMIT 30`, userID)
	if err != nil {
		return Match{}, "", errors.New("could not read saved scans")
	}
	type savedScan struct{ id, source string }
	var history []savedScan
	for rows.Next() {
		var s savedScan
		if rows.Scan(&s.id, &s.source) != nil {
			rows.Close()
			return Match{}, "", errors.New("could not read saved scans")
		}
		history = append(history, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Match{}, "", errors.New("could not read saved scans")
	}
	queue, err := scans.NewQueue(db, nil, scans.Options{})
	if err != nil {
		return Match{}, "", errors.New("could not initialize scan reader")
	}
	catalog := products.New(db, boxKey)
	for _, scan := range history {
		groups, _, err := catalog.ProductGroups(ctx, queue, userID, scan.id)
		if err != nil {
			continue
		}
		var matches []Match
		for _, group := range groups {
			for _, offer := range group.Vendors {
				if offer.Stock > 0 && offer.State != "no_longer_present" {
					matches = append(matches, Match{Title: group.Title, Price: offer.FinalAmountToman, DiscountPercent: offer.DiscountRatio, Source: scan.source, ProductKey: group.Key, VendorID: offer.VendorID, VendorTitle: offer.VendorTitle})
				}
			}
		}
		if best, ok := featuredMatch(matches); ok {
			return best, scan.id, nil
		}
	}
	return Match{}, "", errors.New("no suitable product in saved successful scans")
}
