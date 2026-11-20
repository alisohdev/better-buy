import { createRootRoute, Outlet } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ThemeProvider } from "@/components/theme-provider";
const LegacyPage = lazy(() => import("@/app/page"));

function RootLayout() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <Suspense
        fallback={
          <main className="auth-loading" aria-live="polite">
            در حال بارگذاری…
          </main>
        }
      >
        <Outlet />
      </Suspense>
    </ThemeProvider>
  );
}

export const Route = createRootRoute({ component: RootLayout });
export function LegacyApp() {
  return <LegacyPage />;
}
