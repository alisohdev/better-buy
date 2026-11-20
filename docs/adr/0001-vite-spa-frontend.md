# ADR 0001: Migrate the web frontend to a Vite SPA

- Status: Implemented locally; pending M0 review
- Date: 2026-11-18

## Context

The web product is a Persian RTL client application statically exported by Next.js. Its routes and deep links are currently selected in a single client page, while Go serves all application APIs and Caddy serves static output. The target is a small maintainable SPA with typed route state, route-level chunks, and no Node production server.

## Decision

Use Vite with React 19, TanStack Router's file-based route generation and automatic code splitting, TanStack Query, and the existing pnpm workspace. Keep production as static assets served by the existing Caddy installation. Use the official React Compiler Babel integration with the Vite React plugin in development and production. Keep Go/SQLite contracts unchanged.

## Consequences

- Caddy must provide SPA navigation fallback while preserving 404s for missing assets and existing API/health routes.
- Current query-string deep links, root-scoped service worker, manifest identity, cookies, and local API origin need explicit compatibility coverage.
- Route chunks can defer authenticated features and map code; bundle and browser measurements are required to verify the gain.
- Static hosting remains deployable and rollbackable by switching the active artifact directory; no Node runtime is added.
- Compiler optimization is accepted only with clean diagnostics or documented narrow exclusions and profile evidence.

## Alternatives rejected

- TanStack Start/SSR: adds a server runtime and infrastructure outside the objective.
- Keep Next and optimize only: does not satisfy the requested framework migration.
- Client-side route parsing without TanStack Router: duplicates search-state validation and lacks the requested route splitting workflow.
