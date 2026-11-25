# Mobile observability foundation

Status: provisional. This is not an M1 completion. It stays open until CTO integration review.

Branch `mobile/m1-observability` starts from commit `460c876` (`mobile/m0-engine` / `main`). V1 is Android-only. iOS compilation, signing, and device work stay deferred. No retailer was contacted. No infrastructure was provisioned. No monitoring vendor was purchased. `@sentry/react-native` and its Gradle plugin were not added.

The other engineer owns Android native execution, physical-device verification, performance, the Android build scripts, and the Go collection algorithm. Shared engine and Kotlin bridge changes below are a proposed interface. Those files were not edited.

## Architecture

Observability is a small TypeScript library at `apps/mobile/src/observability`. It does not import React Native or a monitoring SDK. The app uses one singleton. Tests use `createObservability()` with an injected clock, random source, fetch, and monitor.

```text
Go slog ring (unchanged, in memory, 32 events)
        |
Kotlin logcat bridge_status (unchanged; not copied into the journal)
        |
TypeScript poll in diagnostics.tsx
        |
allowlisted DiagnosticEvent
        |-- in-memory journal (32)
        |-- optional SQLite diagnostic_event (32, best effort)
        |-- on-demand export (Share)
        `-- optional Monitor (off until expo.extra says so)
