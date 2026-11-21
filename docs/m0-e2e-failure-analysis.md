# M0 E2E failure analysis

Initial report inventory completed before assertion changes in this recovery pass. All 114 unexpected cases are accounted for below. Classification is provisional until reproduction and trace inspection establish the cause. No remaining failure has an accepted waiver.

Baseline reports 108 passed, 114 failed, zero skipped and zero flaky across 222 cases.

## Confirmed recovery results

On November 20, the focused alerts deep-link group passed all six desktop/mobile cases against a fresh production build with server reuse disabled.

- Authentication entry was an application regression. A signed-out product deep link entered guest bootstrap and never displayed sign-in. The route now presents the existing authentication screen while preserving the product URL. The existing test completes password login and verifies the restored product and retailer.
- Scan details were a test expectation mismatch. The current details dialog replaces the historical disclosure. The test opens the accessible result-details button and verifies the restored delivery location and provider inside the dialog.
- Command used `pnpm --filter @better-buy/web exec playwright test alerts.spec.ts --grep 'deep link' --trace=retain-on-failure --output=test-results/m0-alert-recovery` with `CI=1`.
- These results cover four baseline failures and two existing passing cases. The remaining baseline groups still require investigation.

| Group                                                                                           | Cases | Files and lines                                                                                                                                                                             | Classification                      | Investigation and fix                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. waiting for getByLabel('شماره همراه', { exact: true })                                       |     2 | alerts.spec.ts:371                                                                                                                                                                          | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 2. waiting for locator('.scan-details').locator('summary')                                      |     2 | alerts.spec.ts:399                                                                                                                                                                          | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 3. waiting for getByRole('button', { name: 'اسکن تخفیف‌ها', exact: true })                      |     1 | alerts.spec.ts:277                                                                                                                                                                          | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 4. Locator: locator('.scan-stage-running').getByRole('progressbar')                             |     2 | dashboard.spec.ts:322                                                                                                                                                                       | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 5. Locator: getByRole('button', { name: /^(پیدا کردن تخفیف‌ها/به‌روزرسانی تخفیف‌ها)$/ })        |     4 | dashboard.spec.ts:473, dashboard.spec.ts:628                                                                                                                                                | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 6. waiting for locator('.shopping-location')                                                    |     8 | dashboard.spec.ts:545, dashboard.spec.ts:1792, guest.spec.ts:325, guest.spec.ts:378                                                                                                         | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 7. Locator: getByText('در حال دریافت اطلاعات…')                                                 |     2 | dashboard.spec.ts:587                                                                                                                                                                       | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 8. Locator: getByText('در حال پیدا کردن تخفیف‌ها…', { exact: true })                            |     2 | dashboard.spec.ts:663                                                                                                                                                                       | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 9. Locator: getByText('وضعیت اسکن تازه‌سازی نشد', { exact: true })                              |     2 | dashboard.spec.ts:699                                                                                                                                                                       | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 10. Locator: getByRole('heading', { name: 'چای سیاه ایرانی، بسته ۵۰۰ گرمی', exact: true })      |    16 | dashboard.spec.ts:726, dashboard.spec.ts:771, dashboard.spec.ts:785, dashboard.spec.ts:1160, dashboard.spec.ts:1299, dashboard.spec.ts:1382, dashboard.spec.ts:1448, dashboard.spec.ts:1760 | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 11. Locator: getByText('نتیجه اسکن دریافت نشد', { exact: true })                                |    16 | dashboard.spec.ts:742, dashboard.spec.ts:811, dashboard.spec.ts:831, dashboard.spec.ts:1039                                                                                                 | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 12. waiting for getByRole('checkbox', { name: 'اکالا', exact: true })                           |    10 | dashboard.spec.ts:849, dashboard.spec.ts:878, dashboard.spec.ts:906, paged-feed.spec.ts:206, paged-feed.spec.ts:281                                                                         | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 13. waiting for getByRole('checkbox', { name: 'اسنپ‌مارکت', exact: true })                      |     2 | dashboard.spec.ts:946                                                                                                                                                                       | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 14. waiting for getByRole('button', { name: 'منوی برنامه', exact: true })                       |     3 | dashboard.spec.ts:984, dashboard.spec.ts:1183, dashboard.spec.ts:1233                                                                                                                       | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 15. Locator: getByText('در حال دریافت نتیجه ذخیره‌شده…')                                        |     2 | dashboard.spec.ts:1061                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 16. Locator: locator('.deal-row .product-provider')                                             |     2 | dashboard.spec.ts:1093                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 17. Locator: locator('.product-copy')                                                           |     2 | dashboard.spec.ts:1344                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 18. Locator: getByRole('button', { name: 'ساخت حساب کاربری' })                                  |     2 | dashboard.spec.ts:1527                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 19. Locator: getByRole('heading', { name: 'پیشنهادهای امروز', exact: true })                    |     6 | dashboard.spec.ts:1907, guest.spec.ts:540, guest.spec.ts:614                                                                                                                                | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 20. Locator: getByRole('button', { name: 'شروع اسکن', exact: true })                            |     2 | dashboard.spec.ts:2087                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 21. waiting for getByRole('menuitem', { name: 'خروج از حساب' })                                 |     1 | dashboard.spec.ts:984                                                                                                                                                                       | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 22. waiting for getByRole('menuitem', { name: 'مدیریت موقعیت‌ها', exact: true })                |     2 | dashboard.spec.ts:1183, dashboard.spec.ts:1233                                                                                                                                              | Suspected test expectation mismatch | Compare current accessible entry flow and fixture setup, reproduce, then preserve behavior assertions with current selectors. |
| 23. waiting for getByRole('button', { name: 'اسکن تخفیف‌ها', exact: true }).last()              |     1 | dashboard.spec.ts:2051                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 24. Locator: getByRole('dialog', { name: 'جزئیات آدرس', exact: true }).locator('.location-map') |     2 | guest.spec.ts:154                                                                                                                                                                           | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 25. Error: expect(received).not.toBe(expected) // Object.is equality                            |     1 | guest.spec.ts:287                                                                                                                                                                           | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 26. Error: expect(received).toHaveLength(expected)                                              |     1 | guest.spec.ts:415                                                                                                                                                                           | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 27. Locator: getByRole('region', { name: 'نقشه انتخاب موقعیت در تهران' })                       |     2 | guest.spec.ts:471                                                                                                                                                                           | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 28. Error: expect(received).toBe(expected) // Object.is equality                                |     2 | guest.spec.ts:576                                                                                                                                                                           | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 29. Locator: locator('.tutorial-spotlight')                                                     |     4 | guest.spec.ts:726, guest.spec.ts:964                                                                                                                                                        | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 30. Locator: getByRole('heading', { name: 'صفحه نخست', exact: true })                           |     6 | paged-feed.spec.ts:134, paged-feed.spec.ts:167, paged-feed.spec.ts:260                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 31. waiting for getByText('مقایسه فروشگاه‌ها').first()                                          |     2 | paged-feed.spec.ts:318                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |
| 32. waiting for getByRole('button', { name: /^نمایش محصولات بیشتر/ })                           |     2 | paged-feed.spec.ts:342                                                                                                                                                                      | Unknown                             | Inspect trace and fixture responses, reproduce this group, and determine whether application or test requires correction.     |

