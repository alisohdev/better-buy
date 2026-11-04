import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  scansReadSchema,
  scanStartedSchema,
  type ScanRecord,
} from "@better-buy/shared";
import { api, RequestFailure } from "../../lib/api";
import { recoveryInterval } from "../../lib/queryPolicy";
import type { DealSource } from "../dashboard/types";
export type ScanSelection = {
  locationId: string;
  source: DealSource;
  threshold: number;
  mode: "partial" | "full";
};
type StartIntent = { target: ScanSelection; key: string; failedAt: number };
export function useStartScan(selection: ScanSelection) {
  const client = useQueryClient();
  const locked = useRef(false);
  const [uncertain, setUncertain] = useState<StartIntent | null>(null);
  const remember = (run: ScanRecord) => {
    client.setQueryData(["scan", run.id], run);
    client.setQueryData<ScanRecord[]>(["scans"], (previous) => [
      run,
      ...(previous ?? []).filter((item) => item.id !== run.id),
    ]);
  };
  const reconciliation = useQuery({
    queryKey: ["start-intent", uncertain?.key ?? null],
    enabled: !!uncertain,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const runs = await api(
        `/api/scans?intent=${encodeURIComponent(uncertain!.key)}`,
        { signal },
        scansReadSchema.parse
      );
      if (runs.length > 1)
        throw new RequestFailure(
          "invalid-response",
          "پاسخ بررسی شروع اسکن معتبر نیست."
        );
      if (runs[0]) remember(runs[0]);
      return runs;
    },
    refetchInterval: (query) =>
      uncertain && !query.state.data?.length
        ? query.state.error
          ? recoveryInterval(query.state.error)
          : 15_000
        : false,
  });
  const recovered = uncertain ? reconciliation.data?.[0] : undefined;
  const unresolved = !!uncertain && !recovered;
  const checked =
    !!uncertain &&
    reconciliation.isSuccess &&
    reconciliation.dataUpdatedAt >= uncertain.failedAt &&
    !reconciliation.isFetching;
  const mutation = useMutation({
    retry: false,
    mutationFn: async (intent: StartIntent) => {
      await client.cancelQueries({ queryKey: ["scans"] });
      return api(
        "/api/scans",
        {
          method: "POST",
          headers: { "Idempotency-Key": intent.key },
          body: JSON.stringify(intent.target),
        },
        scanStartedSchema.parse
      );
    },
    onSuccess: (run) => {
      remember(run);
      setUncertain(null);
    },
    onError: (error, intent) => {
      if (
        error instanceof RequestFailure &&
        error.kind === "http" &&
        error.status === 409
      )
        void client.invalidateQueries({ queryKey: ["scans"] });
      if (
        error instanceof RequestFailure &&
        (error.kind !== "http" || (error.status ?? 0) >= 500)
      ) {
        setUncertain({ ...intent, failedAt: Date.now() });
        void client.invalidateQueries({
          queryKey: ["start-intent", intent.key],
        });
      }
    },
    onSettled: () => {
      locked.current = false;
    },
  });
  const start = (overrides?: Partial<ScanSelection>) => {
    if (locked.current || mutation.isPending || unresolved) return;
    const target = { ...selection, ...overrides };
    if (!target.locationId || target.source === "digikalajet") return;
    target.threshold = 15;
    locked.current = true;
    mutation.mutate({ target, key: crypto.randomUUID(), failedAt: Date.now() });
  };
  const retryIntent = () => {
    if (!uncertain || !unresolved || locked.current || mutation.isPending)
      return;
    locked.current = true;
    mutation.mutate(uncertain);
  };
  return {
    start,
    submitting: mutation.isPending,
    unresolved,
    uncertain,
    recovered,
    reconciliation,
    checked,
    error: unresolved || recovered ? null : mutation.error,
    retryIntent,
    reset: () => {
      if (!unresolved) {
        mutation.reset();
        setUncertain(null);
      }
    },
  };
}
