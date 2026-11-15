"use client";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import type { LocationRecord } from "@better-buy/shared";
import { LocationEditor, type LocationStage } from "./LocationEditor";
import { LocationDeleteAction } from "./LocationDeleteAction";
import { LocationAddress } from "./useLocationAddress";
import { AppIcon } from "../dashboard/AppIcon";
import "./location-editor.css";

type LocationView =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; location: LocationRecord };

export function LocationManager({
  locations,
  initialView,
  onClose,
  onSaved,
}: {
  locations: LocationRecord[];
  initialView: "list" | "create";
  onClose: () => void;
  onSaved: (location?: LocationRecord) => void;
}) {
  const [view, setView] = useState<LocationView>({ kind: initialView });
  const [stage, setStage] = useState<LocationStage>("map");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  const showList = () => setView({ kind: "list" });
  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [view.kind, stage]);
  const goBack = () => {
    if (view.kind === "create" && stage === "details") setStage("map");
    else if (view.kind !== "list" && stage === "map" && view.kind === "edit")
      setStage("details");
    else showList();
  };
  const title =
    view.kind === "list"
      ? "موقعیت‌های تحویل"
      : stage === "map"
        ? "انتخاب آدرس"
        : "جزئیات آدرس";

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-backdrop" />
        <Dialog.Content
          className={`location-sheet location-flow ${view.kind === "list" ? "location-flow-list" : `location-flow-${stage}`}`}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target =
              returnFocusTo?.isConnected && returnFocusTo !== document.body
                ? returnFocusTo
                : document.querySelector<HTMLElement>(
                    ".secondary-menu-trigger"
                  );
            target?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (view.kind !== "list") {
              event.preventDefault();
              goBack();
            }
          }}
        >
          <header className="panel-heading">
            {view.kind !== "list" && (
              <Button
                variant="outline"
                type="button"
                className="location-back-button"
                aria-label="بازگشت به موقعیت‌ها"
                title="بازگشت به موقعیت‌ها"
                onClick={goBack}
              >
                <svg
                  aria-hidden="true"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <path
                    d="M5 12h14m-6-6 6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Button>
            )}
            <Dialog.Title tabIndex={-1} ref={titleRef}>
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="icon-button location-close-button"
                aria-label="بستن پنجره مکان"
              >
                <AppIcon name="close" />
              </Button>
            </Dialog.Close>
          </header>
          {view.kind === "list" ? (
            <>
              <Button
                variant="outline"
                className="location-add-button"
                onClick={() => {
                  setStage("map");
                  setView({ kind: "create" });
                }}
              >
                <AppIcon name="plus" />
                افزودن آدرس جدید
              </Button>
              <div className="location-list">
                {locations.map((location) => (
                  <div className="location-address-row" key={location.id}>
                    <Button
                      variant="ghost"
                      className="location-address-select"
                      onClick={() => {
                        onSaved(location);
                        onClose();
                      }}
                      aria-label={`انتخاب ${location.name}`}
                    >
                      <AppIcon name="location" />
                      <span>
                        <strong>{location.name}</strong>
                        <LocationAddress
                          latitude={location.latitude}
                          longitude={location.longitude}
                        />
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      className="location-edit-trigger"
                      onClick={() => {
                        setStage("details");
                        setView({ kind: "edit", location });
                      }}
                      aria-label={`ویرایش ${location.name}`}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14v6Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </Button>
                    <LocationDeleteAction
                      location={location}
                      onDeleted={() => {
                        onSaved();
                        titleRef.current?.focus();
                      }}
                    />
                  </div>
                ))}
              </div>
              {!locations.length && (
                <p className="location-empty">هنوز آدرسی ذخیره نکرده‌اید.</p>
              )}
              <Button
                variant="outline"
                className="location-list-back"
                onClick={onClose}
              >
                بازگشت
              </Button>
            </>
          ) : (
            <>
              <LocationEditor
                key={view.kind === "edit" ? view.location.id : "create"}
                location={view.kind === "edit" ? view.location : null}
                stage={stage}
                onStageChange={setStage}
                onSaved={(saved) => {
                  onSaved(saved);
                  if (initialView === "create") onClose();
                  else showList();
                }}
              />
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
