# Better Buy design system

## Enhancement pass (2026-11-15)

The practical tutorial uses a solid purple surface (#5531b5 light, #6941cf dark), white copy, and a white Skip button. A viewport spotlight dims unrelated content by 48% and blurs it by 5px, leaving the guide and the current step’s working controls clear. Cutouts follow scroll, resize, and dialog changes without moving controls out of their existing focus context. Target controls use a 4px #9b79ff outline; no repeating animation is used.

The delivery map uses a locally defined 13-layer OpenMapTiles style over OpenFreeMap vector tiles, replacing the stock 55-layer Positron style. Light uses cool neutral land, quiet green parks, and clear streets; dark uses charcoal land and appropriately contrasting roads and labels. Building footprints appear only at zoom 16 and above. Road-reference shields, house numbers, POI icons, and sprite downloads are omitted; Persian/local street names and neighborhood labels remain. The map follows system/manual appearance without replacing its canvas, marker, selected point, or camera. Controls use shared surface/focus tokens and 44px zoom targets. Device pixel ratio is capped at two to reduce high-DPI rendering cost. No network-latency improvement is assumed from these rendering and request-count reductions.

Guest mode opens the same working interface by default. A compact fixed top banner (64px desktop, 56px mobile) uses saturated purple #6334c5, white bold copy, and a white sign-in button. A matching flow spacer keeps content clear of it; desktop excludes the sidebar width and mobile omits the supporting line. The banner invites sign-in to save favorite items, follow their discounts, and keep a cart for later, without browser-storage or retention jargon. Contextual, dismissible live-region notices accompany guest scanning. Account-only actions take guests directly to login. The banner leaves room for the existing desktop sidebar and stacks above mobile content. Notices clear after eight seconds, retain an explicit close action, and never steal keyboard focus. Account-only controls take guests directly to the login page. Location-import failures remain inline with a retry action; successful imports are announced. Login uses one saturated purple primary submit button. Password recovery sits beside the password label, registration is an inline prompt, and guest browsing is a quiet text action beneath a compact divider. The guest action retains a 48px target without a filled background. The password visibility button sits inside the input with a brief blink on activation, disabled under reduced motion. Authentication placeholders use neutral gray (#90949e light, #a4a7af dark) at 72% opacity and normal weight; entered values retain the existing text color.

The current implementation retains its lavender identity, local IRANSansX typography, RTL reading order, routes, and navigation. The brief is refinement with character, not removal of visual interest. Design variance is 6, motion intensity 4, and visual density 4 for sign-in; the working interface remains more compact.

Authentication pairs a concise shopping introduction and a lavender shopping-list receipt with a working form. The receipt is explicitly labelled as a sample and lists supermarket staples (milk, cheese, biscuits, and chips), without invented prices or savings claims. Its restrained tilt, perforated edge, and dashed separators provide paper detail rather than a fake product preview. Desktop uses an asymmetric split; mobile keeps the brand and short introduction above the form and omits the receipt to preserve immediate access. Lavender, neutral surfaces, and local typography carry through both themes. The receipt has paper-like 4px corners, forms use 16px corners, and controls use the existing control token.

Running scans have a compact searching symbol and a real progress track with completed/total counts. Unknown totals use an explicitly indeterminate searching track without a numeric value, not a fabricated percentage. Completion gets a brief check-mark arrival, while provider counts, results actions, and recovery stay visible. Scan activity communicates ongoing work; completion movement confirms the state change. These effects animate only transform and opacity and become static under reduced motion. Existing product photography and all operational behavior remain.

The older audit and token table below describe a previous design revision and are not an exact inventory of the current sidebar layout or lavender tokens.

Better Buy is a Persian RTL grocery-offer comparison tool. The design is a compact utility: location, retailer, one scan action, and saved observations. The existing «ب» identity mark and Better Buy name remain. Local IRANSansX FaNum remains the only font family. There is no marketing hero, decorative photography, animated scanning machinery, or permanent navigation rail.

## Direction and audit

| Before                                           | After                                                                         | Why                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Permanent dark location rail                     | Compact header; location management in a Radix panel                          | Give comparisons the main content area                          |
| Retailer connection settings                     | Concise help panel; retailer selector stays visible                           | Snapp and Okala require no customer setup                       |
| Repeated desktop/mobile/empty-state scan buttons | One action in the context controls                                            | Prevent competing calls to action and covered mobile content    |
| Animated scan strip                              | Account-wide text status with its actual context                              | Communicate work and preserve discoverability across navigation |
| Four oversized summary tiles                     | Compact feed-state filters and counts                                         | Make comparison actionable without inflating statistics         |
| Vendor-chip wall                                 | Native keyboard-accessible offer disclosure                                   | Keep the best offer legible and other store prices available    |
| Result failures look empty                       | Loading, error, cached refresh failure, loaded empty, and filter-empty states | Truthful recovery without starting another scan                 |
| Partial/full choice                              | Omitted from new scans; historical mode remains readable                      | Both active collectors ignore mode                              |

## Tokens and layout

| Role                   | Light     | Dark      |
| ---------------------- | --------- | --------- |
| Canvas                 | `#f7f8fa` | `#171a20` |
| Surface                | `#ffffff` | `#20252d` |
| Text                   | `#20242b` | `#f0f2f5` |
| Secondary text         | `#59616e` | `#b1b9c6` |
| Divider/control border | `#d7dce3` | `#434c5b` |
| Action / focus         | `#b84313` | `#ffb18a` |
| Action text            | `#ffffff` | `#382013` |
| Error text             | `#b42332` | `#ffabb3` |
| Status text            | `#266047` | `#ace0c5` |

The header's «ظاهر» menu selects light, dark, or system appearance through the existing ThemeProvider. The choice is saved in the browser; system appearance is the default. Product images keep a white image well for source fidelity. Semantic colors always accompany text.

Body is 14px with 1.85 line height; metadata 12–13px, product title 16px (14px on narrow screens), page title 24px (21px on mobile), price 19px (18px on mobile). Spacing steps are 4/8/12/16/24/32px. Controls use 8px corners, content surfaces 12px, and the retained brand mark 10px. Controls and disclosure summaries are at least 44px tall. Overlay/panel/menu layers are 40/41/50.

The header is capped at 1440px and the workspace at 1120px. Context controls precede results; search, sort, and comparison filters remain near the list. At 768px the layout compresses, and at 520px controls and price blocks stack. Nothing is fixed over result content. Dialogs use `100dvh` bounds and scroll within their own surface for small screens/keyboards. CSS uses logical properties and text is isolated with `bdi`; coordinates use LTR inputs. Money display retains shared provider-specific units.

Only short color/border transitions are used. No recurring list animation, custom polling timers, or direct frontend React effects. Reduced motion removes transitions. Hover styles are gated to a fine pointer. Keyboard focus uses a 3px visible ring. Dialogs and nested deletion confirmations use existing Radix Dialog/AlertDialog portals, focus containment/restoration, and Escape behavior. Vendor comparisons use native `details`/`summary`.

## Product semantics

The price, original price, discount, and vendor name all come from the same cheapest current offer. Disappeared offers cannot win a current price; an entirely historical group is labelled with a historical price. Expanded offers put current observations first, ordered by price. Group identities and v1 grouping remain unchanged and provider-specific.

Feed labels are «پیشنهادهای جدید», «در فهرست فعلی», and «دیگر در این فهرست نیست». These describe the feed comparison, not universal availability. Okala coverage is explained once near its results and in help. Scan progress counts distinct inspected stores; no percentage or ETA is invented. New scans default to 40%, and threshold lives behind «گزینه‌های اسکن». Historical scans preserve their original thresholds and modes, including Jet history.

### Provider cart extension

The provider basket is reached from a compact button in the sticky application header, not embedded in the results list. On mobile, the brand and icon-only cart button share the first row; navigation sits below in one horizontally scrollable row. The button retains its provider and count in its accessible name. It opens an RTL side drawer on desktop and a full-screen drawer on mobile. The drawer keeps its title and close action at the top, an independently scrolling body, and the observed subtotal plus a continue-choosing action in a persistent footer. Store assignments group editable product rows; products without an assignment remain in a separate editable section. Store names lead their groups, with the observed subtotal directly beneath. Product titles use secondary text color. A compact segmented stepper displays minus while quantity is above one and an icon-only remove action in the same leading control at quantity one. This avoids a separate delete button while keeping deletion accessible by name. All controls retain the shared 44px minimum target. The extension uses the existing compact workspace, IRANSansX FaNum, semantic surface and focus tokens, and logical CSS properties.

The recommendation first shows whether one observed store covers the basket. When a split is needed, it shows assignments across the fewest stores the search can prove, with per-store totals. Missing items and an explicit note appear when coverage is partial or the search cannot prove a minimum. Displayed prices come from the selected location's latest compatible successful scan and retain its observation time and promotional-feed coverage; they do not imply universal stock or purchasing. A returned store logo may appear in its neutral image well; missing or failed logos use a quiet initial fallback.

## Requested design sources

Installed Emil and Taste skills were discovered and read first. Exact upstream sources were then read at these repository revisions on 2026-10-08; the missing Anthropic skill was fetched to a temporary reference directory, with no global installation or setup commands:

- Emil: [emil-design-eng](https://github.com/emilkowalski/skills/blob/e8a175de22ae1e49370fc144c1f3bb9aeedf988d/skills/emil-design-eng/SKILL.md), revision `e8a175de22ae1e49370fc144c1f3bb9aeedf988d`.
- Anthropic: [frontend-design](https://github.com/anthropics/skills/blob/683bc88e56f3e09ba94f7055977f3d3aa499f202/skills/frontend-design/SKILL.md), revision `683bc88e56f3e09ba94f7055977f3d3aa499f202`.
- Leon: [design-taste-frontend](https://github.com/leonxlnx/taste-skill/blob/b482f7a970abb98c4108d4a9f761e458c64cefc8/skills/taste-skill/SKILL.md), revision `b482f7a970abb98c4108d4a9f761e458c64cefc8`. The current source resolves to `skills/taste-skill/SKILL.md`.

Emil leads feedback/accessibility/restraint; Anthropic leads deliberate tokens, functional copy, and self-critique. Taste explicitly excludes dashboards and multi-step product UI, so only its audit-first process and applicable principles are used. User overrides are variance 3 / motion 2 / density 4. No marketing presets, Latin typography requirements, image-generation requirements, or Impeccable were applied.

## Visual evidence

Local evidence is kept in ignored `.data/design-evidence/`: real before/after browser screenshots, responsive/theme/state captures, and three public Okala image references. Before/after comparison uses controlled representative Persian grocery data; prices and account/session responses are fixtures. The public image lookup is a separate read-only live observation, not a production application scan. Browser transport fixtures do not reproduce TLS negotiation. See README for behavioral validation and limitations.

The results toolbar gives search the flexible leading column, with matched 44px filter controls. The inset magnifier makes a brief searching movement on focus and typing, repeats only while a search read is fetching, and stays static under reduced motion. Clearing uses an inline 44px icon target without adding another toolbar row.
