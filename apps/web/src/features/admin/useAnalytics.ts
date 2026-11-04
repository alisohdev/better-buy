"use client";

import { useEffect, useRef } from "react";
import { api } from "../../lib/api";

export type AnalyticsSource = "snappmarket" | "okala" | "digikalajet" | "all";
const visitorKey = "better-buy-visitor-id";
const validId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let memoryVisitorId: string | undefined;

function randomId(): string | null {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
    bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

function visitorId(): string | null {
  if (memoryVisitorId) return memoryVisitorId;
  try {
    const saved = localStorage.getItem(visitorKey);
    if (saved && validId.test(saved)) {
      memoryVisitorId = saved;
      return saved;
    }
  } catch {
    // Storage can be unavailable in private browsing; keep this visit in memory.
  }
  const generated = randomId();
  if (!generated) return null;
  memoryVisitorId = generated;
  try {
    localStorage.setItem(visitorKey, memoryVisitorId);
  } catch {
    // Analytics remains optional when the browser does not permit storage.
  }
  return memoryVisitorId;
}

type Event =
  | { kind: "visit" }
  | { kind: "search"; query: string; source: AnalyticsSource };

function record(id: string, event: Event) {
  const visitor = visitorId();
  if (!visitor) return Promise.resolve();
  return api("/api/analytics/events", {
    method: "POST",
    body: JSON.stringify({ id, visitorId: visitor, ...event }),
    keepalive: true,
  }).catch(() => undefined);
}

export function useVisitAnalytics() {
  const eventId = useRef<string | null>(null);
  useEffect(() => {
    eventId.current ??= randomId();
    if (eventId.current) void record(eventId.current, { kind: "visit" });
  }, []);
}

export function useSearchAnalytics({
  query,
  source,
}: {
  query: string;
  source: AnalyticsSource;
}) {
  const previous = useRef("");
  useEffect(() => {
    const normalized = query.normalize("NFKC").trim().replace(/\s+/g, " ");
    const key = `${source}:${normalized}`;
    const length = Array.from(normalized).length;
    if (length < 2 || length > 120) {
      previous.current = "";
      return;
    }
    if (previous.current === key) return;
    const timer = window.setTimeout(() => {
      previous.current = key;
      const id = randomId();
      if (id)
        void record(id, {
          kind: "search",
          query: normalized,
          source,
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [query, source]);
}
