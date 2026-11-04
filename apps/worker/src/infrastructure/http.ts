import { Duration, Effect, Schedule } from "effect";
import { CollectorError } from "../domain/failures";

export type Fetcher = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

export interface RequestPolicy {
  provider: string;
  fetcher?: Fetcher;
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  allow401?: boolean;
  discardBody?: boolean;
  allowNoContent?: boolean;
  forbiddenCode?: "AUTH_REJECTED" | "UPSTREAM_FORBIDDEN";
  unauthorizedCode?: "AUTH_REJECTED" | "UPSTREAM_FORBIDDEN";
  invalidJsonCode?: "UPSTREAM_CHANGED" | "UPSTREAM_INVALID_JSON";
  onPhysicalAttempt?: () => void | Promise<void>;
}

// Reject malformed, negative or excessive guidance instead of silently retrying early.
export function retryAfterMs(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : undefined;
  const delay =
    seconds === undefined ? Date.parse(value) - now : seconds * 1000;
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

export function requestJson(
  url: string | URL,
  init: RequestInit,
  policy: RequestPolicy
) {
  return Effect.suspend(() => {
    const read = !init.method || init.method === "GET";
    const attempts = read ? (policy.attempts ?? 3) : 1;
    const attempt = Effect.acquireUseRelease(
      Effect.sync(() => new AbortController()),
      (controller) =>
        Effect.gen(function* () {
          const response = yield* Effect.tryPromise({
            try: async (signal) => {
              await policy.onPhysicalAttempt?.();
              return (policy.fetcher ?? fetch)(url, {
                ...init,
                signal: AbortSignal.any([controller.signal, signal]),
              });
            },
            catch: () =>
              new CollectorError(
                "NETWORK_ERROR",
                "ارتباط با " + policy.provider + " برقرار نشد",
                true
              ),
          });
          if (response.status === 401 && policy.allow401)
            return { status: 401, body: null };
          if (response.status === 401 || response.status === 403)
            return yield* Effect.fail(
              new CollectorError(
                response.status === 403
                  ? (policy.forbiddenCode ?? "AUTH_REJECTED")
                  : (policy.unauthorizedCode ?? "AUTH_REJECTED"),
                "دسترسی به " + policy.provider + " پذیرفته نشد"
              )
            );
          if (response.status === 429)
            return yield* Effect.fail(
              new CollectorError(
                "RATE_LIMITED",
                policy.provider + " درخواست‌ها را موقتاً محدود کرده است",
                true,
                retryAfterMs(response.headers.get("retry-after"))
              )
            );
          if (!response.ok)
            return yield* Effect.fail(
              new CollectorError(
                "UPSTREAM_ERROR",
                "پاسخ ناموفق " + policy.provider + " (" + response.status + ")",
                response.status === 408 || response.status >= 500
              )
            );
          if (
            policy.discardBody ||
            (policy.allowNoContent && response.status === 204)
          )
            return { status: response.status, body: null };
          const body: unknown = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () =>
              new CollectorError(
                policy.invalidJsonCode ?? "UPSTREAM_CHANGED",
                "پاسخ " + policy.provider + " JSON معتبر نبود"
              ),
          });
          return { status: response.status, body };
        }),
      (controller) => Effect.sync(() => controller.abort())
    ).pipe(
      Effect.timeoutOrElse({
        duration: policy.timeoutMs ?? 8_000,
        orElse: () =>
          Effect.fail(
            new CollectorError(
              "REQUEST_TIMEOUT",
              "زمان دریافت پاسخ " + policy.provider + " به پایان رسید",
              true
            )
          ),
      })
    );
    return attempt.pipe(
      Effect.retry({
        times: Math.max(0, attempts - 1),
        while: (error) => error.retryable && (error.retryAfterMs ?? 0) <= 5_000,
        schedule: Schedule.exponential(policy.baseDelayMs ?? 1_000).pipe(
          Schedule.modifyDelay<Duration.Duration, CollectorError>(
            ({ duration, input }) =>
              Effect.succeed(
                Math.max(Duration.toMillis(duration), input.retryAfterMs ?? 0)
              )
          )
        ),
      })
    );
  });
}