```

What already existed and was reused:

| Piece                           | Where                                                                                                                             | What this work did                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Go `slog` JSON ring             | `apps/mobile/engine/engine.go`                                                                                                    | Left in place. Export maps known messages onto the schema.                                 |
| Kotlin `BetterBuyEngine` logcat | `BetterBuyEngineModule.kt`                                                                                                        | Left in place. Not parsed.                                                                 |
| Scan id                         | 32 lowercase hex from Go `Start`                                                                                                  | Accepted only when it matches `^[0-9a-f]{32}$`.                                            |
| Diagnostics screen and SQLite   | `src/diagnostics.tsx`, `app/index.tsx`, `engine-lab.db`                                                                           | Kept `last_fixture`. Added a bounded `diagnostic_event` table, journal mirror, and export. |
| Error codes                     | `OK`, `BUSY`, `ENGINE_INIT_FAILED`, `FIXTURE_ERROR`, `DIAGNOSTICS_READ_FAILED`, `DIAGNOSTICS_INIT_FAILED`, `NATIVE_BRIDGE_FAILED` | Kept. New codes are listed below.                                                          |
| Sentry preparation              | Architecture note: remote monitoring off, no SDK                                                                                  | Kept the SDK out. Added a vendor-neutral monitor interface.                                |

`record()` never throws. Listeners that throw are skipped. A monitor that throws is wrapped so the scan poll and the SQLite fixture write continue. Remote delivery is not awaited by scan or persistence.

The local journal and the outbound queue are separate. Both cap at 32 events and keep the newest records. Process death drops the outbound queue. The SQLite copy of the journal remains. A failed POST leaves the batch in the outbound queue. `monitoring().outbound` is the queued count. `monitor_delivery_failed` is stored locally and is never shipped, so a delivery failure cannot recurse.

`provider: "sentry"` does not POST a DSN and does not call fetch. It writes one local warning, `MONITOR_UNAVAILABLE` / `monitor_delivery_failed`, with `emit` false so the SQLite mirror and `ship` are not re-entered.

## Structured event schema

Every stored and exported record is built by allowlist. Unknown fields are dropped. Times are UTC ISO-8601 from `Date.toISOString()`.

| Field               | Rule                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `time`              | Required. UTC timestamp.                                                                                  |
| `level`             | Required. `DEBUG`, `INFO`, `WARN`, `ERROR`.                                                               |
| `event`             | Required. One of the names below.                                                                         |
| `appVersion`        | Required. From Expo `version` (`0.1.0` in the lab).                                                       |
| `code`              | Optional stable code. Unknown strings are dropped.                                                        |
| `scanId`            | Optional. Only `/^[0-9a-f]{32}$/`. Anything else, including a phone-shaped string, is dropped.            |
| `engineVersion`     | Optional. `/^[0-9A-Za-z.+_-]{1,32}$/`.                                                                    |
| `osVersion`         | Optional. `/^[a-z0-9 ._-]{1,40}$/i`. On Android the diagnostics layer sets `android ${Platform.Version}`. |
| `durationMs`        | Optional integer, 0 through 86,400,000.                                                                   |
| `requestCount`      | Optional integer, 0 through 1,000,000.                                                                    |
| `provider`, `stage` | Optional. `/^[a-z0-9_-]{1,32}$/` after lowercasing.                                                       |
| `httpStatus`        | Optional integer, 100 through 599.                                                                        |
| `coverage`          | Optional. `complete`, `incomplete`, or `unknown`.                                                         |
| `message`           | Optional. Scrubbed, single line, at most 180 characters.                                                  |

Event names:

| Name                      | When the helper emits it                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `scan_started`            | INFO.                                                                                              |
| `scan_completed`          | INFO, or WARN with code `COVERAGE_INCOMPLETE` when coverage is `incomplete`.                       |
| `coverage_incomplete`     | Extra WARN emitted only beside an incomplete `scan_completed`. A complete scan does not emit this. |
| `scan_failed`             | ERROR. Requires a code.                                                                            |
| `scan_cancelled`          | INFO.                                                                                              |
| `auth_rejected`           | ERROR. Code `AUTH_REJECTED`. Default HTTP status 401.                                              |
| `network_timeout`         | ERROR. Code `NETWORK_TIMEOUT`.                                                                     |
| `pagination_failed`       | ERROR. Code `PAGINATION_FAILED`.                                                                   |
| `database_write_failed`   | ERROR. Code `DATABASE_WRITE_FAILED`.                                                               |
| `controlled_error`        | ERROR. Code `FIXTURE_ERROR`.                                                                       |
| `fixture_persisted`       | INFO. SQLite `last_fixture` write duration.                                                        |
| `lifecycle`               | Bridge and screen events that are not a scan outcome.                                              |
| `engine_log`              | Go slog row whose message is not one of the known fixture messages.                                |
| `monitor_delivery_failed` | Local only. Never sent to a remote monitor.                                                        |

A future dashboard distinguishes a complete scan from a successful but incomplete one by the pair of events, not by offer count. Zero in-stock rows is not incomplete coverage. The fixture engine has no coverage field. The diagnostics poll records native state `complete` as `coverage: "complete"` because the fixture walk covers every fixture row. That must not be read as retailer-catalog coverage.

### Go slog mapping

`Logs()` stays a JSON array of raw slog objects. `normalizeEngineLog` copies only allowlisted fields:

| Go `msg` and `state`                       | Event              | Coverage   |
| ------------------------------------------ | ------------------ | ---------- |
| `fixture started`                          | `scan_started`     | omitted    |
| `fixture finished` and `state` `complete`  | `scan_completed`   | `complete` |
| `fixture finished` and `state` `cancelled` | `scan_cancelled`   | `unknown`  |
| `fixture finished` otherwise               | `scan_completed`   | omitted    |
| `controlled error`                         | `controlled_error` | omitted    |
| anything else                              | `engine_log`       | omitted    |

Known fixture messages get `provider` and `stage` `fixture`. `offers`, `responseBody`, and any other extra key are not copied.

### Proposed engine and bridge fields

Not applied. Coordinate before editing `engine.go`, `engine_test.go`, or `BetterBuyEngineModule.kt`.

Go slog today emits `time`, `level`, `msg`, `engineVersion`, and, on scan events, `scanId`, `code`, `state`, `durationMs`, `requestCount`. The ring size is 32. `TestDiagnosticExportIsBounded` expects controlled-error objects to contain only `time`, `level`, `msg`, `engineVersion`, and `code`.

Proposed additive slog fields, still without raw bodies or coordinates: `provider`, `stage`, `httpStatus`, and `coverage` (`complete` | `incomplete` | `unknown`). Keep the existing keys so the current Go test still passes. UTC timestamps and the existing level names already match this schema.

Kotlin logcat today, tag `BetterBuyEngine`, emits `{event: bridge_status, scanId, state, engineVersion, mainThread: false}` for `running`, `complete`, and `cancelled` when the scan id is 32 hex, plus `NATIVE_THREAD_VIOLATION` when work is scheduled on the main thread. Proposed: add `level`, `code`, `osVersion`, `durationMs`, and `requestCount` to that same object. Do not log tokens, cookies, or response bodies. The TypeScript journal does not read logcat; the screen still uses the Go `logs()` export.

## Error taxonomy

| Code                      | Meaning                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `OK`                      | Engine accepted the fixture start. The screen does not emit a failure.                                       |
| `BUSY`                    | A scan is already running. Recorded as a lifecycle warning.                                                  |
| `ENGINE_INIT_FAILED`      | Go refused to start. Recorded as `scan_failed`.                                                              |
| `ENGINE_UNAVAILABLE`      | The native module is absent. Lifecycle warning.                                                              |
| `FIXTURE_ERROR`           | Controlled engine error.                                                                                     |
| `DIAGNOSTICS_READ_FAILED` | Status poll failed. Noted once until the next successful poll.                                               |
| `DIAGNOSTICS_INIT_FAILED` | Diagnostics startup failed.                                                                                  |
| `NATIVE_BRIDGE_FAILED`    | A bridge call threw, or start returned an unexpected code.                                                   |
| `EXPORT_FAILED`           | The share sheet failed.                                                                                      |
| `AUTH_REJECTED`           | Provider authentication rejected. No token is stored.                                                        |
| `NETWORK_TIMEOUT`         | Collection timed out.                                                                                        |
| `PAGINATION_FAILED`       | A page request failed.                                                                                       |
| `DATABASE_WRITE_FAILED`   | Local SQLite write failed. The mirror skips this code so a write failure cannot loop.                        |
| `COVERAGE_INCOMPLETE`     | The scan finished and coverage was reported incomplete.                                                      |
| `MONITOR_DELIVERY_FAILED` | Reserved for an explicit delivery failure record.                                                            |
| `MONITOR_UNAVAILABLE`     | Remote reporting was enabled but no linked transport exists. Sentry uses this until a reviewed SDK is added. |

Provider-health helpers exist for authentication, timeout, pagination, and database failure. The fixture engine does not call them, because it does not perform retailer requests. Callers pass `provider` and `stage` when a real collector exists.

## Monitoring provider evaluation

Remote reporting is behind `Monitor.capture`. The default provider is `none` and `enabled` is false. Changing provider does not require a scan-path change.

### Sentry (not installed)

Evaluated for React Native and Android native crashes. Not wired, because the current Expo config plugin rewrites Android Gradle files owned by the other engineer.

| Question                | Finding                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expo SDK compatibility  | `@sentry/react-native` is the supported package for Expo SDK 50 and later. `sentry-expo` is deprecated. A Sentry sample update in May 2026 moved an Expo sample to SDK 56, React Native 0.85.3, and React 19.2.3, which matches this app (Expo 56.0.24, RN 0.85.3, React 19.2.3).                                                                                                       |
| JavaScript exceptions   | Documented path is `Sentry.wrap` plus the Expo Router integration. Not executed here.                                                                                                                                                                                                                                                                                                   |
| Native crashes          | Android and NDK crashes need the Gradle upload step. That step was not added.                                                                                                                                                                                                                                                                                                           |
| Go engine failures      | slog and `FIXTURE_ERROR` are not automatic Sentry events. They must be captured explicitly through the existing bridge. This library already records them locally.                                                                                                                                                                                                                      |
| Source maps and symbols | Current docs require `@sentry/react-native/expo` and `@sentry/expo-upload-sourcemaps`, plus an auth token. A 24 November 2026 Sentry note says SDK 56 native fetch is tracked. None of that is configured.                                                                                                                                                                              |
| Offline buffering       | Sentry SDKs buffer offline. This app does not use that buffer. Its own HTTPS monitor keeps at most 32 events in memory until a POST succeeds.                                                                                                                                                                                                                                           |
| Sampling                | `sampleRate` is 0 through 1, default 1. It applies only to remote delivery. `ERROR` always uses rate 1 when a transport is linked. Local journal is unsampled.                                                                                                                                                                                                                          |
| Network and battery     | No SDK means no Sentry network or battery cost. The HTTPS monitor uses batches of 10, `content-type: application/json`, and `AbortSignal.timeout(3000)` when the runtime provides it. Delivery is fire-and-forget. On-device cost was not measured.                                                                                                                                     |
| Free tier               | A free Developer plan exists. Exact event quotas were not copied into this repo and were not relied on.                                                                                                                                                                                                                                                                                 |
| Iranian networks        | On 25 November 2026 this Windows host received HTTP 200 from `https://sentry.io/pricing/` and reached `https://o0.ingest.sentry.io/api/0/envelope/` (HTTP 404 on that dummy path, so the host was reachable). `https://www.arvancloud.ir/` returned 200. That is one development machine, not an Iranian mobile network. Do not treat it as a nationwide block or as nationwide access. |

