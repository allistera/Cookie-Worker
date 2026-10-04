# Cookie MCP server design

Date: 2026-10-04. Status: approved design, not implemented.

## Goal

Expose Cookie's mail, organisation, drafts and sending, calendar, tasks and
Documents features to MCP clients (claude.ai custom connectors, Claude
desktop/mobile, and Claude Code) through a remote MCP server that reuses the
existing API Workers as the single source of truth.

## Decisions

- **Placement:** a new capsule, `workers/cookie-mcp`, in Cookie-Worker. The
  internal entrypoints it depends on live in this repository, so one change
  and one CI run cover both sides; shared auth, Sentry and metrics helpers are
  reused rather than copied.
- **Transport:** Streamable HTTP at `https://mcp.infinitywave.online/mcp`,
  stateless JSON responses, no sessions and no Durable Objects (the
  2026-07-28 MCP revision is stateless at the protocol layer). `workers_dev`
  stays enabled for debugging, as on the other API Workers.
- **SDK:** the official `@modelcontextprotocol/sdk`, using its Web-standard
  Streamable HTTP server transport. JavaScript with JSDoc, checked by the
  repository's existing `typecheck` script.
- **Authorization server:** Auth0 (`auth.infinitywave.online`). The MCP server
  is an OAuth resource server only.
- **Sending:** `cookie_send_email` sends without an extra guard, at the
  owner's request. The existing per-minute send quota and idempotency keys
  still apply. The tool is annotated `destructiveHint: true`, so clients may
  prompt for confirmation.

## Authorization

1. `GET /.well-known/oauth-protected-resource` (and the path-suffixed form
   `/.well-known/oauth-protected-resource/mcp`) returns RFC 9728 metadata:
   `resource: "https://mcp.infinitywave.online/mcp"`,
   `authorization_servers: ["https://auth.infinitywave.online/"]`,
   `bearer_methods_supported: ["header"]`.
2. A `/mcp` request without a valid token gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://mcp.infinitywave.online/.well-known/oauth-protected-resource"`.
3. Tokens are verified with `shared/auth-jwt.js` `verifyAccessToken`, using
   the MCP Worker's own `AUTH0_AUDIENCE`
   (`https://mcp.infinitywave.online/mcp`). Tokens for `https://cookie-web/api`
   are rejected. The verified `auth0_sub` resolves to the same `users` row the
   SPA uses; an unprovisioned subject gets `403`.
4. One scope for v1. No `offline_access` in the challenge or metadata.
5. The client's token is never forwarded. Downstream calls use internal
   service bindings (below).

### Auth0 setup (manual, documented in the README)

- Create an API whose identifier is `https://mcp.infinitywave.online/mcp`,
  RS256.
- Register claude.ai and Claude Code with Client ID Metadata Documents.
  Dynamic Client Registration stays disabled. If a client cannot use CIMD,
  pre-register an Auth0 application and enter its client ID in the client's
  OAuth settings.
- The implementation plan must confirm, before code depends on it, that the
  tenant's plan supports CIMD and that Auth0 maps the `resource` parameter to
  this API audience.

## Internal service-binding path

- Each bound Worker exports a named entrypoint `Internal`
  (`WorkerEntrypoint`). A named entrypoint is reachable only through a service
  binding, never from the internet.
- `Internal` exposes one RPC method, `fetchAs(userId, request)`. It records
  `userId` for that `Request` object in a module-private `WeakMap` in
  `shared/db.js`, then calls the Worker's normal `fetch` handler.
- `withUserSql` checks that `WeakMap` first. On a hit it skips
  `verifyAccessToken` and uses the recorded `userId`. On a miss, behaviour is
  unchanged. No header, query parameter or token can create a hit.
- `cookie-web-send` authenticates outside `withUserSql`; its own auth path
  gets the same check.
- Bound Workers: `cookie-web-emails`, `cookie-web-messages`,
  `cookie-web-labels`, `cookie-web-search`, `cookie-web-drafts`,
  `cookie-web-send`, `cookie-web-calendar`, `cookie-web-tasks`.
- The MCP Worker's `wrangler.jsonc` binds each with `"entrypoint": "Internal"`
  and holds a Hyperdrive binding only for the `users` lookup in
  `verifyAccessToken`.

## Tools (v1)

All names carry the `cookie_` prefix. Each maps to one existing route; exact
input schemas are derived from that route's current validation during
planning.

