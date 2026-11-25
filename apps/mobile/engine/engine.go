package mobileengine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"sync"
	"time"
)

const version = "0.1.0"
const logLimit = 32

type offer struct {
	Key   string `json:"key"`
	Price int64  `json:"price"`
}
type snapshot struct {
	ID       string  `json:"id"`
	State    string  `json:"state"`
	Progress int     `json:"progress"`
	Requests int     `json:"requests"`
	Duration int64   `json:"durationMs"`
	Offers   []offer `json:"offers,omitempty"`
}
type logBuffer struct {
	mu   sync.Mutex
	rows []json.RawMessage
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.rows) == logLimit {
		copy(b.rows, b.rows[1:])
		b.rows = b.rows[:logLimit-1]
	}
	b.rows = append(b.rows, append(json.RawMessage(nil), p...))
	return len(p), nil
}

type Engine struct {
	mu     sync.Mutex
	state  snapshot
	cancel context.CancelFunc
	buffer *logBuffer
	logger *slog.Logger
}

func New() *Engine {
	b := &logBuffer{rows: make([]json.RawMessage, 0, logLimit)}
	return &Engine{state: snapshot{State: "idle"}, buffer: b, logger: slog.New(slog.NewJSONHandler(b, nil)).With("engineVersion", version)}
}
func (e *Engine) Version() string { return version }
func (e *Engine) Status() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	data, _ := json.Marshal(e.state)
	return string(data)
}
func (e *Engine) Logs() string {
	e.buffer.mu.Lock()
	defer e.buffer.mu.Unlock()
	data, _ := json.Marshal(e.buffer.rows)
	return string(data)
}
func (e *Engine) ControlledError() string {
	e.logger.Error("controlled error", "code", "FIXTURE_ERROR")
	return "FIXTURE_ERROR"
}
func (e *Engine) Start() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cancel != nil {
		return "BUSY"
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "ENGINE_INIT_FAILED"
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	e.state = snapshot{ID: hex.EncodeToString(id[:]), State: "running"}
	e.logger.Info("fixture started", "scanId", e.state.ID)
	go e.run(ctx, time.Now())
	return "OK"
}
func (e *Engine) Cancel() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cancel != nil {
		e.cancel()
	}
}
func (e *Engine) run(ctx context.Context, started time.Time) {
	fixtures := []struct {
		vendor, product string
		list, discount  int64
		stock           int
	}{
		{"store-a", "rice", 1000, 200, 2}, {"store-b", "rice", 1200, 300, 1}, {"store-a", "milk", 600, 100, 0},
	}
	offers := make([]offer, 0, len(fixtures))
	for _, row := range fixtures {
		select {
		case <-ctx.Done():
			e.finish(ctx, started, nil)
			return
		case <-time.After(400 * time.Millisecond):
		}
		if row.stock > 0 && row.discount > 0 && row.discount <= row.list {
			offers = append(offers, offer{Key: row.vendor + ":" + row.product, Price: row.list - row.discount})
		}
		e.mu.Lock()
		e.state.Progress++
		e.mu.Unlock()
	}
	e.finish(ctx, started, offers)
}
func (e *Engine) finish(ctx context.Context, started time.Time, offers []offer) {
	e.mu.Lock()
	defer e.mu.Unlock()
	defer func() { e.cancel(); e.cancel = nil }()
	e.state.Duration = time.Since(started).Milliseconds()
	e.state.State = "complete"
	if ctx.Err() != nil {
		e.state.State = "cancelled"
	} else {
		e.state.Offers = offers
	}
	e.logger.Info("fixture finished", "scanId", e.state.ID, "state", e.state.State, "durationMs", e.state.Duration, "requestCount", 0)
}
