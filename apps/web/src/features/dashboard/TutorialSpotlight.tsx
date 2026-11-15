"use client";
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TutorialStep } from "./tutorialState";

const scopes: Record<TutorialStep, string> = {
  location: '[data-tutorial-target="true"]',
  map: ".location-map-workspace, .location-flow-footer, .location-search-feedback, .form-error",
  details: ".location-editor",
  scan: ".scan-controls",
  waiting: ".scan-stage-running, .scan-feedback-list",
  results: ".scan-stage-complete",
  search: ".results-toolbar",
  product: ".results-toolbar, .deal-list, .result-error, .empty",
  done: ".product-detail-dialog",
};
type Rect = { left: number; top: number; right: number; bottom: number };
const pathRect = (r: Rect) =>
  `M${r.left},${r.top}H${r.right}V${r.bottom}H${r.left}Z`;

// Cut the guide and working controls out of a viewport-sized blur layer.
// Coordinates avoid lifting controls out of their modal or stacking context.
export function TutorialSpotlight({ step }: { step: TutorialStep | null }) {
  const [path, setPath] = useState("");
  useLayoutEffect(() => {
    if (!step) {
      setPath("");
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const visible = (element: HTMLElement) =>
        element.getClientRects().length > 0 &&
        !element.closest('[aria-hidden="true"], [inert]');
      const hints = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-tutorial-step="${step}"]`)
      ).filter(visible);
      if (!hints.length) {
        setPath("");
        return;
      }
      const dialog = hints[0]?.closest('[role="dialog"]');
      const root = dialog ?? document;
      const elements = [
        ...hints,
        ...Array.from(root.querySelectorAll<HTMLElement>(scopes[step])).filter(
          visible
        ),
      ];
      const width = window.innerWidth;
      const height = window.innerHeight;
      const holes: Rect[] = [];
      for (const element of elements) {
        const box = element.getBoundingClientRect();
        let rect = {
          left: Math.max(0, box.left - 8),
          top: Math.max(0, box.top - 8),
          right: Math.min(width, box.right + 8),
          bottom: Math.min(height, box.bottom + 8),
        };
        if (rect.right <= rect.left || rect.bottom <= rect.top) continue;
        // Merge intersecting holes so even-odd clipping never blurs their overlap.
        for (let i = 0; i < holes.length;) {
          const other = holes[i]!;
          if (
            rect.left <= other.right &&
            rect.right >= other.left &&
            rect.top <= other.bottom &&
            rect.bottom >= other.top
          ) {
            rect = {
              left: Math.min(rect.left, other.left),
              top: Math.min(rect.top, other.top),
              right: Math.max(rect.right, other.right),
              bottom: Math.max(rect.bottom, other.bottom),
            };
            holes.splice(i, 1);
            i = 0;
          } else i++;
        }
        holes.push(rect);
      }
      setPath(
        pathRect({ left: 0, top: 0, right: width, bottom: height }) +
          holes.map(pathRect).join("")
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [step]);
  if (!step || !path) return null;
  return createPortal(
    <div
      className="tutorial-spotlight"
      aria-hidden="true"
      style={{ clipPath: `path(evenodd, "${path}")` }}
    />,
    document.body
  );
}
