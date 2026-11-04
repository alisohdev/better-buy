import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  isWithinTehranBoundary,
  locationSearchReadSchema,
} from "@better-buy/shared";

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REQUEST_INTERVAL_MS = 1000;
let nextNominatimRequestAt = 0;

async function waitForNominatimRequestSlot(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const now = Date.now();
  const startAt = Math.max(now, nextNominatimRequestAt);
  nextNominatimRequestAt = startAt + NOMINATIM_REQUEST_INTERVAL_MS;
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

async function searchNominatimAddress(text: string, signal: AbortSignal) {
  await waitForNominatimRequestSlot(signal);
  const params = new URLSearchParams({
    q: text,
    format: "jsonv2",
    limit: "5",
    countrycodes: "ir",
    bounded: "1",
    viewbox: "51.18,35.82,51.66,35.56",
    "accept-language": "fa",
    addressdetails: "0",
  });
  let response: Response;
  try {
    response = await fetch(`${NOMINATIM_SEARCH_URL}?${params}`, {
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
  if (!Array.isArray(payload)) {
    throw new Error(
      "جست‌وجوی نشانی موقتاً در دسترس نیست؛ موقعیت را روی نقشه انتخاب کنید."
    );
  }

  const results = payload.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    const latitude = Number(row.lat);
    const longitude = Number(row.lon);
    const displayName =
      typeof row.display_name === "string" ? row.display_name.trim() : "";
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
  const [validationError, setValidationError] = useState("");
  const query = useQuery({
    queryKey: ["locationSearch", submitted],
    enabled: !!submitted,
    staleTime: 10 * 60 * 1000,
    retry: false,
    queryFn: ({ signal }) => searchNominatimAddress(submitted ?? "", signal),
  });
  const setSearchQuery = (text: string) => {
    updateQuery(text);
    setSubmitted(null);
    setValidationError("");
  };
  const searchAddress = () => {
    const text = searchQuery.trim();
    if (text.length < 2) {
      setSubmitted(null);
      setValidationError("برای جست‌وجو حداقل دو نویسه وارد کنید.");
      return;
    }
    setValidationError("");
    setSubmitted(text);
  };
  const searchError =
    validationError || (submitted ? query.error?.message : "") || "";
  const searchResults = submitted ? (query.data ?? []) : [];
  const searchState = searchError
    ? "error"
    : !submitted
      ? "idle"
      : query.isFetching
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
    searchAddress,
  };
}