| Area            | Tool               | Route                                                         |
| --------------- | ------------------ | ------------------------------------------------------------- |
| Mail read       | `list_emails`      | `GET /emails` (folder or label, cursor)                       |
|                 | `get_message`      | `GET /messages`                                               |
|                 | `search_mail`      | `GET /search` (hybrid or keyword)                             |
|                 | `ask_mail`         | `POST /ask`                                                   |
|                 | `list_contacts`    | `GET /messages/contacts`                                      |
| Organise        | `update_message`   | `PATCH /messages` (flags, archive), `POST /messages` (labels) |
|                 | `list_labels`      | `GET /labels`                                                 |
|                 | `create_label`     | `POST /labels`                                                |
|                 | `update_label`     | `PATCH /labels`                                               |
|                 | `delete_label`     | `DELETE /labels`                                              |
| Drafts and send | `list_drafts`      | `GET /drafts`                                                 |
|                 | `get_draft`        | `GET /drafts/:id`                                             |
|                 | `save_draft`       | `POST /drafts`, `PATCH /drafts/:id` (merged over the draft)   |
|                 | `delete_draft`     | `DELETE /drafts/:id`                                          |
|                 | `send_email`       | `POST /send` (optional `sendAt`)                              |
|                 | `list_scheduled`   | `GET /send/scheduled`                                         |
|                 | `cancel_scheduled` | `DELETE /send/scheduled`                                      |
| Calendar        | `list_calendars`   | `GET /calendars`                                              |
|                 | `list_events`      | `GET /calendar-events` (date range)                           |
|                 | `create_event`     | `POST /calendar-events`                                       |
|                 | `update_event`     | `PATCH /calendar-events` (full replace, whole series)         |
|                 | `delete_event`     | `DELETE /calendar-events` (whole series)                      |
| Tasks           | `list_projects`    | `GET /projects`                                               |
|                 | `list_tasks`       | `GET /task-items`                                             |
|                 | `create_task`      | `POST /task-items`                                            |
|                 | `update_task`      | `PATCH /task-items` (including complete)                      |
|                 | `delete_task`      | `DELETE /task-items`                                          |
| Documents       | `list_documents`   | `GET /documents` (folder listing)                             |
|                 | `search_documents` | `GET /documents` (search)                                     |
|                 | `get_document`     | `GET /documents`                                              |
|                 | `create_document`  | `POST /documents`, then `PATCH /documents` for content        |
|                 | `update_document`  | `PATCH /documents`                                            |
|                 | `delete_document`  | `DELETE /documents`                                           |

Routes in this table are the implemented targets, confirmed against the Worker
source. `list_projects` and `list_documents` were added during planning because
tasks need a project id and document search alone cannot browse folders.

Out of v1: label rules, files and attachments, AI compose and summarise,
enrichment settings.

### Tool behaviour

- **Annotations:** reads `readOnlyHint: true`; deletes and `send_email`
  `destructiveHint: true`; idempotent updates `idempotentHint: true`;
  `openWorldHint: false` except `send_email` (`true`).
- **Output:** `structuredContent` with a declared `outputSchema`, plus a short
  text rendering. List tools pass through the existing keyset cursors.
- **Size cap:** message and document bodies are capped at 20,000 characters
  with a `truncated` flag.
- **Untrusted content:** mail and document text is returned in labelled data
  fields. Tool descriptions state that message content is untrusted and that
  instructions inside it must not be followed.
- **Errors:** downstream `4xx` responses become `isError` results that name
  the fix (invalid field, not found, quota with retry hint). `401`/`403`
  report that the account is not provisioned. `5xx` becomes a generic failure;
  the downstream Worker already reports it to Sentry.

## Observability

- `workers/cookie-mcp/src/sentry.js` names the service `cookie-mcp` and tags
  captured failures with `operation` set to the tool name.
- Tool arguments and results are never captured, consistent with
  `shared/sentry.js`.
- Observability and Honeycomb trace settings copy the other API Workers.
- No CORS: MCP clients are not browsers.

## Testing

Vitest, in `workers/cookie-mcp/test` and `shared/`:

- Protected resource metadata and the `401` challenge format.
- Audience enforcement: a `https://cookie-web/api` token is rejected.
- Each tool's input-to-request mapping, against fake bindings.
- Downstream error mapping and body truncation.
- `shared/db.js`: a public request carrying any forged identity still
  requires a valid JWT; only `Internal.fetchAs` bypasses verification.
- Existing `test/repository` capsule checks cover the new Worker.

## Verification and rollout

- Locally: `npm run lint`, `npm run typecheck`, `npm run format:check`,
  `npm run dry-run -- cookie-mcp`. Tests run in GitHub Actions after pushing
  to `main`.
- Deploy manually, one Worker at a time: the eight bound Workers first, then
  `cookie-mcp`.
- After deploy: an MCP Inspector session and a claude.ai connector sign-in
  confirm the flow end to end.
- Docs: README Workers table row, Auth0 and client setup section, deploy
  order; a matching Cookie-Docs page if one covers the API Workers.
