# Performance changes and rollout

Implemented across the Cookie-Web, Cookie-Worker and Cookie-iOS sibling checkouts. No production deployment or migration has been performed.

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

- Web: full 1,134-test unit run passed; the additional snapshot-preservation test passed separately. Focused document/sidebar checks passed after the final navigation changes.
- Workers: all 1,518 unit tests passed. Additional focused message tests passed after adding stage timings. Type checks and lint/format checks pass.
- Chromium: 97 of 101 scenarios passed on the broad run. All four failures passed targeted reruns after correcting test assumptions about immediate summary display, activating deferred sheets, and narrowing the task-description locator; the Done scenario passed unchanged. A new offscreen-save scenario also passed. This covers 102 distinct scenarios, including targeted reruns.
- PostgreSQL 18: disposable local-schema integration checks pass for both migrations, same-microsecond cursors across 205 rows, ownership isolation, document deletion revalidation, global metadata, task descriptions, subtask pages and partial Today reordering.
- Native tests were added for date parsing and paged document trees. Xcode/iOS builds and physical-device profiling require macOS and have not been run here.

Measured local changes: the static startup graph falls from 528,626 to approximately 425,300 bytes (about 20%); the inbox graph falls from 602,478 to approximately 502,700 bytes (about 17%). The reproducible 100,000-message benchmark returns equivalent payloads across seven folders and three pages. Five-run median inbox query execution was 1,844.5 ms before and 3.55 ms after. These are synthetic query measurements, excluding API authentication, counts and network latency; they are not production latency claims.

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
