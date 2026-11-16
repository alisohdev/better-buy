package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const okalaConcurrency = 24

// This detects Okala's upstream response truncation; it never limits scan results.
const okalaCategoryLimit = 350

type okalaCategory struct {
	ID       int64           `json:"id"`
	Name     string          `json:"name"`
	Children []okalaCategory `json:"children"`
}
type okalaProduct struct {
	ID              any     `json:"id"`
	Name            string  `json:"name"`
	DiscountPercent float64 `json:"discountPercent"`
	Quantity        float64 `json:"quantity"`
	HasQuantity     bool    `json:"hasQuantity"`
	OkPrice         float64 `json:"okPrice"`
	Price           float64 `json:"price"`
	StoreID         int64   `json:"storeId"`
	ImageURL        *string `json:"imageUrl"`
}
type okalaTask struct {
	storeID  int64
	category *okalaCategory
}
type okalaTaskResult struct {
	task okalaTask
	body response
	err  error
}
type liveObservation struct {
	Key          string
	Offer        *Deal
	ObservedNano int64
	CategoryID   int64
}

func (c *Collector) collectOkala(ctx context.Context, job *scanJob) (scanResult, error) {
	coordinates := url.Values{"latitude": {strconv.FormatFloat(job.Location.Latitude, 'f', -1, 64)}, "longitude": {strconv.FormatFloat(job.Location.Longitude, 'f', -1, 64)}}
	nearby, err := c.okalaRequest(ctx, http.MethodGet, "/opex/v4/stores/nearby", coordinates, nil, job)
	if err != nil {
		return scanResult{}, err
	}
	var storeResponse struct {
		Success bool `json:"success"`
		Data    struct {
			Stores []struct {
				ID     int64  `json:"storeId"`
				Name   string `json:"storeName"`
				Logo   string `json:"logoUrl"`
				Active bool   `json:"isActive"`
				Serves bool   `json:"isServes"`
				Exists bool   `json:"isExist"`
			} `json:"stores"`
		} `json:"data"`
	}
	if json.Unmarshal(nearby.body, &storeResponse) != nil || !storeResponse.Success {
		return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala store response format changed.", Status: 502}
	}
	storeIDs := make([]int64, 0)
	seenStores := make(map[int64]struct{})
	storeNames := make(map[int64]string)
	storeLogos := make(map[int64]*string)
	for _, store := range storeResponse.Data.Stores {
		if err := ctx.Err(); err != nil {
			return scanResult{}, err
		}
		if store.ID > 0 && store.Active && store.Serves && store.Exists && okalaSupermarketStore(store.Name) {
			if _, exists := seenStores[store.ID]; !exists {
				seenStores[store.ID] = struct{}{}
				storeIDs = append(storeIDs, store.ID)
				storeNames[store.ID] = store.Name
				storeLogos[store.ID] = validHTTPURL(store.Logo)
			}
		}
	}
	if len(storeIDs) == 0 {
		return scanResult{}, &Failure{Code: "NO_STORES", Message: "No active Okala stores serve this location.", Status: 502}
	}

	return c.collectOkalaStores(ctx, job, storeIDs, storeNames, storeLogos)
}