## Individual failing cases

- desktop alerts.spec.ts:371 — product deep link survives phone sign in
- desktop alerts.spec.ts:399 — scan deep link restores the scan location and source
- mobile alerts.spec.ts:277 — wishlist CRUD, independent scan location, and disabled setup banner
- mobile alerts.spec.ts:371 — product deep link survives phone sign in
- mobile alerts.spec.ts:399 — scan deep link restores the scan location and source
- desktop dashboard.spec.ts:322 — enhanced scan feedback distinguishes searching, measured progress and completion
- desktop dashboard.spec.ts:473 — first visit creates a location from address search and maps the selected result
- desktop dashboard.spec.ts:545 — address search lets users choose a result and refine the map location
- desktop dashboard.spec.ts:587 — location reads recover and out-of-area saved locations remain editable
- desktop dashboard.spec.ts:628 — selected-provider scans use the 15 percent collection floor with no mode choice or duplicate submits
- desktop dashboard.spec.ts:663 — account-wide running scans remain discoverable in another location and stop at terminal status
- desktop dashboard.spec.ts:699 — status transport failure retains the server status and recovers without marking failed
- desktop dashboard.spec.ts:726 — transient result GET recovers within the bounded retry count
- desktop dashboard.spec.ts:742 — persistent result failures show recovery after success and retry the same saved scan without POST
- desktop dashboard.spec.ts:771 — the feed reads one product projection without downloading raw offers
- desktop dashboard.spec.ts:785 — background result failures preserve this context's cached snapshot and clear on recovery
- desktop dashboard.spec.ts:811 — permanent or invalid result HTTP 401 is not retried
- desktop dashboard.spec.ts:811 — permanent or invalid result HTTP 403 is not retried
- desktop dashboard.spec.ts:811 — permanent or invalid result HTTP 404 is not retried
- desktop dashboard.spec.ts:811 — permanent or invalid result HTTP 422 is not retried
- desktop dashboard.spec.ts:811 — permanent or invalid result HTTP 200 is not retried
- desktop dashboard.spec.ts:831 — long Retry-After prevents rapid repeated requests
- desktop dashboard.spec.ts:849 — a lost start response reconciles a known scan with one POST
- desktop dashboard.spec.ts:878 — an unknown start retains its intent after fresh reads and an explicit resend
- desktop dashboard.spec.ts:906 — reconciliation failure keeps duplicate start blocked until the authenticated read recovers
- desktop dashboard.spec.ts:946 — late ledger responses cannot cross the source boundary
- desktop dashboard.spec.ts:984 — sign-out retires reads and another account cannot see late private results
- desktop dashboard.spec.ts:1039 — reconnect refreshes stale failed reads without another scan submission
- desktop dashboard.spec.ts:1061 — successful empty results, filter-empty results, and loading have distinct copy
- desktop dashboard.spec.ts:1093 — history identifies context and retains Jet results without new Jet scans
- desktop dashboard.spec.ts:1160 — a failed scan retains the previous snapshot and repeating it is an explicit new scan
- desktop dashboard.spec.ts:1183 — location editing and deletion restore selection with keyboard-accessible dialogs
- desktop dashboard.spec.ts:1233 — location list, edit and create replace content in the same dialog and discard cancelled drafts
- desktop dashboard.spec.ts:1299 — saved feed supports search, sorting, inline discount filtering and accessible details without collection
- desktop dashboard.spec.ts:1344 — best offer uses one store and historical offers never win the current price
- desktop dashboard.spec.ts:1382 — appearance menu changes and persists light, dark and system themes
- desktop dashboard.spec.ts:1448 — layouts, theme preference, long content, broken images and reduced motion are inspected
- desktop dashboard.spec.ts:1527 — capture state views, real retailer images, touch targets, focus and token contrast
- desktop dashboard.spec.ts:1760 — small mobile keyboard viewport keeps location forms and filters usable
- desktop dashboard.spec.ts:1792 — map selection stays usable when the visual tile service fails
- desktop dashboard.spec.ts:1907 — shopping workspace has right sidebar and compact result toolbar
- desktop dashboard.spec.ts:2087 — Fresh DigiKala history does not block scan setup
- mobile dashboard.spec.ts:322 — enhanced scan feedback distinguishes searching, measured progress and completion
- mobile dashboard.spec.ts:473 — first visit creates a location from address search and maps the selected result
- mobile dashboard.spec.ts:545 — address search lets users choose a result and refine the map location
- mobile dashboard.spec.ts:587 — location reads recover and out-of-area saved locations remain editable
- mobile dashboard.spec.ts:628 — selected-provider scans use the 15 percent collection floor with no mode choice or duplicate submits
- mobile dashboard.spec.ts:663 — account-wide running scans remain discoverable in another location and stop at terminal status
- mobile dashboard.spec.ts:699 — status transport failure retains the server status and recovers without marking failed
- mobile dashboard.spec.ts:726 — transient result GET recovers within the bounded retry count
- mobile dashboard.spec.ts:742 — persistent result failures show recovery after success and retry the same saved scan without POST
- mobile dashboard.spec.ts:771 — the feed reads one product projection without downloading raw offers
- mobile dashboard.spec.ts:785 — background result failures preserve this context's cached snapshot and clear on recovery
- mobile dashboard.spec.ts:811 — permanent or invalid result HTTP 401 is not retried
- mobile dashboard.spec.ts:811 — permanent or invalid result HTTP 403 is not retried
- mobile dashboard.spec.ts:811 — permanent or invalid result HTTP 404 is not retried
- mobile dashboard.spec.ts:811 — permanent or invalid result HTTP 422 is not retried
- mobile dashboard.spec.ts:811 — permanent or invalid result HTTP 200 is not retried
- mobile dashboard.spec.ts:831 — long Retry-After prevents rapid repeated requests
- mobile dashboard.spec.ts:849 — a lost start response reconciles a known scan with one POST
- mobile dashboard.spec.ts:878 — an unknown start retains its intent after fresh reads and an explicit resend
- mobile dashboard.spec.ts:906 — reconciliation failure keeps duplicate start blocked until the authenticated read recovers
- mobile dashboard.spec.ts:946 — late ledger responses cannot cross the source boundary
- mobile dashboard.spec.ts:984 — sign-out retires reads and another account cannot see late private results
- mobile dashboard.spec.ts:1039 — reconnect refreshes stale failed reads without another scan submission
- mobile dashboard.spec.ts:1061 — successful empty results, filter-empty results, and loading have distinct copy
- mobile dashboard.spec.ts:1093 — history identifies context and retains Jet results without new Jet scans
- mobile dashboard.spec.ts:1160 — a failed scan retains the previous snapshot and repeating it is an explicit new scan
- mobile dashboard.spec.ts:1183 — location editing and deletion restore selection with keyboard-accessible dialogs
- mobile dashboard.spec.ts:1233 — location list, edit and create replace content in the same dialog and discard cancelled drafts
- mobile dashboard.spec.ts:1299 — saved feed supports search, sorting, inline discount filtering and accessible details without collection
- mobile dashboard.spec.ts:1344 — best offer uses one store and historical offers never win the current price
- mobile dashboard.spec.ts:1382 — appearance menu changes and persists light, dark and system themes
- mobile dashboard.spec.ts:1448 — layouts, theme preference, long content, broken images and reduced motion are inspected
- mobile dashboard.spec.ts:1527 — capture state views, real retailer images, touch targets, focus and token contrast
- mobile dashboard.spec.ts:1760 — small mobile keyboard viewport keeps location forms and filters usable
- mobile dashboard.spec.ts:1792 — map selection stays usable when the visual tile service fails
- mobile dashboard.spec.ts:1907 — shopping workspace has right sidebar and compact result toolbar
- mobile dashboard.spec.ts:2051 — temporary history failure recovers automatically and unblocks scanning
- mobile dashboard.spec.ts:2087 — Fresh DigiKala history does not block scan setup
- desktop guest.spec.ts:154 — location editor handles long addresses and saves the current-location choice
- desktop guest.spec.ts:287 — map flow supports browser location and panning the fixed pin
- desktop guest.spec.ts:325 — saved locations resolve map addresses and restore cached addresses after refresh
- desktop guest.spec.ts:378 — saved address list edits details, cancels deletion and confirms deletion
- desktop guest.spec.ts:415 — address autocomplete debounces, requires three characters, and cancels stale requests
- desktop guest.spec.ts:471 — location map uses matching themes and keeps the canvas when appearance changes
- desktop guest.spec.ts:540 — blocked browser storage still allows guest exploration
- desktop guest.spec.ts:576 — guests restore browser location and start manual scans without private requests
- desktop guest.spec.ts:614 — guest location survives refresh and imports once after login
- desktop guest.spec.ts:726 — interactive guide waits for location save and explicit scan then finishes at results
- desktop guest.spec.ts:964 — dark guide clearly spotlights the location control and removes the blur on skip
- mobile guest.spec.ts:154 — location editor handles long addresses and saves the current-location choice
- mobile guest.spec.ts:325 — saved locations resolve map addresses and restore cached addresses after refresh
- mobile guest.spec.ts:378 — saved address list edits details, cancels deletion and confirms deletion
- mobile guest.spec.ts:471 — location map uses matching themes and keeps the canvas when appearance changes
- mobile guest.spec.ts:540 — blocked browser storage still allows guest exploration
- mobile guest.spec.ts:576 — guests restore browser location and start manual scans without private requests
- mobile guest.spec.ts:614 — guest location survives refresh and imports once after login
- mobile guest.spec.ts:726 — interactive guide waits for location save and explicit scan then finishes at results
- mobile guest.spec.ts:964 — dark guide clearly spotlights the location control and removes the blur on skip
- desktop paged-feed.spec.ts:134 — saved pages, server search and store disclosure are read-only
- desktop paged-feed.spec.ts:167 — cancelling an active update preserves the saved feed and stops polling
- desktop paged-feed.spec.ts:206 — an ambiguous start explicitly resends the same UUID and request
- desktop paged-feed.spec.ts:260 — a failed next product page retains the exact already loaded rows
- desktop paged-feed.spec.ts:281 — all loaded baseline pages remain when a successful update cannot be read
- desktop paged-feed.spec.ts:318 — a failed store page retains loaded offers and only retries a saved GET
- desktop paged-feed.spec.ts:342 — saved navigation passes twenty pages with a bounded retained window
- mobile paged-feed.spec.ts:134 — saved pages, server search and store disclosure are read-only
- mobile paged-feed.spec.ts:167 — cancelling an active update preserves the saved feed and stops polling
- mobile paged-feed.spec.ts:206 — an ambiguous start explicitly resends the same UUID and request
- mobile paged-feed.spec.ts:260 — a failed next product page retains the exact already loaded rows
- mobile paged-feed.spec.ts:281 — all loaded baseline pages remain when a successful update cannot be read
- mobile paged-feed.spec.ts:318 — a failed store page retains loaded offers and only retries a saved GET
- mobile paged-feed.spec.ts:342 — saved navigation passes twenty pages with a bounded retained window
