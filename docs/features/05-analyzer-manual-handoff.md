# Manual handoff analyzer (`ANALYZER=manual`)

> Status: stable
> Key files: `server/src/handoff/protocol.ts`, `server/src/handoff/schemas.ts`, `server/src/analyzer/index.ts`, `server/src/routes/analysis.ts`
> URL surface: indirect (`#/books/:bookId/analysing` while the user drops files)
> OpenAPI ops: `POST /api/manuscripts/:id/analysis`

## What this covers

The default analyzer mode for this project: the server writes a markdown prompt to `server/handoff/inbox/`, then watches `server/handoff/outbox/` for a matching `.json` drop produced by the user pasting the prompt into a separate Claude window. This pattern is deliberately local-and-free-first (see memory `feedback_local_zero_cost`).

## Invariants to preserve

- Handoff root is `server/handoff/` with subdirs `inbox/` and `outbox/` (`server/src/handoff/protocol.ts:19-21`). Both are created on first use; do not move.
- Inbox filename: `{manuscriptId}-stage{key}.md`. Outbox filename: `{manuscriptId}-stage{key}.json`. Error file: `{manuscriptId}-stage{key}.errors.json`. Filenames must match exactly — the watcher targets a single file (`protocol.ts:32-42`).
- Handoff key union: `'1' | '2' | \`2-ch${number}\`` (`protocol.ts:25`). `'2'` is the legacy whole-manuscript path; current default is per-chapter `2-ch1`, `2-ch2`, … (see `server/src/routes/analysis.ts`).
- `writeInbox` clears any stale outbox + error files before writing the new prompt (`protocol.ts:48-50`). This guarantees `awaitOutbox` only resolves on a fresh drop.
- `awaitOutbox` validates the JSON against a Zod schema; on invalid JSON it writes a `kind: 'invalid-json'` error file; on schema mismatch it writes a `kind: 'schema-validation'` error file with `issues[]` and deletes the bad outbox so the next correct drop fires a fresh `add` event (`protocol.ts:86-107`).
- Default timeout is 30 minutes; configurable via `AwaitOptions.timeoutMs` (`protocol.ts:69`). On timeout, the promise rejects with `Handoff timeout waiting for outbox <path> after <ms>ms`.
- On successful parse, both the outbox file and the error file (if any) are deleted (`protocol.ts:109-111`). A re-run gets a clean slate.
- `chokidar` is configured with `awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }` (`protocol.ts:123`) so half-written files do not trigger early parses.

## Acceptance walkthrough

Run server with `ANALYZER=manual` (default). Upload a small manuscript via the UI.

1. **Stage 1 prompt drop** — within seconds of starting analysis, `server/handoff/inbox/<id>-stage1.md` exists. Contents include the manuscript text + extraction instructions.
2. **Invalid JSON drop** — paste `{ not valid json` into `server/handoff/outbox/<id>-stage1.json`. After ≤300 ms, `<id>-stage1.errors.json` appears with `{ kind: 'invalid-json', message: '...' }`. Outbox file is left in place pending correction.
3. **Schema-mismatch drop** — replace with valid JSON missing required `characters` field. Errors file rewrites to `{ kind: 'schema-validation', issues: [...] }`; the bad outbox is deleted so the next correct drop fires fresh.
4. **Valid drop** — paste a valid stage-1 JSON payload. Within 250 ms (stability threshold), the watcher parses, deletes both the outbox + errors file, and the analysis stream advances to stage 2.
5. **Per-chapter stage 2** — inbox now has `<id>-stage2-ch1.md`. Repeat the drop pattern for each chapter. UI live ETA updates after each.
6. **Timeout** — start analysis, never drop. After 30 minutes, the stream emits an error with `code: 'unknown'` (or specific) and message containing `Handoff timeout`. UI shows the error inline.
7. **Re-run** — start analysis again on the same manuscript. `writeInbox` clears any stale `<id>-stage1.json` from a prior run before writing the prompt, so an old correct drop does not auto-resolve the new run.

## Out of scope

- The exact prompt format — that lives in `server/src/analyzer/*` and may evolve.
- File-system case sensitivity quirks — Windows is case-insensitive; the protocol relies on exact filename matches so do not rely on case differences.
- Hot-reload of the watcher — restarting the server abandons in-flight watchers; user must re-trigger analysis.

## KNOWN: operational dependency

The user is responsible for pasting the inbox prompt into a separate Claude window and copying the JSON result back to the outbox. There is no automation of this step (intentional — see project memory `feedback_local_zero_cost`).