Until a reviewed SDK lands, `provider: "sentry"` records `MONITOR_UNAVAILABLE` and opens no connection. Verified by unit test.

### Arvan Cloud fallback (not provisioned)

If Sentry cannot be reached from real devices, a minimal ingest can be an HTTPS POST of `{ "events": [ ...allowlisted records ] }` on existing Arvan infrastructure. `provider: "arvan"` uses the same `HttpMonitor` as `provider: "http"`. Arvan object storage uses hostnames of the form `s3.{region}.arvanstorage.ir` (example region `ir-thr-at1`). No bucket, endpoint, or key was created. An endpoint is accepted only when it is `https://`. No ingest secret is stored in the repo.

A non-OK response or a thrown fetch keeps the outbound queue. Scanning and `last_fixture` persistence do not wait on it.

## Privacy policy

Remote diagnostics are optional, non-blocking, and disabled until `expo.extra.observability.enabled` is exactly `true`.

Never collect or transmit:

- exact delivery coordinates (`lat`, `latitude`, `lng`, `lon`, `longitude`, `coordinates`)
- phone numbers (`phone`, `mobile`, `tel`, and Iranian mobile shapes)
- authentication tokens, bearer tokens, JWTs, `authorization`, passwords, secrets
- cookies and `set-cookie`
- shopping history
- raw retailer responses and response bodies
- persistent device identifiers (`deviceId`, `androidId`, `advertisingId`, `idfa`)

