"use client";
import { useState } from "react";
import { AlertDialog } from "radix-ui";
import type { LocationRecord } from "@better-buy/shared";
import { Button } from "@/components/ui/button";
import { useLocationMutations } from "./useLocationMutations";

export function LocationDeleteAction({
  location,
  onDeleted,
}: {
  location: LocationRecord;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { remove, pending, error } = useLocationMutations(
    location.id,
    onDeleted
  );
  return (
    <AlertDialog.Root open={open} onOpenChange={setOpen}>
      <AlertDialog.Trigger asChild>
        <Button
          variant="ghost"
          className="location-delete-trigger"
          aria-label={`حذف ${location.name}`}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="sheet-backdrop" />
        <AlertDialog.Content className="panel delete-confirmation location-delete-dialog">
          <AlertDialog.Title>حذف «{location.name}»؟</AlertDialog.Title>
          <AlertDialog.Description>
            همه تاریخچه اسکن‌ها و پیشنهادهای این موقعیت برای همیشه حذف می‌شوند.
            این کار قابل بازگشت نیست.
          </AlertDialog.Description>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => remove(() => {})}
          >
            {pending ? "در حال حذف…" : "حذف همیشگی"}
          </Button>
          <AlertDialog.Cancel asChild>
            <Button variant="outline" disabled={pending}>
              انصراف
            </Button>
          </AlertDialog.Cancel>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
