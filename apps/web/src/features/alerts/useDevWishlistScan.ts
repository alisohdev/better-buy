import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "../../app/auth-client";
import { api, RequestFailure } from "../../lib/api";
import {
  parseDevScanResult,
  parseDevScanStart,
  parseDevWishlistRun,
  type DevWishlistRun,
} from "./contracts";

const complete = (step: DevWishlistRun["steps"][number]) =>
  step.result?.status === "succeeded" ||
  step.result?.status === "failed" ||
  step.result?.status === "cancelled";
export const devWishlistRunning = (run: DevWishlistRun | null) =>
  !!run && run.steps.some((step) => !complete(step));
const storageKey = (userId: string) => `better-buy:dev-wishlist:${userId}`;
function save(run: DevWishlistRun) {
  try {
    sessionStorage.setItem(storageKey(run.userId), JSON.stringify(run));
  } catch {
    /* Monitoring still works when storage is unavailable. */
  }
}
function load(userId: string): DevWishlistRun | null {
  try {
    const value = sessionStorage.getItem(storageKey(userId));
    return value ? parseDevWishlistRun(JSON.parse(value), userId) : null;
  } catch {
    return null;
  }
}
function pause(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function useDevWishlistScan(enabled: boolean) {
  const { data: session } = authClient.useSession();
  const userId = session?.user.id;
  const client = useQueryClient();
  const current = useRef<DevWishlistRun | null>(null);
  const [run, setRun] = useState<DevWishlistRun | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !userId) {
      current.current = null;
      setRun(null);
      return;
    }
    let value =
      current.current?.userId === userId ? current.current : load(userId);
    current.current = value;
    setRun(value);
    setError("");
    if (!value || !devWishlistRunning(value)) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const publish = (next: DevWishlistRun) => {
      if (signal.aborted) return;
      value = next;
      current.current = next;
      save(next);
      setRun(next);
    };
    const request = <T>(
      path: string,
      body: unknown,
      decode: (data: unknown) => T
    ) =>
      api(
        path,
        {
          method: "POST",
          signal,
          headers: { "X-Better-Buy-Dev": "wishlist-ui" },
          body: JSON.stringify(body),
        },
        decode
      );
    void (async () => {
      if (!value) return;
      for (let i = 0; i < value.steps.length; i++) {
        let step = value.steps[i]!;
        if (complete(step)) continue;
        try {
          if (!step.scanId) {
            const started = await request(
              "/api/wishlist/dev-scan/start",
              { source: step.source, key: step.key },
              parseDevScanStart
            );
            if (signal.aborted) return;
            step = {
              ...step,
              scanId: started.scanId,
              result: { status: "queued" },
            };
            publish({
              ...value,
              steps: value.steps.map((entry, index) =>
                index === i ? step : entry
              ),
            });
          }
          while (!signal.aborted && !complete(step)) {
            const result = await request(
              "/api/wishlist/dev-scan/status",
              { scanId: step.scanId },
              parseDevScanResult
            );
            if (signal.aborted) return;
            step = { ...step, result };
            publish({
              ...value,
              steps: value.steps.map((entry, index) =>
                index === i ? step : entry
              ),
            });
            if (!complete(step)) await pause(signal);
          }
        } catch (failure) {
          if (signal.aborted) return;
          if (
            failure instanceof RequestFailure &&
            failure.kind === "http" &&
            failure.status &&
            failure.status < 500 &&
            failure.status !== 429
          ) {
            step = {
              ...step,
              result: {
                status: "failed",
                errorCode: failure.code ?? null,
                errorMessage: failure.message,
              },
            };
            publish({
              ...value,
              steps: value.steps.map((entry, index) =>
                index === i ? step : entry
              ),
            });
          } else {
            setError(
              failure instanceof Error
                ? failure.message
                : "دریافت وضعیت اسکن انجام نشد."
            );
            return;
          }
        }
        if (signal.aborted) return;
        await Promise.all(
          ["scans", "notifications", "ledger"].map((key) =>
            client.invalidateQueries({ queryKey: [key] })
          )
        );
      }
    })();
    return () => controller.abort();
  }, [enabled, userId, attempt, client]);

  const start = () => {
    if (!enabled || !userId || devWishlistRunning(current.current)) return;
    const next: DevWishlistRun = {
      version: 1,
      id: crypto.randomUUID(),
      userId,
      steps: ["snappmarket", "okala"].map((source) => ({
        source: source === "snappmarket" ? "snappmarket" : "okala",
        key: crypto.randomUUID(),
        scanId: null,
        result: null,
      })),
    };
    current.current = next;
    save(next);
    setRun(next);
    setAttempt((value) => value + 1);
  };
  return {
    run,
    error,
    running: devWishlistRunning(run),
    ready: !!userId,
    start,
    resume: () => setAttempt((value) => value + 1),
  };
}
