import { Button } from "@/components/ui/button";
import { useState, type ReactNode } from "react";
import { Dialog, DropdownMenu } from "radix-ui";
import { authClient } from "../../app/auth-client";
import { ThemeMenu } from "./ThemeMenu";
import { cleanupPushBeforeSignOut } from "../alerts/push";

export function AppHeader({
  onLocations,
  onHistory,
  onHome,
  view,
  actions,
  feedback,
  alerts,
}: {
  onLocations: () => void;
  onHistory: () => void;
  onHome: () => void;
  view: "deals" | "history";
  actions?: ReactNode;
  feedback?: ReactNode;
  alerts?: ReactNode;
}) {
  const [accountError, setAccountError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const signOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    setAccountError("");
    void cleanupPushBeforeSignOut()
      .catch(() => {
        throw new Error(
          "خروج متوقف شد؛ پاک‌سازی اعلان این دستگاه انجام نشد. اتصال را بررسی و دوباره تلاش کنید."
        );
      })
      .then(() => authClient.signOut())
      .then((result) => {
        if (result.error)
          setAccountError("خروج از حساب انجام نشد؛ دوباره تلاش کنید.");
      })
      .catch((error: unknown) =>
        setAccountError(
          error instanceof Error && /[؀-ۿ]/.test(error.message)
            ? error.message
            : "خروج از حساب انجام نشد؛ دوباره تلاش کنید."
        )
      )
      .finally(() => setSigningOut(false));
  };

  return (
    <>
      <header className="app-header">
        <Button
          variant="ghost"
          className="brand"
          onClick={onHome}
          aria-label="بهتر بخر، پیشنهادها"
          title="پیشنهادها"
        >
          <span className="brand-mark">ب</span>
          <span>
            <strong>بهتر بخر</strong>
            <small>
              <bdi>Better Buy</bdi>
            </small>
          </span>
        </Button>

        <div className="app-header-controls">
          <nav className="app-header-primary" aria-label="دسترسی سریع">
            {alerts}
            <Button
              variant="ghost"
              className="header-icon-button"
              onClick={onLocations}
              aria-label="موقعیت‌ها"
              title="موقعیت‌ها"
            >
              <LocationIcon />
            </Button>
            <Button
              variant="ghost"
              className="header-icon-button"
              onClick={onHistory}
              aria-label="تاریخچه اسکن"
              title="تاریخچه اسکن"
              aria-current={view === "history" ? "page" : undefined}
            >
              <HistoryIcon />
            </Button>
            {actions}
          </nav>

          <div className="app-header-menu">
            <DropdownMenu.Root dir="rtl">
              <DropdownMenu.Trigger asChild>
                <Button
                  variant="ghost"
                  className="header-icon-button"
                  aria-label="منوی بیشتر"
                  title="منوی بیشتر"
                >
                  <MenuIcon />
                </Button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="account-menu app-header-menu-content"
                  align="end"
                  sideOffset={8}
                  aria-label="منوی بیشتر"
                >
                  <DropdownMenu.Label>بیشتر</DropdownMenu.Label>
                  <ThemeMenu />
                  <DropdownMenu.Item onSelect={() => setHelpOpen(true)}>
                    راهنما
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item disabled={signingOut} onSelect={signOut}>
                    {signingOut ? "در حال خروج امن…" : "خروج از حساب"}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>

        {feedback}
      </header>

      {accountError && (
        <p className="form-error" role="alert">
          {accountError}
        </p>
      )}

      <Dialog.Root open={helpOpen} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sheet-backdrop" />
          <Dialog.Content className="panel" aria-describedby={undefined}>
            <header className="panel-heading">
              <Dialog.Title>راهنمای بهتر بخر</Dialog.Title>
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
            <p>
              موقعیت تحویل را ثبت کنید تا تخفیف‌ها پیدا شوند؛ سپس قیمت
              فروشگاه‌ها را مقایسه کنید.
            </p>
            <p>
              برای اسکن اسنپ‌مارکت و اکالا نیازی به ورود به فروشگاه نیست. ورود
              به بهتر بخر برای نگهداری موقعیت‌ها و تاریخچه لازم است.
            </p>
            <p>
              اکالا پیشنهادهای فهرست عمومی تبلیغاتی را بررسی می‌کند؛ این فهرست
              تمام کالاهای اکالا را پوشش نمی‌دهد.
            </p>
            <p>
              قیمت‌ها مشاهدات زمان اسکن هستند. نبودن پیشنهاد در فهرست تازه، به
              معنی ناموجود بودن آن در همه فروشگاه‌ها نیست.
            </p>
            <p>
              اسکن تازه جت فعلاً غیرفعال است؛ نتیجه‌های قبلی در تاریخچه قابل
              مشاهده‌اند.
            </p>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function LocationIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
