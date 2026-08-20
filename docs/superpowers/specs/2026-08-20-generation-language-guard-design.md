---
status: draft
date: 2026-08-20
issue: 2515
---

# Wiring audio generation into the language guard (#2246 site 2)

Design of record for **#2515** — the decision request surfaced by the independent
review of PR #2492 (finding S5): should `server/src/routes/generation.ts`'s
audio-render path join the language-guard mechanism the rest of #2246 already
wires, or is a bare failure the accepted outcome there?

**Answer: wire it now (owner-confirmed, 2026-08-20).** This document also records
*why* the issue's cost estimate ("roughly a child or two of work plus a contract
change... the largest single remaining piece") turned out to overstate it: the
guard-bus mechanism and three sibling streaming sites are already fully built on
this branch, and the "what does retry mean mid-render" question the issue posed
does not apply, because the check this design targets fires before any chapter
in the request starts rendering.

## What's already built (verified against `feat/server-2246-language-recurrence`)

- `src/lib/language-guard-bus.ts` — the non-React seam. `emitLanguageGuard(req)`
  routes a language-unset failure to the modal handler registered by
  `useLanguageGuard`; returns whether a handler accepted it.
- `src/modals/edit-book-meta.tsx` — `EditBookMetaModal`'s guard mode
  (`LanguageGuardShape = '409' | 'sse' | 'batch'`). The shape only selects
  copy — open/retry behaviour is identical across all three, per its own doc
  comment (`:35-41`), which **already lists `generation` among the `'sse'`
  sites** even though generation isn't wired yet.
