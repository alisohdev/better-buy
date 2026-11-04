const apiBase =
  process.env.NEXT_PUBLIC_API_BASE ||
  (process.env.NODE_ENV === "development" ? "http://127.0.0.1:8787" : "");
export type RequestFailureKind =
  "http" | "transport" | "invalid-response" | "cancelled";
export class RequestFailure extends Error {
  constructor(
    readonly kind: RequestFailureKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "RequestFailure";
  }
}
export function retryAfterMs(
  value: string | null,
  now = Date.now()
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
const cancelled = () => new RequestFailure("cancelled", "درخواست لغو شد.");
const isAbort = (error: unknown, signal?: AbortSignal | null) =>
  signal?.aborted || (error instanceof Error && error.name === "AbortError");
const invalid = () =>
  new RequestFailure(
    "invalid-response",
    "پاسخ سرویس معتبر نبود؛ دریافت دوباره را امتحان کنید."
  );
type Decoder<T> = (data: unknown) => T;
// Fetch makes one attempt. Only idempotent Query reads apply retry policy.
export async function api<T>(
  url: string,
  init?: RequestInit,
  decode?: Decoder<T>
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  let response: Response;
  try {
    if (init?.signal?.aborted) throw cancelled();
    response = await fetch(`${apiBase}${url}`, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch (error) {
    if (
      isAbort(error, init?.signal) ||
      (error instanceof RequestFailure && error.kind === "cancelled")
    )
      throw cancelled();
    throw new RequestFailure(
      "transport",
      "ارتباط با سرویس برقرار نشد؛ دریافت دوباره را امتحان کنید."
    );
  }
  let body: unknown;
  try {
    body = response.status === 204 ? undefined : await response.json();
    if (init?.signal?.aborted) throw cancelled();
  } catch (error) {
    if (
      isAbort(error, init?.signal) ||
      (error instanceof RequestFailure && error.kind === "cancelled")
    )
      throw cancelled();
    if (response.ok) {
      if (error instanceof SyntaxError) throw invalid();
      throw new RequestFailure(
        "transport",
        "دریافت پاسخ کامل نشد؛ دریافت دوباره را امتحان کنید."
      );
    }
  }
  if (!response.ok) {
    const fields = body && typeof body === "object" ? body : {};
    const code =
      "error" in fields && typeof fields.error === "string"
        ? fields.error
        : undefined;
    const message =
      "message" in fields &&
      typeof fields.message === "string" &&
      /[\u0600-\u06ff]/.test(fields.message)
        ? fields.message
        : response.status === 401
          ? "برای ادامه دوباره وارد حساب شوید."
          : response.status === 403
            ? "دسترسی به این اطلاعات مجاز نیست."
            : "دریافت اطلاعات ناموفق بود؛ دوباره تلاش کنید.";
    throw new RequestFailure(
      "http",
      message,
      response.status,
      code,
      retryAfterMs(response.headers.get("retry-after"))
    );
  }
  if (response.status === 204) {
    if (decode) throw invalid();
    return undefined as T;
  }
  if (!body || typeof body !== "object" || !("data" in body)) throw invalid();
  try {
    return decode ? decode(body.data) : (body.data as T);
  } catch {
    throw invalid();
  }
}
