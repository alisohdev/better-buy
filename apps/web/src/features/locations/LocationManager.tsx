"use client";
import { Button } from "@/components/ui/button";
import { useCallback, useState } from "react";
import { Dialog } from "radix-ui";
import type { LocationRecord } from "@better-buy/shared";
import { LocationEditor } from "./LocationEditor";

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
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  );
  const showList = () => setView({ kind: "list" });
  const focusListTitle = useCallback(
    (element: HTMLHeadingElement | null) => {
      if (view.kind === "list") element?.focus();
    },
    [view.kind]
  );
  const title =
    view.kind === "list"
      ? "موقعیت‌های تحویل"
      : view.kind === "edit"
        ? "ویرایش مکان"
        : "افزودن موقعیت تحویل";

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-backdrop" />
        <Dialog.Content
          className={
            view.kind === "list" ? "panel" : "location-sheet map-sheet"
          }
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
              showList();
            }
          }}
        >
          <header className="panel-heading">
            <Dialog.Title key={view.kind} tabIndex={-1} ref={focusListTitle}>
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="icon-button"
                aria-label="بستن پنجره مکان"
              >
                ×
              </Button>
            </Dialog.Close>
          </header>
          {view.kind === "list" ? (
            <>
              <p className="muted">
                موقعیت تحویل، پیشنهادهای قابل بررسی را مشخص می‌کند.
              </p>
              <div className="location-list">
                {locations.map((location) => (
                  <div className="location-item" key={location.id}>
                    <div>
                      <strong>{location.name}</strong>
                      <small>
                        <bdi dir="ltr">
                          {location.latitude.toFixed(4)},{" "}
                          {location.longitude.toFixed(4)}
                        </bdi>
                        {location.isDefault && " · پیش‌فرض"}
                      </small>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setView({ kind: "edit", location })}
                      aria-label={`ویرایش ${location.name}`}
                    >
                      ویرایش
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="default"
                onClick={() => setView({ kind: "create" })}
              >
                افزودن موقعیت تحویل
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="outline"
                type="button"
                className="back-button"
                onClick={showList}
              >
                بازگشت به موقعیت‌ها
              </Button>
              <LocationEditor
                key={view.kind === "edit" ? view.location.id : "create"}
                location={view.kind === "edit" ? view.location : null}
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