- Four sites already wired: `chapter-splice` / `chapter-qa-repair` (via
  `api.ts`'s `isLanguageUnsetBody` + `emitLanguageGuard` at `:2124`, `:2859`),
  `analysis-stream-middleware.ts:196`, `cast-design-stream-middleware.ts:163`
  (the pattern this design copies), `script-review-thunk.ts:163`.
- `server/src/routes/generation.ts:800-805` **already calls
  `requireBookStateLanguage(state)`** and bails on throw — Task 6 of the parent
  plan shipped this part. It sends `{ type: 'chapter_failed', errorReason }`
  with **no `errorCode`**, so nothing downstream can distinguish it from any
  other early bail-out (provider selection failure, book-not-found,
  cast-not-confirmed — the same call shape, same tier, immediately above and
  below it in the file).
- `server/src/routes/failure-taxonomy.ts` (fs-19) — the `FailureCode` union +
  `classifyFailure`, already generation's own established mechanism for
  machine-readable failure classes, richer than the bare `{type:'error', code}`
  the three non-generation streaming sites use (they have no per-chapter
  taxonomy; generation does).
- `src/store/generation-stream-runner.ts:407-414` — the `chapterId == null`
  branch ("stream-level halt … chapter id absent") already exists and already
  toasts unconditionally for exactly this class of failure. Today it has no
  language-specific branch.

## Why the retry question the issue raised doesn't apply here

`requireBookStateLanguage` is called once, before the per-character/per-chapter
loop (`generation.ts:796` in the parent design doc's site table), in the same
position as the existing cast-not-confirmed check three lines above it
(`:769-775`). It is a route-level precondition, not a mid-stream failure: by
construction, **no chapter in the request has started rendering** when it
fires. So "retry" is not "resume a partially-rendered book" — it is "reopen the
identical request", exactly the shape `cast-design-stream-middleware.ts:161-169`
already implements for its own single-shot design-stream failure:

```ts
if (code === 'language_unset') {
  const replay = restart;
  if (emitLanguageGuard({
    selector: { bookId },
    shape: 'sse',
    onRetry: () => { close(); replay?.(); },
    onDismiss: fail,
  })) return;
}
```

## The change

### Server

1. **`failure-taxonomy.ts`** — add `'language-unset'` to the `FailureCode`
   union. Kebab-case, matching every existing member (`voice-not-designed`,
   `cloned-voice-broken`, …) — **not** the snake_case `language_unset` marker
   the four non-taxonomy sites use in their HTTP/SSE bodies. Those sites match
   a bare string in a JSON body or a `type:'error'` envelope with no shared
   enum; generation's `errorCode` is a typed field against this union, and
   consistency with its own taxonomy wins over consistency with a marker
   string this field was never going to carry verbatim anyway (the frontend
   detector reads `ev.errorCode`, not a wire string it compares against the
   other sites' constant).
2. **`failure-remediations.ts`** — copy for the new key, following the file's
   existing `{ userMessage, remediation }` shape and the fixed
   `BookLanguageUnsetError` sentence from the parent design doc: *"This book's
   language has not been set. Choose it in Book settings before continuing."*
   The key-parity test (`failure-taxonomy.test.ts`) enforces this can't drift
   from the union.
3. **`generation.ts:800-805`** — add `errorCode: 'language-unset'` to the
   existing `send({ type: 'chapter_failed', errorReason: ... })` call. No
   `chapterId` — unchanged from its sibling early bail-outs at the same call
   site; retrofitting one would be an unrelated change this design doesn't
   need.
4. **`openapi.yaml`** — the `FailureCode` enum gains one member;
   `src/lib/api-types.ts` regenerates (`npm run openapi:types`). No new event
   type, no new field — `errorCode` is already optional on `chapter_failed`.
   This is the entire "contract" surface; it is additive to an enum, not a
   shape change, so it carries no compatibility risk for the Android companion
   (an unrecognised enum member on an already-optional field is a no-op for
   any consumer that doesn't special-case it, same as today for the fifteen
   existing codes).

### Frontend

5. **`generation-stream-runner.ts`** — in the `handleTickFor`'s
   `chapterId == null` branch, before the unconditional toast: if
   `ev.errorCode === 'language-unset'`, call `emitLanguageGuard` with
   `selector: { bookId }`, `shape: 'sse'`, `onDismiss` falling back to the
   existing toast, and `onRetry` replaying the open. Mirrors
   `cast-design-stream-middleware.ts:161-169` exactly.
6. **`OpenHandle` (same file)** — today stores `bookId`, `chapterId`,
   `modelKey`, `chapterIds` but not the original `spec`/`opts` (`force`,
   `queueEntryId`, `fallbackConfirmed`), so nothing can replay `open()`
   faithfully yet. Add those three fields to the handle at `open()`-time so
   `onRetry` can call `open(bookId, modelKey, capturedSpec, capturedOpts)` —
   plumbing, not a new concept; `close(key)` already exists to tear down the
   failed handle first.

## Non-goals

- No new SSE event type — reuses `chapter_failed`, generation's existing
  vocabulary, rather than adopting the three non-taxonomy sites' bare
  `type:'error'` shape.
- No mid-render resume mechanism — doesn't apply; see above.
- No Book Settings language-editing UI work — that's `EditBookMetaModal`'s
  guard mode, already built and already shared by every other site this
  design mirrors.
- No `LanguageGuardShape` doc-comment change — it already lists `generation`
  under `'sse'` (`edit-book-meta.tsx:38-39`); this design makes that true
  rather than correcting it.

## Acceptance and coverage

- **Server test** (`generation.test.ts` or sibling): an unset-language
  generation request's `chapter_failed` tick carries
  `errorCode: 'language-unset'`; a book **with** a language is unaffected
  (the control, per the parent plan's acceptance pattern).
- **Frontend test** (`generation-stream-runner.test.ts`): mirrors
  `cast-design-stream-middleware`'s existing guard test —
  `errorCode: 'language-unset'` tick → `emitLanguageGuard` called with the
  right selector → save → `open()` replayed with the original spec/opts;
  dismiss → falls back to the existing toast.
- **`failure-taxonomy.test.ts`**: key-parity assertion picks up the new code
  automatically (existing mechanism, no new test needed beyond the copy).
- **e2e**: out of scope for this task — the parent plan's "409 → modal →
  retry loop" Playwright spec already exercises the shared modal/guard-bus
  path via the `'409'` shape sites; this design doesn't duplicate that
  coverage for `'sse'`, consistent with how `cast-design`'s own guard wiring
  shipped without its own e2e spec.
- **Release notes**: both files, per CLAUDE.md step 5 — folds into whatever
  entry #2246's shipping PR already carries for the language-guard work,
  rather than a standalone line for one more site.

## Ship notes

Not yet shipped. Implementation is one more task on the existing
`feat/server-2246-language-recurrence` branch, ahead of PR #2492 leaving
draft, per the repo owner's decision on #2515 (2026-08-20): wire now, not as
a follow-up, not accepted as a permanent gap.
