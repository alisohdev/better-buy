"use client";
import { useQuery } from "@tanstack/react-query";
import { isWithinTehranBoundary } from "@better-buy/shared";

const cacheKey = "better-buy.location-addresses.local.v2";
let nextRequestAt = 0;
function readCache(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry) => typeof entry[1] === "string")
    );
  } catch {
    return {};
  }
}

export function useLocationAddress(
  latitude: number,
  longitude: number,
  enabled = true
) {
  const pointKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const query = useQuery({
    queryKey: ["locationAddress", "local", pointKey],
    enabled: enabled && isWithinTehranBoundary(latitude, longitude),
    initialData: () => readCache()[pointKey],
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
    queryFn: async ({ signal }) => {
      const startAt = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = startAt + 500;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, startAt - Date.now());
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      const params = new URLSearchParams({
        lat: String(latitude),
        lon: String(longitude),
        limit: "1",
        lang: "default",
      });
      const response = await fetch(
        `https://photon.komoot.io/reverse?${params}`,
        { signal, headers: { Accept: "application/json" } }
      );
      if (!response.ok) throw new Error("Address unavailable");
      const payload = await response.json();
      const properties = payload?.features?.[0]?.properties;
      const address = [
        ...new Set(
          [
            properties?.city,
            properties?.district,
            properties?.locality,
            properties?.street,
            properties?.name,
            properties?.housenumber,
          ]
            .filter(
              (part): part is string =>
                typeof part === "string" && !!part.trim()
            )
            .map((part) => part.trim())
        ),
      ].join("، ");
      if (!address) throw new Error("Address unavailable");
      try {
        const cache = readCache();
        delete cache[pointKey];
        localStorage.setItem(
          cacheKey,
          JSON.stringify(
            Object.fromEntries(
              [...Object.entries(cache), [pointKey, address]].slice(-100)
            )
          )
        );
      } catch {
        /* Address lookup remains usable when storage is blocked. */
      }
      return address;
    },
  });
  return {
    address: query.data,
    loading:
      enabled && isWithinTehranBoundary(latitude, longitude) && query.isPending,
  };
}

export function LocationAddress({
  latitude,
  longitude,
}: {
  latitude: number;
  longitude: number;
}) {
  const { address, loading } = useLocationAddress(latitude, longitude);
  return (
    <small className="location-address-text">
      {address || (loading ? "در حال دریافت نشانی…" : "نشانی در دسترس نیست")}
    </small>
  );
}
