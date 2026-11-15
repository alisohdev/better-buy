"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { createLocationMapStyle } from "../features/locations/mapStyle";
import "../features/locations/location-map.css";
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
  centerOnMove = false,
}: {
  latitude: number;
  longitude: number;
  onChange: (point: LocationPoint) => void;
  centerOnMove?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const themeRef = useRef(dark);
  themeRef.current = dark;
  const appliedTheme = useRef(dark);
  const centerOnMoveRef = useRef(centerOnMove);
  centerOnMoveRef.current = centerOnMove;
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
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedTheme.current === dark) return;
    appliedTheme.current = dark;
    setMapReady(false);
    setBasemapUnavailable(false);
    map.setStyle(createLocationMapStyle(dark), { diff: true });
  }, [dark]);

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
      map = new MapLibreMap({
        container,
        style: createLocationMapStyle(themeRef.current),
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        renderWorldCopies: false,
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
      appliedTheme.current = themeRef.current;
      map.addControl(new NavigationControl({ showCompass: false }), "top-left");

      const markerElement = document.createElement("div");
      markerElement.className = "location-map-marker";
      const marker = new Marker({
        element: markerElement,
        anchor: "center",
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
      const handleMoveEnd = (event: { originalEvent?: unknown }) => {
        if (!centerOnMoveRef.current || !event.originalEvent) return;
        const center = map.getCenter();
        handlePick({ lat: center.lat, lng: center.lng });
      };
      const handleMapError = () => setBasemapUnavailable(true);
      const handleMapLoad = () => setBasemapUnavailable(false);
      const handleMapIdle = () => setMapReady(true);

      map.on("click", handleMapClick);
      map.on("error", handleMapError);
      map.on("style.load", handleMapLoad);
      map.on("idle", handleMapIdle);
      map.on("moveend", handleMoveEnd);
      marker.on("dragend", handleMarkerDragEnd);

      return () => {
        map.off("click", handleMapClick);
        map.off("error", handleMapError);
        map.off("style.load", handleMapLoad);
        map.off("idle", handleMapIdle);
        map.off("moveend", handleMoveEnd);
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
      className={`location-map${centerOnMove ? " location-map-center-pin" : ""}`}
      role="region"
      data-map-theme={dark ? "dark" : "light"}
      data-map-ready={mapReady}
      aria-label="نقشه انتخاب موقعیت در تهران"
    >
      <div ref={containerRef} className="maplibre-map" />
      {centerOnMove && (
        <div className="location-fixed-pin" aria-hidden="true">
          <svg viewBox="0 0 24 32">
            <path
              d="M12 30S2 18 2 11a10 10 0 0 1 20 0c0 7-10 19-10 19Z"
              fill="var(--ring)"
              stroke="var(--card)"
              strokeWidth="2"
            />
            <circle cx="12" cy="11" r="3" fill="var(--card)" />
          </svg>
        </div>
      )}
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
