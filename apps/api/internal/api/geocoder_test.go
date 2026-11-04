package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type geocoderTransport func(*http.Request) (*http.Response, error)

func (transport geocoderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestPhotonKeepsOnlyNamedTehranPoints(t *testing.T) {
	previous := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previous })
	http.DefaultTransport = geocoderTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.Query().Get("q") != "ونک" || request.URL.Query().Get("bbox") != "51.18,35.56,51.66,35.82" {
			t.Fatal("search must preserve query and Tehran boundary")
		}
		body := `{"features":[{"geometry":{"coordinates":[51.4,35.7]},"properties":{"name":"ونک","city":"تهران"}},{"geometry":{"coordinates":[0,0]},"properties":{"name":"outside"}},{"geometry":{"coordinates":[51.4]},"properties":{"name":"invalid"}}]}`
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	results, status, err := searchPhoton(context.Background(), "ونک")
	if err != nil || status != http.StatusOK || len(results) != 1 || results[0].Latitude != 35.7 || results[0].DisplayName != "ونک، تهران" {
		t.Fatalf("unexpected geocoding result %#v, status %d, error %v", results, status, err)
	}
}
