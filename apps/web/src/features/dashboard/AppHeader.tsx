import { Button } from "@/components/ui/button";
import { useRef, useState, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { useTheme } from "next-themes";
import { authClient } from "../../app/auth-client";
import { Panel } from "./Primitives";
import { AppIcon } from "./AppIcon";
import { cleanupPushBeforeSignOut } from "../alerts/push";

export function AppHeader({
  onLocations,
  onHistory,
  onHome,
  onWishlist,
  onNotifications,
  onAdmin,
  view,
  actions,
  feedback,
}: {
  onLocations: () => void;
  onHistory: () => void;
  onHome: () => void;
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
          <Button variant="ghost" onClick={onWishlist}>
            <AppIcon name="heart" />
            علاقه‌مندی‌ها
          </Button>
          <Button variant="ghost" onClick={onNotifications}>
            <AppIcon name="bell" />
            اعلان‌ها
          </Button>
          <Button
            variant="ghost"
            aria-current={view === "history" ? "page" : undefined}
            onClick={onHistory}
          >
            <AppIcon name="history" />
            تاریخچه
          </Button>
        </nav>
        <div className="header-actions">{actions}</div>
        <DropdownMenu.Root dir="rtl">
          <DropdownMenu.Trigger asChild>
            <Button
              ref={menuTrigger}
              variant="ghost"
              className="secondary-menu-trigger"
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
