---
status: active
shipped: null
owner: null
---

# 153 — Durable per-chapter failure status + queued-row "Generate this chapter" + generated-time

> Status: stable (pending live acceptance)
> Key files: `server/src/workspace/scan.ts`, `server/src/routes/generation.ts`, `src/lib/types.ts`, `src/store/chapters-slice.ts`, `src/views/generation.tsx`
> URL surface: `#/books/<id>/generate`
> OpenAPI ops: none (state.json shape only; rides the existing `GET /api/books/{id}/state`)

## Benefit / Rationale

Closes the 2026-05-31 "Ch14 stuck on **Queued** when it actually failed" report. The Activity log showed *"Chapter 14 failed — Local TTS sidecar returned 400 {"detail":"Item 0: 'text' is required."}"*, yet the chapter row read **Queued** with `00:00` and offered only Rename/Exclude — no way to retry or even understand it had failed.

- **User:** a chapter that failed now re-hydrates as **"Failed · reason"** with a **Retry** control (survives reload AND a queue-clear), and any chapter sitting in **Queued** with no active run gets a per-row **"Generate this chapter"** action so it's never a dead end. Done chapters also show **when** their audio was generated.
- **Technical:** the failure record stops living only in the (clearable) `.queue.json` entry + ephemeral Activity log; it's persisted on `state.json` so the truth survives a process restart.
- **Architectural:** establishes that the chapter row's `state` is no longer a pure function of "audio on disk?" — it honors a durable `generationState:'failed'`, while `done` (disk) still wins. Minimal: only `'failed'` is persisted; `done`/`queued` stay derived.

## Architectural impact

- **New persisted fields** on `BookStateJson.chapters[]` (server `scan.ts` + frontend `types.ts`): `generationState?: 'failed'` and `generationError?: string`. Backward-compatible — optional, **no schema bump**; legacy `state.json` files load unchanged (absent ⇒ "queued" as before).
- **Write sites** (`server/src/routes/generation.ts`): the per-chapter failure `catch` persists `{generationState:'failed', generationError}` (mirrors the existing success read-modify-write, wrapped in its own try/catch so a persistence hiccup never masks the synthesis failure); the success path **clears** both fields alongside stamping `duration`/`audioModelKey`/`audioRenderedAt`.
- **Hydration** (`src/store/chapters-slice.ts` `hydrateFromBookState`): `state = done ? 'done' : generationState==='failed' ? 'failed' : 'queued'`, and `errorReason` is carried from `generationError` for the failed case. The existing failed-row error box + Retry button render off `state==='failed'` + `errorReason` with no further change.
- **Escape hatch** (`src/views/generation.tsx`): a new `handleGenerateChapter` enqueues a single `{scope:'this'}` entry (mirrors the drift-bulk enqueue) — the dispatcher claims it and opens the stream. Rendered as a **"Generate this chapter"** button in the queued row's expanded panel (testid `chapter-row-<id>-generate`).
- **Generated-time** (`src/views/generation.tsx`): the done action row shows `Generated <relativeTime(audioRenderedAt)>` (reuses `relativeTime` from `change-log.ts`) with the absolute date/time on `title` hover. Guarded on `audioRenderedAt` so legacy audio omits the line.
- **Invariants preserved:** `done.has(slug)` (audio on disk) keeps priority over a stale `generationState:'failed'`. `state.json` writes still route through `stampStateSchema` (plan 27). Discriminated-union `ui.stage` untouched.
- **Reversibility:** drop the two fields + revert the hydrate/view edits; old `state.json` files keep loading (extra fields ignored).

## Invariants to preserve

1. `BookStateJson.chapters[].generationState` is exactly `'failed' | undefined` — `done`/`queued` are never persisted (derived from `completedSlugs` / absence). `server/src/workspace/scan.ts` + `src/lib/types.ts`.
2. `hydrateFromBookState` (`src/store/chapters-slice.ts`) maps `done ? 'done' : generationState==='failed' ? 'failed' : 'queued'` — disk-done wins.
3. The generation failure `catch` in `server/src/routes/generation.ts` persists the failure AFTER the `chapter_failed` broadcast and inside its own try/catch (never throws out of the catch).
4. The success path clears `generationState`/`generationError` in the same `chapters.map` that stamps `audioRenderedAt`.
5. "Generate this chapter" only renders for `chapter.state === 'queued'` (not `in_progress`) and enqueues exactly one `{scope:'this'}` entry for that chapter id.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/generation.test.ts` → "persists generationState on failure") — a synth failure writes `generationState:'failed'` + `generationError` (== the broadcast `errorReason`) to `state.json`; a subsequent successful render clears both.
- Vitest unit (`src/store/chapters-slice.test.ts` → hydrateFromBookState) — a not-done chapter with `generationState:'failed'` hydrates `state:'failed'` + `errorReason`; disk-done wins over a stale `'failed'`; absent ⇒ `'queued'`.
- Vitest view (`src/views/generation.test.tsx` → "stuck-queued escape hatch + generated-time") — a queued row exposes "Generate this chapter" which POSTs `/api/queue/enqueue` with `{bookId, chapterId, scope:'this'}`; the button is absent on a done row; the generated-time label renders with the absolute `title`, and is omitted when `audioRenderedAt` is absent.
- Playwright e2e (`e2e/generation-stuck-queued.spec.ts`) — drives mock mode to the Generate view with queued chapters (no active run), expands a queued row, asserts the escape-hatch button, clicks it, and confirms the chapter leaves `queued` (enqueue → dispatcher → stream wiring end-to-end).

### Manual acceptance walkthrough

1. With the empty-text fix in `main` (commit 739fef7), open the book whose Ch14 shows **Queued** → expand Ch14 → click **Generate this chapter** → it renders and flips to **Done** with a "Generated just now" label.
2. Force a failure on a throwaway chapter (e.g. point at a dead sidecar) → reload the app → the chapter shows **"Failed · <reason>"** with **Retry** instead of "Queued".
3. A done chapter's action row shows "Generated <relative>"; hover → absolute date/time.

## Out of scope

- **Backfilling `generationState` for chapters that already failed before this shipped** (e.g. the live Ch14, whose failure was never persisted and whose queue entry is gone). Those re-hydrate as "Queued"; the per-row **Generate this chapter** action is their recovery. No data-fix script.
- A full per-chapter status enum / reconciliation against the queue — deliberately not done (would duplicate disk-derived truth).
- `analysis.failedChapterIds` (Phase 0/1 analysis failures) is a separate concern — not touched.

## Ship notes

(Filled when status → stable. Shipped date + commit SHA + any delta vs spec.)
