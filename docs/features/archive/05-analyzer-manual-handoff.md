---
status: stable
shipped: 2026-05-13
retired: 2026-06-07
owner: null
---

# Manual handoff analyzer (`ANALYZER=manual`) — RETIRED

> **Retired.** The manual file-drop ("cowork") analyzer is gone. There is no
> `ANALYZER=manual` mode any more.

## What this was

The original zero-cost analyzer: the server wrote a markdown prompt to
`server/handoff/inbox/`, the user pasted it into a separate Claude window, and a
chokidar watcher (`awaitOutbox`) picked up the JSON answer dropped into
`server/handoff/outbox/`. It predated the local Ollama analyzer and the Gemini
free tier.

## Retirement

- The **engine** (`manual.ts`, `awaitOutbox`, chokidar) was removed in commit
  **71b35a8** (2026-05-14). The user-settings schema accepts only
  `'local' | 'gemini'`; there is no UI picker.
- The residual dead code, tests, and docs — plus the leftover "cowork /
  file-drop / human-in-the-loop" framing baked into the live analyzer prompts —
  were cleaned up in the **retire-manual-analyzer** change (references 71b35a8).
- A single safety net remains: a stray `ANALYZER=manual` in an old `.env` is
  silently coerced to `local` (see `server/src/analyzer/select-analyzer.ts` and
  its `select-analyzer.test.ts` guard), so startup never breaks.

## The `server/handoff/` paths today

The `server/handoff/{inbox,outbox}` directories and the `writeInbox` /
`outboxPath` identifiers in `server/src/handoff/protocol.ts` are **kept** — they
now serve as the **forensic traceability layer for the automated analyzers**
(Gemini / Ollama): every per-chapter prompt and raw response is persisted there
for debugging. They are no longer part of any human-in-the-loop workflow.

The old invariants this plan used to document (awaitOutbox, chokidar's
`awaitWriteFinish`, the 30-minute timeout) describe deleted code — do not
propagate them.
