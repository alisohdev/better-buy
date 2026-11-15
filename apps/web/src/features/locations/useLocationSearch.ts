import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  isWithinTehranBoundary,
  locationSearchReadSchema,
} from "@better-buy/shared";

const PHOTON_SEARCH_URL = "https://photon.komoot.io/api/";
const REQUEST_INTERVAL_MS = 500;
let nextRequestAt = 0;

async function waitForRequestSlot(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + REQUEST_INTERVAL_MS;
  const delay = startAt - now;
  if (delay <= 0) return;

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function searchAddress(text: string, signal: AbortSignal) {
  await waitForRequestSlot(signal);
  const params = new URLSearchParams({
    q: text,
    limit: "5",
    lang: "default",
    bbox: "51.18,35.56,51.66,35.82",
    lat: "35.7",
    lon: "51.4",
  });
  let response: Response;
  try {
    response = await fetch(`${PHOTON_SEARCH_URL}?${params}`, {
      signal,
      headers: { Accept: "application/json" },
      referrerPolicy: "strict-origin-when-cross-origin",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "جست‌وجوی نشانی موقتاً در دسترس نیست؛ موقعیت را روی نقشه انتخاب کنید."
    );
  }
  if (!response.ok) {
    throw new Error(
      "جست‌وجوی نشانی موقتاً در دسترس نیست؛ موقعیت را روی نقشه انتخاب کنید."
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "جست‌وجوی نشانی موقتاً در دسترس نیست؛ موقعیت را روی نقشه انتخاب کنید."
    );
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("features" in payload) ||
    !Array.isArray(payload.features)
  ) {
    throw new Error(
      "جست‌وجوی نشانی موقتاً در دسترس نیست؛ موقعیت را روی نقشه انتخاب کنید."
    );
  }

  const results = payload.features.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const geometry = row.geometry as { coordinates?: unknown[] } | undefined;
    const properties = row.properties as Record<string, unknown> | undefined;
    const latitude = Number(geometry?.coordinates?.[1]);
    const longitude = Number(geometry?.coordinates?.[0]);
    const displayName = [
      ...new Set(
        [
          properties?.name,
          properties?.street,
          properties?.district,
          properties?.city,
          properties?.state,
        ].filter(
          (part): part is string => typeof part === "string" && !!part.trim()
        )
      ),
    ].join("، ");
    if (
      !displayName ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      !isWithinTehranBoundary(latitude, longitude)
    ) {
      return [];
    }
    return [{ latitude, longitude, displayName }];
  });
  return locationSearchReadSchema.parse(results);
}

export function useLocationSearch() {
  const [searchQuery, updateQuery] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const text = searchQuery.trim();
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSubmitted(text.length >= 3 ? text : null),
      500
    );
    return () => window.clearTimeout(timer);
  }, [text]);
  const query = useQuery({
    queryKey: ["locationSearch", text],
    enabled: text.length >= 3 && submitted === text,
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: ({ signal }) => searchAddress(text, signal),
  });
  const setSearchQuery = (text: string) => {
    updateQuery(text);
  };
  const searchError = (submitted === text ? query.error?.message : "") || "";
  const searchResults = submitted === text ? (query.data ?? []) : [];
  const searchState = searchError
    ? "error"
    : text.length < 3
      ? "idle"
      : submitted !== text || query.isFetching
        ? "loading"
        : searchResults.length
          ? "results"
          : "empty";
  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    searchState,
    searchError,
  };
}
