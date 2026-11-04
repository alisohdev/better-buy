package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func searchPhoton(ctx context.Context, query string) ([]geocoderResult, int, error) {
	params := url.Values{"q": {query}, "limit": {"5"}, "bbox": {"51.18,35.56,51.66,35.82"}, "lat": {"35.7"}, "lon": {"51.4"}}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://photon.komoot.io/api/?"+params.Encode(), nil)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "better-buy-location-search/1.0")
	response, err := (&http.Client{Timeout: 8 * time.Second}).Do(request)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, http.StatusBadGateway, fmt.Errorf("geocoder status %d", response.StatusCode)
	}
	var payload struct {
		Features []struct {
			Geometry struct {
				Coordinates []float64 `json:"coordinates"`
			} `json:"geometry"`
			Properties struct {
				Name   string `json:"name"`
				Street string `json:"street"`
				City   string `json:"city"`
			} `json:"properties"`
		} `json:"features"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&payload); err != nil {
		return nil, http.StatusBadGateway, err
	}
	results := make([]geocoderResult, 0, len(payload.Features))
	for _, feature := range payload.Features {
		point := feature.Geometry.Coordinates
		if len(point) != 2 || !withinTehran(point[1], point[0]) {
			continue
		}
		parts := []string{}
		for _, part := range []string{feature.Properties.Name, feature.Properties.Street, feature.Properties.City} {
			if part != "" {
				parts = append(parts, part)
			}
		}
		if len(parts) > 0 {
			results = append(results, geocoderResult{Latitude: point[1], Longitude: point[0], DisplayName: strings.Join(parts, "، ")})
		}
	}
	return results, http.StatusOK, nil
}
