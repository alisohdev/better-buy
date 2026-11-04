"use client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { QuerySession } from "../features/dashboard/QuerySession";
import { authClient } from "./auth-client";
import { Dashboard } from "../features/dashboard/Dashboard";
import { AuthScreen } from "../features/auth/AuthScreen";
import { DevSignIn } from "../features/auth/DevSignIn";
import { useVisitAnalytics } from "../features/admin/useAnalytics";
export default function Page() {
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
  if (!session)
    return process.env.NODE_ENV === "development" ? (
      <DevSignIn />
    ) : (
      <AuthScreen />
    );
  return (
    <QuerySession key={session.user.id}>
      <Dashboard />
    </QuerySession>
  );
}
