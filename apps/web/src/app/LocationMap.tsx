"use client";

import { useEffect, useRef, useState } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type MapMouseEvent,
} from "maplibre-gl";
import { isWithinTehranBoundary, TEHRAN_BOUNDARY } from "@better-buy/shared";

const TEHRAN_CENTER = { lat: 35.7, lng: 51.4 };
const TEHRAN_BOUNDS: [[number, number], [number, number]] = [
  [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.minLatitude],
  [TEHRAN_BOUNDARY.maxLongitude, TEHRAN_BOUNDARY.maxLatitude],
];
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const DEFAULT_ZOOM = 13;
const SELECTED_POINT_ZOOM = 14;

setWorkerUrl(
  new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).toString()
);

type LocationPoint = Readonly<{ lat: number; lng: number }>;

export default function LocationMap({
  latitude,
  longitude,
  onChange,
}: {
  latitude: number;
  longitude: number;
  onChange: (point: LocationPoint) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const hasValidPoint = isWithinTehranBoundary(latitude, longitude);
  const point = hasValidPoint
    ? { lat: latitude, lng: longitude }
    : TEHRAN_CENTER;
  const pointRef = useRef<LocationPoint>(point);
  const initialZoomRef = useRef(
    hasValidPoint ? SELECTED_POINT_ZOOM : DEFAULT_ZOOM
  );
  const callbacksRef = useRef({ onChange, onOutsidePick: () => {} });
  const [outsideNotice, setOutsideNotice] = useState(false);
  const [basemapUnavailable, setBasemapUnavailable] = useState(false);

  useEffect(() => {
    callbacksRef.current = {
      onChange,
      onOutsidePick: () => setOutsideNotice(true),
    };
  }, [onChange]);

  useEffect(() => {
    pointRef.current = point;
    markerRef.current?.setLngLat([point.lng, point.lat]);

    if (hasValidPoint && mapRef.current) {
      mapRef.current.jumpTo({
        center: [point.lng, point.lat],
        zoom: Math.max(mapRef.current.getZoom(), SELECTED_POINT_ZOOM),
      });
    }
  }, [latitude, longitude, hasValidPoint, point.lat, point.lng]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let map: MapLibreMap;
    try {
      const themeColor =
        getComputedStyle(container).getPropertyValue("--primary").trim() ||
        "#9a3412";
      map = new MapLibreMap({
        container,
        style: OPENFREEMAP_STYLE,
        center: [pointRef.current.lng, pointRef.current.lat],
        zoom: initialZoomRef.current,
        minZoom: 10,
        maxZoom: 17,
        maxBounds: TEHRAN_BOUNDS,
        dragRotate: false,
        touchPitch: false,
        pitchWithRotate: false,
        attributionControl: { compact: true },
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), "top-left");

      const marker = new Marker({
        anchor: "bottom",
        color: themeColor,
        draggable: true,
      })
        .setLngLat([pointRef.current.lng, pointRef.current.lat])
        .addTo(map);
      marker
        .getElement()
        .setAttribute("aria-label", "موقعیت انتخاب‌شده؛ برای جابه‌جایی بکشید");
      marker.getElement().setAttribute("title", "موقعیت انتخاب‌شده");
      markerRef.current = marker;

      const handlePick = (picked: LocationPoint) => {
        if (!isWithinTehranBoundary(picked.lat, picked.lng)) {
          setOutsideNotice(true);
          return;
        }
        setOutsideNotice(false);
        callbacksRef.current.onChange(picked);
      };
      const handleMapClick = (event: MapMouseEvent) => {
        handlePick({ lat: event.lngLat.lat, lng: event.lngLat.lng });
      };
      const handleMarkerDragEnd = () => {
        const picked = marker.getLngLat();
        const next = { lat: picked.lat, lng: picked.lng };
        if (!isWithinTehranBoundary(next.lat, next.lng)) {
          marker.setLngLat([pointRef.current.lng, pointRef.current.lat]);
          callbacksRef.current.onOutsidePick();
          return;
        }
        handlePick(next);
      };
      const handleMapError = () => setBasemapUnavailable(true);
      const handleMapLoad = () => {
        map.addSource("tehran-boundary", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: {
              type: "LineString",
              coordinates: [
                [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.minLatitude],
                [TEHRAN_BOUNDARY.maxLongitude, TEHRAN_BOUNDARY.minLatitude],
                [TEHRAN_BOUNDARY.maxLongitude, TEHRAN_BOUNDARY.maxLatitude],
                [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.maxLatitude],
                [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.minLatitude],
              ],
            },
          },
        });
        map.addLayer({
          id: "tehran-boundary",
          type: "line",
          source: "tehran-boundary",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": themeColor,
            "line-width": 2,
            "line-dasharray": [2, 2],
          },
        });
        setBasemapUnavailable(false);
      };

      map.on("click", handleMapClick);
      map.on("error", handleMapError);
      map.once("load", handleMapLoad);
      marker.on("dragend", handleMarkerDragEnd);

      return () => {
        map.off("click", handleMapClick);
        map.off("error", handleMapError);
        map.off("load", handleMapLoad);
        marker.off("dragend", handleMarkerDragEnd);
        marker.remove();
        map.remove();
        mapRef.current = null;
        markerRef.current = null;
      };
    } catch {
      markerRef.current?.remove();
      mapRef.current?.remove();
      markerRef.current = null;
      mapRef.current = null;
      setBasemapUnavailable(true);
      return;
    }
  }, []);

  const showOutsideNotice = !hasValidPoint || outsideNotice;
  const status = showOutsideNotice
    ? "این محدوده خارج از شهر تهران است؛ یک نقطه داخل کادر انتخاب کنید."
    : basemapUnavailable
      ? "نمایش نقشه موقتاً در دسترس نیست؛ اتصال را بررسی و دوباره تلاش کنید."
      : "نقطه را بکشید یا روی نقشه کلیک کنید. محدوده پشتیبانی فعلاً تهران است.";

  return (
    <div
      className="location-map"
      role="region"
      aria-label="نقشه انتخاب موقعیت در تهران"
    >
      <div ref={containerRef} className="maplibre-map" />
      <p
        className={`location-map-status${showOutsideNotice || basemapUnavailable ? " is-warning" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span aria-hidden="true" />
        {status}
      </p>
    </div>
  );
}
