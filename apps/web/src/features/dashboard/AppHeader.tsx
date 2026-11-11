import { AppearanceSwitch } from "./AppearanceSwitch";
import { Button } from "@/components/ui/button";
import { useRef, useState, type ReactNode } from "react";
import { Dialog, DropdownMenu } from "radix-ui";
import { useTheme } from "next-themes";
import { authClient } from "../../app/auth-client";
import { Panel } from "./Primitives";
import { AppIcon } from "./AppIcon";
import { cleanupPushBeforeSignOut } from "../alerts/push";

export function AppHeader({
  onLocations,
  onHistory,
  onHome,
  onScan,
  onWishlist,
  onNotifications,
  onAdmin,
  view,
  scanning = false,
  wishlistOpen = false,
  cartOpen = false,
  locationsOpen = false,
  actions,
  feedback,
}: {
  onLocations: () => void;
  onHistory: () => void;
  onHome: () => void;
  onScan: () => void;
  scanning?: boolean;
  wishlistOpen?: boolean;
  cartOpen?: boolean;
  locationsOpen?: boolean;
  onWishlist: () => void;
  onNotifications: () => void;
  onAdmin?: () => void;
  view: "deals" | "history" | "admin";
  actions?: ReactNode;
  feedback?: ReactNode;
}) {
  const { theme, setTheme } = useTheme();
  const [accountError, setAccountError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileAction = (action: () => void) => {
    setMobileMenuOpen(false);
    requestAnimationFrame(action);
  };
  const overlayActive = wishlistOpen || cartOpen || locationsOpen || helpOpen;
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
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
      .then((response) => {
        if (response.error)
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
        >
          <span className="brand-mark">ب</span>
          <span>
            <strong>بهتر بخر</strong>
            <small>
              <bdi>Better Buy</bdi>
            </small>
          </span>
        </Button>
        <nav className="desktop-primary-nav" aria-label="ناوبری اصلی">
          <Button
            variant="ghost"
            aria-current={
              view === "deals" && !scanning && !overlayActive
                ? "page"
                : undefined
            }
            data-active={view === "deals" && !scanning && !overlayActive}
            onClick={onHome}
          >
            <AppIcon name="home" />
            پیشنهادها
          </Button>
          <Button
            variant="ghost"
            aria-current={scanning && !overlayActive ? "page" : undefined}
            data-active={scanning && !overlayActive}
            onClick={onScan}
          >
            <AppIcon name="scan" />
            اسکن تخفیف‌ها
          </Button>
          <Button
            variant="ghost"
            data-active={wishlistOpen}
            aria-pressed={wishlistOpen}
            onClick={onWishlist}
          >
            <AppIcon name="heart" />
            علاقه‌مندی‌ها
          </Button>
          <Button variant="ghost" onClick={onNotifications}>
            <AppIcon name="bell" />
            اعلان‌ها
          </Button>
          <Button
            variant="ghost"
            aria-current={
              view === "history" && !overlayActive ? "page" : undefined
            }
            data-active={view === "history" && !overlayActive}
            onClick={onHistory}
          >
            <AppIcon name="history" />
            تاریخچه
          </Button>
        </nav>
        <div className="header-actions">{actions}</div>
        <div className="sidebar-utilities">
          <Button
            variant="ghost"
            data-active={locationsOpen}
            aria-pressed={locationsOpen}
            onClick={onLocations}
          >
            <AppIcon name="location" />
            موقعیت‌های تحویل
          </Button>
          <Button
            variant="ghost"
            data-active={helpOpen}
            onClick={() => setHelpOpen(true)}
          >
            <AppIcon name="list" />
            راهنمای بهتر بخر
          </Button>
          {onAdmin && (
            <Button variant="ghost" onClick={onAdmin}>
              مدیریت و آمار
            </Button>
          )}
          <div className="sidebar-footer">
            <AppearanceSwitch />
            <Button
              className="sidebar-signout"
              variant="ghost"
              disabled={signingOut}
              onClick={signOut}
            >
              <AppIcon name="back" />
              {signingOut ? "در حال خروج…" : "خروج از حساب"}
            </Button>
          </div>
        </div>
        <DropdownMenu.Root dir="rtl">
          <DropdownMenu.Trigger asChild>
            <Button
              ref={menuTrigger}
              variant="ghost"
              className="secondary-menu-trigger desktop-menu-trigger"
              aria-label="منوی برنامه"
            >
              <AppIcon name="menu" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="account-menu secondary-menu"
              align="end"
              sideOffset={8}
            >
              <DropdownMenu.Item onSelect={onHome}>پیشنهادها</DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => requestAnimationFrame(onLocations)}
              >
                مدیریت موقعیت‌ها
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => requestAnimationFrame(() => setHelpOpen(true))}
              >
                راهنمای بهتر بخر
              </DropdownMenu.Item>
              {onAdmin && (
                <DropdownMenu.Item onSelect={onAdmin}>
                  مدیریت و آمار
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>ظاهر برنامه</DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    className="account-menu"
                    sideOffset={4}
                  >
                    <DropdownMenu.RadioGroup
                      value={theme}
                      onValueChange={setTheme}
                    >
                      <DropdownMenu.RadioItem value="light">
                        روشن
                      </DropdownMenu.RadioItem>
                      <DropdownMenu.RadioItem value="dark">
                        تیره
                      </DropdownMenu.RadioItem>
                      <DropdownMenu.RadioItem value="system">
                        سیستم
                      </DropdownMenu.RadioItem>
                    </DropdownMenu.RadioGroup>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item disabled={signingOut} onSelect={signOut}>
                {signingOut ? "در حال خروج امن…" : "خروج از حساب"}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <Dialog.Root open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <Dialog.Trigger asChild>
            <Button
              variant="ghost"
              className="mobile-side-menu-trigger"
              aria-label="منوی برنامه"
            >
              <AppIcon name="menu" />
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="sheet-backdrop mobile-menu-overlay" />
            <Dialog.Content
              className="mobile-side-menu"
              dir="rtl"
              aria-describedby={undefined}
            >
              <header>
                <Dialog.Title>بهتر بخر</Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="بستن منو">
                    <AppIcon name="close" />
                  </Button>
                </Dialog.Close>
              </header>
              <nav aria-label="منوی اصلی">
                <Button
                  variant="ghost"
                  data-active={scanning}
                  onClick={() => mobileAction(onScan)}
                >
                  <AppIcon name="scan" />
                  اسکن تخفیف‌ها
                </Button>
                <Button
                  variant="ghost"
                  data-active={view === "deals" && !scanning}
                  onClick={() => mobileAction(onHome)}
                >
                  <AppIcon name="home" />
                  پیشنهادها
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => mobileAction(onWishlist)}
                >
                  <AppIcon name="heart" />
                  علاقه‌مندی‌ها
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => mobileAction(onNotifications)}
                >
                  <AppIcon name="bell" />
                  اعلان‌ها
                </Button>
                <Button
                  variant="ghost"
                  data-active={view === "history"}
                  onClick={() => mobileAction(onHistory)}
                >
                  <AppIcon name="history" />
                  تاریخچه
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => mobileAction(onLocations)}
                >
                  <AppIcon name="location" />
                  مدیریت موقعیت‌ها
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => mobileAction(() => setHelpOpen(true))}
                >
                  راهنمای بهتر بخر
                </Button>
                {onAdmin && (
                  <Button variant="ghost" onClick={() => mobileAction(onAdmin)}>
                    مدیریت و آمار
                  </Button>
                )}
              </nav>
              <div className="mobile-sidebar-footer">
                <AppearanceSwitch />
                <Button
                  variant="outline"
                  disabled={signingOut}
                  onClick={signOut}
                >
                  {signingOut ? "در حال خروج امن…" : "خروج از حساب"}
                </Button>
              </div>
              {accountError && <p role="alert">{accountError}</p>}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {feedback}
      </header>
      <Panel
        title="راهنمای بهتر بخر"
        open={helpOpen}
        onOpenChange={(open) => {
          setHelpOpen(open);
          if (!open) requestAnimationFrame(() => menuTrigger.current?.focus());
        }}
        trigger={<button type="button" hidden aria-label="راهنما" />}
      >
        <p>
          موقعیت تحویل را ثبت کنید تا تخفیف‌ها پیدا شوند؛ سپس قیمت فروشگاه‌ها را
          مقایسه کنید.
        </p>
        <p>
          برای اسکن اسنپ‌مارکت و اکالا نیازی به ورود به فروشگاه نیست. ورود به
          بهتر بخر برای نگهداری موقعیت‌ها و تاریخچه لازم است.
        </p>
        <p>
          هر دو فروشگاه به‌صورت پیش‌فرض بررسی می‌شوند. حداقل تخفیف، نتیجه‌های
          ذخیره‌شده را فیلتر می‌کند و با جابه‌جایی آن نیازی به اسکن دوباره نیست.
        </p>
        <p>قیمت و موجودی، مشاهده زمان اسکن است.</p>
        <p>
          اسکن تازه جت فعلاً غیرفعال است؛ نتیجه‌های قبلی در تاریخچه قابل
          مشاهده‌اند.
        </p>
      </Panel>
      {accountError && (
        <p className="form-error" role="alert">
          {accountError}
        </p>
      )}
    </>
  );
}
