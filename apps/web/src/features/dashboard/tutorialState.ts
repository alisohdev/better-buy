export type TutorialStep =
  "location" | "map" | "details" | "scan" | "waiting" | "results" | "done";
export type TutorialEvent =
  | "location-opened"
  | "map-confirmed"
  | "map-back"
  | "location-closed"
  | "location-saved"
  | "scan-started"
  | "scan-succeeded"
  | "scan-failed"
  | "results-opened";

export function tutorialTransition(
  step: TutorialStep | null,
  event: TutorialEvent
): TutorialStep | null {
  if ((step === "map" || step === "details") && event === "location-closed")
    return "location";
  const transitions: Partial<
    Record<TutorialStep, Partial<Record<TutorialEvent, TutorialStep>>>
  > = {
    location: { "location-opened": "map" },
    map: { "map-confirmed": "details" },
    details: { "map-back": "map", "location-saved": "scan" },
    scan: { "scan-started": "waiting" },
    waiting: { "scan-succeeded": "results", "scan-failed": "scan" },
    results: { "results-opened": "done" },
  };
  return step ? (transitions[step]?.[event] ?? step) : null;
}

export const tutorialSteps: TutorialStep[] = [
  "location",
  "map",
  "details",
  "scan",
  "waiting",
  "results",
  "done",
];