If a message contains one of those JSON keys, the whole message becomes `[redacted]`. Bearer tokens, JWT-shaped strings, phone numbers, and `cookie|token|authorization=value` assignments are scrubbed. Stack traces are not fields on the record. Offers stay on the on-screen lab snapshot and in the local `last_fixture` row. They are not part of the diagnostic export or the remote payload.

There is no advertising id and no extra persistent device id in this design.

## Diagnostics experience

The lab screen shows application version, engine version, OS version, whether remote monitoring is on, the provider name, scan id, state, progress, duration, and request count. The newest eight journal rows show level, event, code, and the first eight characters of the scan id.

Export builds:

```json
{
  "appVersion": "",
  "engineVersion": "",
  "osVersion": "",
  "monitoring": { "enabled": false, "provider": "none" },
  "events": [],
  "engineEvents": []
}
```

`events` is the sanitized journal. `engineEvents` is the normalized Go log. Share failures set `EXPORT_FAILED` and record a lifecycle event. They do not clear the journal.

Retention:

- Go ring: 32, in memory, unchanged.
- TypeScript journal: 32 (`JOURNAL_LIMIT`).
- SQLite `diagnostic_event`: newest 32 rows. Insert, then delete ids outside that window.
- Outbound monitor queue: 32, in memory only.
- Seen scan transitions: 96 keys, then the oldest key is dropped, so a React strict remount does not duplicate scan events.

Hydration runs once per process. It replaces the journal and does not re-ship. The SQLite mirror is attached once. Startup failure and a missing engine do not stop the screen from rendering.

## Configuration

`apps/mobile/app.json` ships with reporting off:

```json
"extra": {
  "observability": {
    "enabled": false,
    "provider": "none"
  }
}
```

`readMonitorConfig` rules:

