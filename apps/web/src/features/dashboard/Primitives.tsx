import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ReactNode } from "react";
import { Dialog } from "radix-ui";
import { AppIcon } from "./AppIcon";
export function Panel({
  title,
  children,
  trigger,
  open,
  onOpenChange,
}: {
  title: string;
  children: ReactNode;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-backdrop" />
        <Dialog.Content className="panel" aria-describedby={undefined}>
          <header className="panel-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="icon-button"
                aria-label="بستن پنجره"
              >
                ×
              </Button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function ReadNotice({
  title,
  children,
  retry,
  busy = false,
  onDismiss,
}: {
  title: string;
  children?: ReactNode;
  retry?: () => void;
  busy?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <Card asChild>
      <section className="read-notice" role="status">
        <div className={onDismiss ? "min-w-0 flex-1 self-stretch" : undefined}>
          {onDismiss ? (
            <div className="flex items-center justify-between gap-2">
              <strong>{title}</strong>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="bg-transparent p-0 text-muted-foreground"
                aria-label="بستن پیام اسکن"
                onClick={onDismiss}
              >
                <AppIcon name="close" />
              </Button>
            </div>
          ) : (
            <strong>{title}</strong>
          )}
          {children && <p>{children}</p>}
        </div>
        {retry && (
          <Button
            variant="outline"
            type="button"
            onClick={retry}
            disabled={busy}
          >
            {busy ? "در حال دریافت…" : "دریافت دوباره"}
          </Button>
        )}
      </section>
    </Card>
  );
}
