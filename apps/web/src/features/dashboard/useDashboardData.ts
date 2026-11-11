import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  locationsReadSchema,
  scansReadSchema,
  type ScanRecord,
} from "@better-buy/shared";
import { recoveryInterval } from "../../lib/queryPolicy";
import { RequestFailure } from "../../lib/api";
import { api } from "../../lib/api";
export function useDashboardData() {
  const locationsQuery = useQuery({
    queryKey: ["locations"],
    queryFn: ({ signal }) =>
      api("/api/locations", { signal }, locationsReadSchema.parse),
  });
  const scansQuery = useQuery<ScanRecord[]>({
    queryKey: ["scans"],
    refetchInterval: (query) => {
      const error = query.state.error;
      if (!error) return false;
      if (error instanceof RequestFailure && error.status === 429)
        return Math.max(15_000, error.retryAfterMs ?? 0);
      return recoveryInterval(error);
    },
    refetchOnWindowFocus: (query) => !!query.state.error,
    queryFn: ({ signal }) =>
      api("/api/scans", { signal }, scansReadSchema.parse),
  });
  const [selection, setSelected] = useState("");
  const locations = locationsQuery.data ?? [];
  const selected = locations.some((l) => l.id === selection)
    ? selection
    : (locations.find((l) => l.isDefault)?.id ?? locations[0]?.id ?? "");
  const load = useCallback(async () => {
    await Promise.all([locationsQuery.refetch(), scansQuery.refetch()]);
  }, [locationsQuery.refetch, scansQuery.refetch]);
  return {
    locations,
    selected,
    setSelected,
    scans: scansQuery.data ?? [],
    busy: locationsQuery.isPending || scansQuery.isPending,
    locationsQuery,
    scansQuery,
    needsLocation: locationsQuery.isSuccess && locations.length === 0,
    load,
  };
}
