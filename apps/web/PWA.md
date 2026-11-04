# Wishlist, inbox, and browser push

- Dashboard navigation opens the Persian RTL wishlist and notification inbox.
- Wishlist scan-location selection is independent from the location currently used to browse deals. Selecting no location sends `{locationId:null}`. The optional `scheduleEnabled:false` response shows a setup banner; scheduling remains a backend responsibility (09:00 and 18:00 Tehran).
- Notification links `/?notification=<id>` open the inbox. Links `/?scan=<scanId>` restore the matching account scan's location, provider, threshold, and saved result. Inaccessible scans have an explicit notice.
- Notification match prices retain provider units and use the existing dashboard money formatter. The client preserves backend match ordering and does not re-sort paginated products.
- Push requires a secure origin, browser support, and a configured VAPID public key. Permission is requested only by the enable button. Existing subscriptions are explicitly synchronized with the current account; a failed new subscription sync attempts browser rollback. Disable removes the backend endpoint before unsubscribing locally, retaining retry controls on failure.
- The same root-scoped `/sw.js` registration serves browser and installed PWA push. Its payload accepts `{id,title,body,url}`. Push URLs and notification-click data are separately restricted to the current origin, with the inbox as fallback. There is no fetch handler or offline/authenticated response cache.
- The manifest and app icons are static assets in `public/`. PNG icons are derived from the editable `public/icons/brand.svg` mark. Installation does not imply offline support. On iOS/iPadOS, users may need to add the app to their home screen and launch the installed app before enabling push.

## Validation

Run from the repository root:

```sh
pnpm --filter @better-buy/web exec tsc --noEmit --incremental false
pnpm --filter @better-buy/web test
pnpm --filter @better-buy/web exec playwright test tests/alerts.spec.ts --config playwright.export.config.ts
```

The fixture browser tests cover desktop/mobile wishlist CRUD, nullable scan location, schedule-disabled and missing-key states, notification read/deep links, scan restoration, click-only permission, subscription payload/removal, failed-sync rollback, denied permission, and unsupported browsers. Service-worker tests execute the shipped worker in an isolated VM. These are local deterministic tests, not proof of authenticated production delivery or a real OS push notification.
