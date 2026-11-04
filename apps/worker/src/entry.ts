import handler from "./index";
import { reconcileDurableOperations } from "./durable/service";
import type { WorkerEnv } from "./http/types";
import { cleanupRateLimits } from "./http/rateLimit";
import { runWishlistSchedule } from "./wishlist-scheduler";
import { processWishlistNotifications } from "./wishlist";
import { cleanupOkalaOfferCache } from "./providers/okala/sharedOffers";
import { scanEngineFor } from "./runtime/scan-engine";

// Keep the runtime entrypoint separate from the HTTP application test seam.
export { ScanWorkflow } from "./workflows/scan";
export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const scanEngine = scanEngineFor(env);
        if (scanEngine)
          await reconcileDurableOperations({ ...env, SCAN_ENGINE: scanEngine });
        await processWishlistNotifications(env);
        await runWishlistSchedule(env, event.scheduledTime);
        await cleanupOkalaOfferCache(env.DB);
        if (env.API_RATE_LIMITS_ENABLED === "true")
          await cleanupRateLimits(env.DB);
      })()
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
