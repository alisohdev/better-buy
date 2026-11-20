import { createFileRoute } from "@tanstack/react-router";
import { LegacyApp } from "./__root";
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    page: typeof search.page === "string" ? search.page : undefined,
    scan: typeof search.scan === "string" ? search.scan : undefined,
    product: typeof search.product === "string" ? search.product : undefined,
    notification:
      typeof search.notification === "string" ? search.notification : undefined,
    inbox: typeof search.inbox === "string" ? search.inbox : undefined,
  }),
  component: LegacyApp,
});