- `enabled` is true only when the value is boolean `true`. An endpoint alone does not enable reporting.
- `provider` must be `none`, `http`, `sentry`, or `arvan`. Anything else becomes `none`.
- `endpoint` is kept only when it starts with `https://`.
- `sampleRate` is clamped to 0..1. Missing or non-numeric values default to 1.

To send to a future ingest after review, set `enabled` to true, `provider` to `http` or `arvan`, and `endpoint` to the HTTPS URL. Do not commit a DSN, auth token, or ingest key. `provider: "sentry"` stays a local stub until the SDK decision is reviewed with the Android build owner.

The lab script is `pnpm --filter @better-buy/mobile test:observability`. The test file is excluded from `tsc` and imports use `.ts` suffixes so Node can run it without `"type": "module"`. Node prints `MODULE_TYPELESS_PACKAGE_JSON`. That warning is accepted. Do not set `"type": "module"` on the app package; Metro is the app bundler.

## Test evidence

### Executed on this Windows host

Date: 25 November 2026. Command:

`node --test apps/mobile/src/observability/observability.test.ts`

Result: 10 passed, 0 failed. Node also printed `MODULE_TYPELESS_PACKAGE_JSON`.

`pnpm --filter @better-buy/mobile exec tsc --noEmit` exited 0. The test file is excluded from that project, so this checks the library, diagnostics screen, and app sources.

| Test                   | What it executed                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured scan events | Complete scan is one `scan_completed` with coverage `complete`. Incomplete scan also emits `coverage_incomplete`, with version, duration, request count, provider, and stage.                               |
| Stable codes           | `ENGINE_INIT_FAILED`, `AUTH_REJECTED` with HTTP 401, `NETWORK_TIMEOUT`, `PAGINATION_FAILED` with HTTP 500, `DATABASE_WRITE_FAILED`, `FIXTURE_ERROR`, and cancel with no code.                               |
| Redaction              | Phone-shaped scan id dropped. Provider value `Bearer …` dropped. JSON with token, phone, and latitude becomes `[redacted]`. `authorization=` and `cookie=` scrubbed. Export contains none of those secrets. |
| Retention              | 40 records become 32. Oldest dropped, newest kept.                                                                                                                                                          |
| Offline                | Thrown fetch leaves 2 events outbound. The scan helper still returns. A later flush sends them.                                                                                                             |
| Isolation              | A throwing monitor does not surface. A disabled monitor performs 0 fetches.                                                                                                                                 |
| Sampling               | `sampleRate` 0.1 with `random()` 0.9 ships only the ERROR for provider `arvan`.                                                                                                                             |
| Export                 | `fixture finished` becomes `scan_completed` with coverage `complete`. `offers`, `responseBody`, secrets, and store names are absent.                                                                        |
| Sentry stub            | Enabled `provider: "sentry"` performs 0 fetches and records `MONITOR_UNAVAILABLE`.                                                                                                                          |
| Config                 | Default is disabled. `http://` endpoints are rejected. `sampleRate` 4 becomes 1.                                                                                                                            |

### Not executed (proposed)

- On-device SQLite hydrate and the 32-row delete.
- The React diagnostics screen, Share sheet, and native module poll.
- Kotlin logcat and Go slog on a device or emulator.
- Sentry JavaScript exceptions, native crashes, source maps, and symbolication.
- Battery and network overhead.
- Reachability from an Iranian mobile network.
- A live or fixture retailer collection. No retailer request was made.
- The proposed Go and Kotlin fields.

## Remaining blockers

- CTO integration review. Do not treat this branch as M1-complete.
- Android build owner must accept any Sentry Gradle or Expo plugin before that SDK is added.
- Go and Kotlin owners must accept the proposed `provider`, `stage`, `httpStatus`, and `coverage` fields before those files change.
- No ingest endpoint exists. `http` and `arvan` stay inert without an explicit HTTPS endpoint and `enabled: true`.
- Physical Android verification of the diagnostics screen, SQLite retention, and native logs is outside this change set.
- Iranian mobile reachability of Sentry, and of any future Arvan ingest, is unmeasured.
- The accidental gomobile directory `apps/mobile/engine/$out` from the earlier iOS bind attempt is absent.
