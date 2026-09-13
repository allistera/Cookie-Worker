# Performance changes and rollout

Implemented across Cookie-Web, Cookie-Worker and Cookie-iOS. Migrations 0074 and 0075 were applied successfully on September 13, 2026; schema-dependent Workers are deployed before the updated frontend.

## Changes

- Web attachment uploads dynamically load the Blob client after validation. Production builds enforce budgets for the complete static entry/inbox/editor import graphs and emit `dist/bundle-budgets.json`.
- Email bodies publish immediately. The loading indicator appears only after 150 ms; a fast response never waits for it. Invitation enrichment uses the owned `/messages/calendar-invite?id=…` endpoint after the body renders. Older clients retain the combined response. Existing ICS size limits, parsing rules and private attachment protection remain in place.
- Inbox SQL takes bounded, independently ordered received/follow-up candidates before joining labels and calculating summary availability. Cursor timestamps preserve PostgreSQL microseconds through JSON and text-typed SQL parameters.
- Mail, document trees and starred document navigation use measured virtual rows with stable keys, scroll anchors and focused-row retention. Document and task views show 100 records per page. Task details fetch full descriptions and separately paged subtasks; paged Today reordering preserves existing position slots.
- Document metadata retains the complete folder hierarchy and global tag counts. A database revision changes on edits, moves and deletions, allowing unchanged refreshes to skip workspace downloads. Document pages are scoped by folder/star/tag, and local edits maintain page membership. Thin folder/tag metadata intentionally remains complete; the large document list is paginated.
- Offscreen spreadsheet/drawing blocks render lightweight previews. Visibility or interaction activates the editor. Activated instances live until document teardown, preserving edits while scrolling. Unactivated snapshots survive saves unchanged.
- iOS mail pagination now requires a user action, preventing empty categories from triggering an exhaustive scan. Document folders load pages on expansion. Immutable date format styles replace per-message mutable formatters and accept whole/fractional timestamps.
- Browser Performance Timeline entries cover route readiness, reader readiness, body fetch, search and document/task requests. Worker responses expose `Server-Timing`; mail list/count and body/thread/attachment/invite stages are separate. Sampled structured logs contain only service, method, status and duration, without URLs, identifiers or content.

## Validation

- Web: lint, formatting, the production build and all 1,150 unit tests passed. All 122 production-build Chromium scenarios passed with one worker, including editor readiness, offscreen snapshot preservation, plain-table persistence without spreadsheet requests and AI creation during navigation.
- Workers: all 1,544 unit tests, lint/formatting, every generated-type check, complete type checking and all dry runs passed. The shared stream reader tests cover early cancellation and UTF-8 across chunk boundaries.
- PostgreSQL 18: disposable local-schema integration checks pass for both migrations, completed/missing/pending/failed classification, microsecond cursors, ownership, document deletion revalidation, global metadata, full task details and bounded pages.
- Native: SwiftLint 0.65.1 reported zero violations; the macOS CI build and native tests passed for Cookie-iOS PR 2 before merge.

The entry dependency graph is about 425 kB, down from the earlier 529 kB baseline. Plain tables avoid loading the full spreadsheet runtime altogether; existing workbook and formula documents retain it. These are payload/lookup improvements, not production latency claims. The synthetic query comparison is recorded below.

## Deployment order

1. Apply Cookie-Web migrations `0074_performance_indexes.sql` and `0075_document_workspace_revisions.sql` using the normal migration process. Index creation runs transactionally and takes normal PostgreSQL index-build locks; schedule it for the table sizes in production. The new metadata endpoint requires migration 0075.
2. Deploy the changed Workers, including emails, messages and tasks and the shared request instrumentation.
3. Deploy Cookie-Web; build/test Cookie-iOS with Xcode before distributing it. Legacy endpoint responses remain available during mixed-client rollout.
4. Inspect `Server-Timing` and sampled logs on realistic accounts. Aggregate request durations by service/method/status for p50/p95; use the separate SQL/count/attachment stages to locate remaining delays. `PERFORMANCE_SAMPLE_RATE` defaults to 0.05; set it to 0 to disable structured timing logs. Browser measurements use fixed `cookie:` names and retain one entry per name; use a PerformanceObserver while profiling to collect a sequence.

The existing single-connection pool limit, user-visible spreadsheet features and full folder/tag semantics are preserved. Further pool-size or preset reductions should follow production/device profiles.

## Reproducing database checks

Use a local PostgreSQL database named `cookie_performance`, owned by the current OS user and reachable at `/var/run/postgresql`. The scripts ignore environment-provided database URLs, create randomly named disposable schemas, and remove them afterward. The benchmark reads the original emails implementation from git commit `cf91645` and needs that commit in the checkout.

```sh
node scripts/test-postgres-performance.mjs
node scripts/benchmark-postgres-performance.mjs
```

Web checks are `npm run test:unit -- --run`, `npm run lint`, `npm run format:check`, and `npm run build`. Use a standard supported Node 24 build for the TypeScript-based oxlint plugin; this environment's custom Node 22 binary lacks compiled TypeScript support. Browser tests use `e2e/workerFixtures.js` and local fixture endpoints; no mail or documents are modified in production.

## September 13 review follow-up

The received-inbox predicate again requires completed classification; pending, failed and missing AI rows are covered by a real PostgreSQL integration fixture. The shared JSON reader cancels oversized streams while reading rather than buffering an arbitrary upload first. All checked JavaScript, including the nullable benchmark cursor, passes the complete type-check gate.

Web virtual lists now use binary search for visible ranges and keyed lookup for focus/anchors. Synthetic 10,000-lookup checks averaged 9.98 row reads at 1,000 rows and 13.36 at 10,000 rows. These measure lookup work, not browser frame rates. Plain document tables no longer request the spreadsheet runtime; formulas and saved workbook documents retain it. New regression coverage checks task lookup failures, AI navigation during creation, table persistence and editor readiness before accepting input.

The refreshed 100,000-message benchmark uses the classification-aware baseline cf91645: five-query medians were 1,776.9 ms before and 3.13 ms after, with equivalent results over 21 folder pages. This remains synthetic PostgreSQL execution time, not production request latency.
