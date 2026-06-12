---
status: stable
shipped: null
owner: null
---

# 183 — Re-analysis preserves designed voices + per-chapter Reanalyse action

> Status: active
> Key files: `server/src/store/merge-analysis-cast.ts`, `server/src/routes/analysis.ts`, `src/views/generation.tsx`, `scripts/relink-stripped-qwen-voices.mjs`
> URL surface: Generate view (per-chapter "Re-analyse" button); no new route
> OpenAPI ops: none (reuses `POST /api/manuscripts/{id}/analysis/chapters`)
> Issues: closes #518 (re-analysis strips designed-voice overrides)

## Context

2026-06-05 incident: a user manually navigated to the `#/books/{id}/analysing`
URL to inspect a chapter. That **re-ran analysis**, which rewrote `cast.json`
with a fresh analyzer roster and **stripped the per-character designed-voice
links** (`overrideTtsVoices.qwen`, and for reused characters the supplementary
override). 10 The Drowning Bell characters (Berrin, Silveny, …) lost their Qwen voices
and fell back to Kokoro; the voice embeddings on disk (`voices/qwen/qwen-<id>.pt`)
were untouched — only the cast→voice pointer was lost.

Two problems: (a) re-analysis must never drop voice design, and (b) there was no
safe way to re-analyse a single chapter — the only path was the whole-book
analysing URL, which is exactly what caused the damage.

## Benefit / Rationale

- **User:** designed/reused voices survive any re-analysis; and a per-chapter
  **Re-analyse** button on each Generate-view chapter row lets the user re-run
  character detection + attribution for one chapter (e.g. the loop-truncate
  fix from plan 181) without touching the rest of the book — no URL dance.
- **Technical:** a pure, tested merge overlays the existing cast's voice fields
  onto the fresh roster by id, at all five cast-write sites (main + subset).
- **Architectural:** re-attribution and voice-design are now cleanly separated —
  the analyzer owns attribution data, the cast owns voice design, and a
  re-analysis can't clobber the latter.

## Architectural impact

- **New module** `server/src/store/merge-analysis-cast.ts`:
  `mergeAnalysisResultWithExistingCast(existing, fresh)` overlays
  `PRESERVED_VOICE_FIELDS` (`voiceId`, `voiceState`, `matchedFrom`,
  `overrideTtsVoices`, `overrideTtsVoice`, `ttsEngine`, `voiceStyle`) from the
  existing cast onto the fresh roster, by id. Only carries a field when the
  existing character has it (so a fresh reuse-link on a previously voiceless
  character survives). Dropped characters are NOT re-added (roster shrink is the
  stage-1 shrink guard's job).
- **`analysis.ts`** — both `runMainAnalyzerJob` and `runSubsetAnalyzerJob`
  snapshot the prior cast BEFORE any interim write clobbers `cast.json`, then
  merge it onto every cast write (interim + final, 5 sites). `fresh: true`
  (Start fresh) intentionally captures nothing — that path still clears voices.
- **`generation.tsx`** — a "Re-analyse" button (`IconSparkle`) on each done
  chapter row → a `ConfirmDialog` → `handleReanalyse(id)`, which streams
  `api.runAnalysisForChapters(manuscriptId, [id], …)` reusing the existing
  per-chapter subset-progress (`subsetByChapter`) machinery (minus the
  exclude/rollback the un-exclude flow needs).
- **`scripts/relink-stripped-qwen-voices.mjs`** — committed recovery tool that
  re-points characters at their on-disk `qwen-<id>` voices (dry-run by default).
  Used to recover the 10 The Drowning Bell + 2 Unlocked casualties of the incident.
- **Reversibility:** the merge is additive (only fills voice fields the analyzer
  omits). Reparse (`book-state.reparse.ts`) still clears cast.json — unchanged.

## Invariants to preserve

- The prior-cast snapshot is taken BEFORE the first interim cast write, or the
  interim (voiceless) roster would be read back and preserve nothing.
- `fresh: true` captures an empty prior cast (Start fresh must still clear).
- The merge only fills `PRESERVED_VOICE_FIELDS`; everything the analyzer owns
  (name, role, attributes, evidence, tone, lines, scenes, colour) comes from the
  fresh roster.

## Test plan

### Automated coverage

- Vitest server (`server/src/store/merge-analysis-cast.test.ts`, 6 cases):
  preserves designed Qwen voice / reused-voice link, keeps a brand-new char,
  doesn't re-add a dropped char, lets a fresh reuse-link stand, empty existing.
- Vitest frontend (`src/views/generation.test.tsx`): renders the real
  `GenerationView` against a real Redux store; the Re-analyse button confirms,
  then calls `runAnalysisForChapters('m1', [1], …)` for that chapter only;
  nothing fires before confirm. This covers the button → ConfirmDialog → redux →
  api seam.
- **e2e deferred:** a browser-level spec needs a *done*-chapter Generate state,
  which the mock harness doesn't readily reach (opening never auto-enqueues;
  fixture chapters start queued). The real-store unit test covers the seam;
  a Playwright spec is a follow-up once a done-chapter fixture exists.

### Manual acceptance

1. On an already-voiced book, re-analyse (full or per-chapter) → cast keeps every
   designed/reused voice (`scripts/audit`/the cast view shows them, not "No voice
   designed yet").
2. Generate view → a done chapter's "Re-analyse" → confirm → the chapter
   re-attributes with inline progress; regenerate it afterwards.

## Out of scope

- Recovering already-damaged books (done via the committed relink script).
- Roster-shrink preservation (dropped characters) — separate concern.

## Ship notes

Shipped 2026-06-06 (merge ce93ab8, PR #521, closes #518). Live acceptance
confirmed: re-analysing an already-voiced book keeps every designed/reused voice
(cast view, not "No voice designed yet"), and the Generate-view per-chapter
Re-analyse button re-attributes with inline progress.
