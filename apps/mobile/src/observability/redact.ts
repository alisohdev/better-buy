const FORBIDDEN_JSON_KEY =
  /"(?:lat|latitude|lng|lon|longitude|coordinates|phone|mobile|tel|token|authorization|cookie|cookies|password|secret|deviceId|androidId|advertisingId|idfa|history|raw|responseBody|set-cookie)"\s*:/i;

export function scrubMessage(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact || FORBIDDEN_JSON_KEY.test(compact)) return "[redacted]";
  const scrubbed = compact
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .replace(
      /eyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}/g,
      "[redacted]"
    )
    .replace(/\b(?:\+98|0098)?0?9\d{9}\b/g, "[redacted]")
    .replace(/\b(cookie|token|authorization)\s*[:=]\s*\S+/gi, "$1 [redacted]");
  return scrubbed.slice(0, 180);
}

export function scanIdOrDrop(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

export function labelOrDrop(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim().toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(label) ? label : undefined;
}

export function boundedInt(value: unknown, max: number): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > max
  ) {
    return undefined;
  }
  return value;
}
