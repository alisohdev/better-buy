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
  done: ".deal-section",
};
type Rect = { left: number; top: number; right: number; bottom: number };
// Cut the guide and working controls out of a viewport-sized blur layer.
// Coordinates avoid lifting controls out of their modal or stacking context.
export function TutorialSpotlight({ step }: { step: TutorialStep | null }) {
  const [mask, setMask] = useState("");
  useLayoutEffect(() => {
    if (!step) {
      setMask("");
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
        setMask("");
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
      const cutouts = holes
        .map(
          (r) =>
            `<rect x="${r.left}" y="${r.top}" width="${r.right - r.left}" height="${r.bottom - r.top}" rx="18" fill="black" filter="url(#soft)"/>`
        )
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="7"/></filter><mask id="spot" maskUnits="userSpaceOnUse"><rect width="${width}" height="${height}" fill="white"/>${cutouts}</mask></defs><rect width="${width}" height="${height}" fill="white" mask="url(#spot)"/></svg>`;
      setMask(`url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
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
  if (!step || !mask) return null;
  return createPortal(
    <div
      className="tutorial-spotlight"
      aria-hidden="true"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    />,
    document.body
  );
}
