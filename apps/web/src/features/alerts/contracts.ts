export type WishlistItem = {
  id: string;
  phrase: string;
  minDiscount: number;
  createdAt: string;
};
export type Wishlist = {
  items: WishlistItem[];
  defaultLocationId: string | null;
  pushPublicKey: string | null;
  scheduleEnabled?: boolean;
  devScanEnabled?: boolean;
};
export type InboxNotification = {
  id: string;
  title: string;
  body: string;
  matches: {
    phrase: string;
    title: string;
    price: number;
    discountPercent: number;
    url: string;
    source: string;
    productKey?: string;
    vendorTitle?: string;
  }[];
  createdAt: string;
  readAt: string | null;
  scanId: string;
  locationId: string;
};
export type DevScanNotification = Pick<
  InboxNotification,
  "id" | "title" | "body" | "matches"
>;
export type DevScanResult =
  | { status: "queued" | "running" | "processing" }
  | {
      status: "failed" | "cancelled";
      errorCode: string | null;
      errorMessage: string | null;
    }
  | {
      status: "succeeded";
      notification: DevScanNotification | null;
      push: string;
    };
export type DevWishlistRun = {
  version: 1;
  id: string;
  userId: string;
  steps: {
    source: "snappmarket" | "okala";
    key: string;
    scanId: string | null;
    result: DevScanResult | null;
  }[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid record");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid text");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid number");
  return value;
}
function discount(value: unknown): number {
  const percent = number(value);
  if (!Number.isInteger(percent) || percent < 15 || percent > 80)
    throw new Error("Invalid minimum discount");
  return percent;
}
function list<Value>(value: unknown, parse: (item: unknown) => Value): Value[] {
  if (!Array.isArray(value)) throw new Error("Invalid list");
  return value.map(parse);
}
function parseMatch(value: unknown): InboxNotification["matches"][number] {
  const match = record(value);
  return {
    phrase: text(match.phrase),
    title: text(match.title),
    price: number(match.price),
    discountPercent: number(match.discountPercent),
    url: text(match.url),
    source: text(match.source),
    productKey:
      match.productKey === undefined ? undefined : text(match.productKey),
    vendorTitle:
      match.vendorTitle === undefined ? undefined : text(match.vendorTitle),
  };
}
export function parseDevScanStart(value: unknown) {
  return { scanId: text(record(value).scanId) };
}
export function parseDevScanResult(value: unknown): DevScanResult {
  const data = record(value);
  const status = data.status;
  if (status === "queued" || status === "running" || status === "processing")
    return { status };
  if (status === "failed" || status === "cancelled")
    return {
      status,
      errorCode: nullableText(data.errorCode ?? null),
      errorMessage: nullableText(data.errorMessage ?? null),
    };
  if (status !== "succeeded") throw new Error("Invalid scan status");
  const notification =
    data.notification === null ? null : record(data.notification);
  return {
    status,
    push: text(data.push),
    notification: notification
      ? {
          id: text(notification.id),
          title: text(notification.title),
          body: text(notification.body),
          matches: list(notification.matches, parseMatch),
        }
      : null,
  };
}
export function parseDevWishlistRun(
  value: unknown,
  userId: string
): DevWishlistRun {
  const run = record(value);
  if (run.version !== 1 || run.userId !== userId)
    throw new Error("Invalid scan owner");
  const steps = list(run.steps, (value): DevWishlistRun["steps"][number] => {
    const step = record(value);
    if (step.source !== "snappmarket" && step.source !== "okala")
      throw new Error("Invalid source");
    const scanId = nullableText(step.scanId);
    const result =
      step.result === null ? null : parseDevScanResult(step.result);
    if (result && !scanId && result.status !== "failed")
      throw new Error("Invalid scan state");
    return { source: step.source, key: text(step.key), scanId, result };
  });
  if (
    steps.length !== 2 ||
    steps[0]?.source !== "snappmarket" ||
    steps[1]?.source !== "okala"
  )
    throw new Error("Invalid scan order");
  return { version: 1, id: text(run.id), userId, steps };
}
export function parseWishlist(value: unknown): Wishlist {
  const data = record(value);
  return {
    items: list(data.items, (value) => {
      const item = record(value);
      return {
        id: text(item.id),
        phrase: text(item.phrase),
        minDiscount: discount(item.minDiscount),
        createdAt: text(item.createdAt),
      };
    }),
    defaultLocationId: nullableText(data.defaultLocationId),
    pushPublicKey: nullableText(data.pushPublicKey),
    ...(typeof data.scheduleEnabled === "boolean"
      ? { scheduleEnabled: data.scheduleEnabled }
      : {}),
    ...(typeof data.devScanEnabled === "boolean"
      ? { devScanEnabled: data.devScanEnabled }
      : {}),
  };
}
export function parseNotifications(value: unknown): InboxNotification[] {
  return list(value, (value) => {
    const item = record(value);
    return {
      id: text(item.id),
      title: text(item.title),
      body: text(item.body),
      createdAt: text(item.createdAt),
      readAt: nullableText(item.readAt),
      scanId: text(item.scanId),
      locationId: text(item.locationId),
      matches: list(item.matches, parseMatch),
    };
  });
}
export function safeOfferUrl(value: string): string | undefined {
  try {
    const base = "https://better-buy.invalid";
    const url = new URL(value, base);
    if (value.startsWith("/"))
      return url.origin === base
        ? url.pathname + url.search + url.hash
        : undefined;
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
