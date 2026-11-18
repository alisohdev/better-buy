import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ReactNode } from "react";
import { Dialog } from "radix-ui";
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
        <div>
          <strong>{title}</strong>
          {children && <p>{children}</p>}
        </div>
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="بستن پیام اسکن"
            onClick={onDismiss}
          >
            ×
          </Button>
        )}
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
