"use client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { QuerySession } from "../features/dashboard/QuerySession";
import { authClient } from "./auth-client";
import { Dashboard } from "../features/dashboard/Dashboard";
import { AuthScreen } from "../features/auth/AuthScreen";
import { useVisitAnalytics } from "../features/admin/useAnalytics";
import { useEffect, useState } from "react";
import { NotificationsPage } from "../features/alerts/NotificationsPage";
import { ProductDetailPage } from "../features/deals/ProductDetailPage";
import { VisitorProvider } from "../features/guest/VisitorProvider";
import {
  GuestWorkspace,
  GuestLocationImport,
} from "../features/guest/GuestWorkspace";
export default function Page() {
  const [destination, setDestination] = useState({
    page: "",
    scan: "",
    product: "",
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setDestination({
      page:
        params.get("page") ??
        (params.has("inbox") || params.has("notification")
          ? "notifications"
          : ""),
      scan: params.get("scan") ?? "",
      product: params.get("product") ?? "",
    });
  }, []);
  useVisitAnalytics();
  const { data: session, isPending, error, refetch } = authClient.useSession();
  if (isPending)
    return (
      <main className="auth-loading" aria-live="polite">
        در حال بررسی ورود…
      </main>
    );
  if (error && !session)
    return (
      <main className="auth-shell">
        <Card className="auth-card" role="status">
          <h1>بررسی ورود انجام نشد</h1>
          <p>برای ادامه، وضعیت حساب را دوباره دریافت کنید.</p>
          <Button variant="outline" onClick={() => void refetch()}>
            دریافت دوباره
          </Button>
        </Card>
      </main>
    );
  if (!session && destination.page === "login")
    return (
      <>
        <nav className="guest-login-return">
          <a href="/">ادامه بدون ورود</a>
        </nav>
        <AuthScreen />
      </>
    );
  const content =
    destination.page === "notifications" ? (
      session ? (
        <NotificationsPage />
      ) : (
        <main className="guest-recovery">
          <h1>اعلان‌ها برای حساب شما نگهداری می‌شوند</h1>
          <p>برای استفاده از اعلان‌ها وارد حساب خود شوید.</p>
          <a href="/?page=login">ورود یا ثبت‌نام</a>
          <p>
            <a href="/">بازگشت به پیشنهادها</a>
          </p>
        </main>
      )
    ) : destination.page === "product" ? (
      <ProductDetailPage
        scanId={destination.scan}
        productKey={destination.product}
      />
    ) : (
      <Dashboard />
    );
  return (
    <VisitorProvider key={session?.user.id ?? "guest"} isGuest={!session}>
      <QuerySession>
        {session ? (
          <>
            <GuestLocationImport userId={session.user.id} />
            {content}
          </>
        ) : (
          <GuestWorkspace>{content}</GuestWorkspace>
        )}
      </QuerySession>
    </VisitorProvider>
  );
}
