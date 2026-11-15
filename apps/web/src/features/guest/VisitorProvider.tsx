"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import "./guest.css";

const signIn = () => window.location.assign("/?page=login");
const VisitorContext = createContext({
  isGuest: false,
  notify: (_message: string) => {},
  requireAccount: (_feature: string): boolean => true,
  signIn,
});

export const useVisitor = () => useContext(VisitorContext);

export function VisitorProvider({
  isGuest,
  children,
}: {
  isGuest: boolean;
  children: ReactNode;
}) {
  const [notice, setNotice] = useState<{ message: string; id: number } | null>(
    null
  );
  const notify = (message: string) => setNotice({ message, id: Date.now() });
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const requireAccount = (feature: string) => {
    if (!isGuest) return true;
    notify(
      `برای ${feature} و نگهداری اطلاعات، وارد حساب خود شوید. موقعیت مهمان پس از ورود به حساب افزوده می‌شود.`
    );
    return false;
  };
  return (
    <VisitorContext.Provider
      value={{ isGuest, notify, requireAccount, signIn }}
    >
      {isGuest && (
        <aside className="guest-banner" aria-label="حالت مهمان">
          <div>
            <strong>تخفیف‌های دلخواهتان را از دست ندهید</strong>
            <p>
              با ورود به حساب، کالاهای دلخواهتان را ذخیره کنید، از تخفیف‌هایشان
              باخبر شوید و سبد خریدتان را برای بعد نگه دارید.
            </p>
          </div>
          <Button onClick={signIn}>ورود یا ثبت‌نام</Button>
        </aside>
      )}
      {children}
      <div className="guest-toast-region" aria-live="polite" aria-atomic="true">
        {notice && (
          <section className="guest-toast" key={notice.id}>
            <p>{notice.message}</p>
            <div>
              {isGuest && <Button onClick={signIn}>ورود یا ثبت‌نام</Button>}
              <Button
                variant="ghost"
                onClick={() => setNotice(null)}
                aria-label="بستن پیام"
              >
                بستن
              </Button>
            </div>
          </section>
        )}
      </div>
    </VisitorContext.Provider>
  );
}