func (c *Collector) collectOkalaStores(parent context.Context, job *scanJob, stores []int64, names map[int64]string, logos map[int64]*string) (scanResult, error) {
	ctx, cancel := context.WithCancel(parent)
	tasks := make(chan okalaTask)
	results := make(chan okalaTaskResult, okalaConcurrency)
	var workers sync.WaitGroup
	for i := 0; i < okalaConcurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case task, ok := <-tasks:
					if !ok {
						return
					}
					endpoint := "/unicorn/v3/categories/nearby"
					query := url.Values{"sId": {strconv.FormatInt(task.storeID, 10)}}
					if task.category != nil {
						endpoint = "/unicorn/v2/products/store/" + strconv.FormatInt(task.storeID, 10)
						query = url.Values{"cId": {strconv.FormatInt(task.category.ID, 10)}}
					}
					body, err := c.okalaRequest(ctx, http.MethodGet, endpoint, query, nil, job)
					select {
					case results <- okalaTaskResult{task, body, err}:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}
	defer func() { cancel(); close(tasks); workers.Wait() }()
	pending := make([]okalaTask, 0, len(stores))
	remaining := make(map[int64]int)
	for _, id := range stores {
		pending = append(pending, okalaTask{storeID: id})
		remaining[id] = 1
	}
	visited := make(map[string]bool)
	observations := make(map[string]liveObservation)
	incompleteStores := make(map[int64]bool)
	inspected := 0
	inflight := 0
	finishTask := func(storeID int64) {
		remaining[storeID]--
		if remaining[storeID] == 0 && !incompleteStores[storeID] {
			inspected++
		}
	}
	enqueue := func(storeID int64, category okalaCategory) error {
		if category.ID <= 0 {
			return &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala returned an invalid category identity.", Status: 502}
		}
		key := fmt.Sprintf("%d:%d", storeID, category.ID)
		if !visited[key] {
			visited[key] = true
			pending = append(pending, okalaTask{storeID: storeID, category: &category})
			remaining[storeID]++
		}
		return nil
	}
	for len(pending) > 0 || inflight > 0 {
		var send chan okalaTask
		var next okalaTask
		if len(pending) > 0 && inflight < okalaConcurrency {
			send = tasks
			next = pending[0]
		}
		select {
		case <-ctx.Done():
			return scanResult{}, ctx.Err()
		case send <- next:
			pending = pending[1:]
			inflight++
		case result := <-results:
			inflight--
			if result.err != nil {
				return scanResult{}, result.err
			}
			task := result.task
			if task.category == nil {
				var categories struct {
					Success bool `json:"success"`
					Data    *struct {
						Categories []okalaCategory `json:"categories"`
					} `json:"data"`
				}
				if json.Unmarshal(result.body.body, &categories) != nil {
					return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala category response format changed.", Status: 502}
				}
				if !categories.Success {
					incompleteStores[task.storeID] = true
					finishTask(task.storeID)
					if err := job.Progress(ctx, inspected, len(observations)); err != nil {
						return scanResult{}, err
					}
					continue
				}
				if categories.Data == nil || categories.Data.Categories == nil {
					return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala category response format changed.", Status: 502}
				}
				for _, category := range categories.Data.Categories {
					if err := enqueue(task.storeID, category); err != nil {
						return scanResult{}, err
					}
				}
			} else {
				category := task.category
				var catalogue struct {
					Success     bool           `json:"success"`
					Data        []okalaProduct `json:"data"`
					HasNextPage bool           `json:"hasNextPage"`
					TotalPages  int            `json:"totalPages"`
				}
				if json.Unmarshal(result.body.body, &catalogue) != nil {
					return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala catalogue response format changed.", Status: 502}
				}
				if !catalogue.Success {
					incompleteStores[task.storeID] = true
					finishTask(task.storeID)
					if err := job.Progress(ctx, inspected, len(observations)); err != nil {
						return scanResult{}, err
					}
					continue
				}
				if catalogue.Data == nil {
					return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala catalogue response format changed.", Status: 502}
				}
				saturated := len(catalogue.Data) >= okalaCategoryLimit || catalogue.HasNextPage || catalogue.TotalPages > 1
				if saturated && len(category.Children) == 0 {
					return scanResult{}, &Failure{Code: "INCOMPLETE_PAGINATION", Message: "Okala category is truncated and has no smaller categories to collect.", Status: 502}
				}
				observedAt, err := stableObservedAt(result.body.observedAt, job.StartedAt())
				if err != nil {
					return scanResult{}, err
				}
				observedTime, err := time.Parse(time.RFC3339Nano, observedAt)
				if err != nil {
					return scanResult{}, err
				}
				batch := make([]liveObservation, 0, len(catalogue.Data))
				for _, product := range catalogue.Data {
					id, ok := scalarString(product.ID)
					if !ok || id == "" || product.StoreID != task.storeID {
						return scanResult{}, &Failure{Code: "UPSTREAM_CHANGED", Message: "Okala returned an invalid product identity.", Status: 502}
					}
					key := fmt.Sprintf("%d:%s", task.storeID, id)
					observation := liveObservation{Key: key, ObservedNano: observedTime.UnixNano(), CategoryID: category.ID}
					if product.DiscountPercent >= float64(job.Threshold) && product.HasQuantity && product.Quantity > 0 {
						categoryName := category.Name
						observation.Offer = &Deal{Key: key, ProductVariationID: id, VendorID: strconv.FormatInt(task.storeID, 10), Title: product.Name, VendorTitle: names[task.storeID], Image: firstValidURLPointer(product.ImageURL), CategoryTitle: &categoryName, PriceRials: int64(product.Price), DiscountRials: max(int64(product.Price-product.OkPrice), 0), FinalPriceRials: int64(product.OkPrice), DiscountRatio: product.DiscountPercent, Stock: int(product.Quantity), Facts: facts(logos[task.storeID], observedAt, "okala:category:"+strconv.FormatInt(category.ID, 10), 50)}
					}
					batch = append(batch, observation)
				}
				metadata, _ := json.Marshal(map[string]any{"contractVersion": 1, "storeId": task.storeID, "categoryId": category.ID, "productCount": len(catalogue.Data), "split": saturated})
				descriptor := fmt.Sprintf(`{"kind":"okala_category","contractVersion":1,"storeId":%d,"categoryId":%d}`, task.storeID, category.ID)
				unitID := fmt.Sprintf("okala_category:%d:%d", task.storeID, category.ID)
				if err := job.RecordPage(ctx, pageCheckpoint{UnitID: unitID, Descriptor: descriptor, Page: 0, ResponseBody: result.body.body, Metadata: string(metadata), Terminal: true, TerminalNote: "category_response_complete"}); err != nil {
					return scanResult{}, err
				}
				if err := job.journal.publishLiveOffers(ctx, batch); err != nil {
					return scanResult{}, err
				}
				for _, observation := range batch {
					previous, exists := observations[observation.Key]
					if !exists || newerLiveObservation(observation, previous) {
						observations[observation.Key] = observation
					}
				}
				if saturated {
					for _, child := range category.Children {
						if err := enqueue(task.storeID, child); err != nil {
							return scanResult{}, err
						}
					}
				}
			}
			finishTask(task.storeID)
			if err := job.Progress(ctx, inspected, len(observations)); err != nil {
				return scanResult{}, err
			}
		}
	}
	deals := make([]Deal, 0, len(observations))
	for _, observation := range observations {
		if observation.Offer != nil {
			deals = append(deals, *observation.Offer)
		}
	}
	sort.Slice(deals, func(i, j int) bool { return deals[i].Key < deals[j].Key })
	coverage := "complete"
	if len(incompleteStores) > 0 {
		coverage = "incomplete"
	}
	return scanResult{VendorCount: inspected, ProductCount: len(observations), Deals: deals, Coverage: coverage}, nil
}
func newerLiveObservation(a, b liveObservation) bool {
	return a.ObservedNano > b.ObservedNano || a.ObservedNano == b.ObservedNano && a.CategoryID > b.CategoryID
}

// Exclude specialist stores before scheduling any catalogue requests.
func okalaSupermarketStore(name string) bool {
	normalized := strings.NewReplacer("ي", "ی", "ك", "ک", "\u200c", "", " ", "", "-", "").Replace(name)
	for _, specialist := range []string{"نانوایی", "نانوايی", "سوپرمیوه", "میوهفروشی", "میوهوتربار", "میوهترهبار", "میوهوترهبار"} {
		if strings.Contains(normalized, specialist) {
			return false
		}
	}
	return true
}
