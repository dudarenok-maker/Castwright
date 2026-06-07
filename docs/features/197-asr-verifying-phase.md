---
status: draft
shipped: null
owner: null
---

# ASR "Verifying speech" phase in the Generate view

> Status: draft
> Key files: `openapi.yaml`, `server/src/tts/synthesise-chapter.ts`, `server/src/routes/generation.ts`, `src/lib/types.ts`, `src/store/chapters-slice.ts`, `src/views/generation.tsx`
> URL surface: `#/books/<id>/generate` (per-chapter row)
> OpenAPI ops: `POST /api/books/{bookId}/generation` (SSE — new `GenerationTick.type` value `chapter_verifying`)

> Backlog: `fs-40` ([#640](https://github.com/dudarenok-maker/AudioBook-Generator/issues/640))

Design spec: `docs/superpowers/specs/2026-06-08-asr-verifying-phase-design.md`.

## Benefit / Rationale

- **User:** during the ASR content-QA pass (srv-31) the per-chapter row no longer
  sits frozen on "Synthesising {name} · line N of Y" — it reads "Verifying
  speech…", so the pause reads as deliberate quality-checking, not a stall.
- **Technical:** closes a latent false-stall: a chapter with no ASR drift
  currently fires zero ticks for the whole ASR pass (only `onRerecord` ticks),
  which can trip the server no-progress watchdog. The new per-sampled-group
  `onProgress` tick feeds the watchdog throughout.
- **Architectural:** reuses the existing UI-only `chapter.phase` seam — a new
  `verifying` sibling to `assembling`, carried by a new `chapter_verifying` SSE
  tick. No new persisted state.

## Architectural impact

- **New seams:** `AsrPassOptions.onProgress` callback in `synthesise-chapter.ts`;
  `chapter_verifying` value in the `GenerationTick.type` enum; `'verifying'`
  member of `Chapter['phase']`.
- **Invariants preserved:** OpenAPI stays the type source of truth (the enum
  value is added there and regenerated into `api-types.ts`, never hand-written —
  see plan 00/24). `chapter.phase` remains UI-only / not persisted.
- **Migration story:** none — additive enum value + additive optional callback.
  Older clients ignore an unknown `chapter_verifying` tick (the slice's switch
  falls through to the `progress` branch only on `type === 'progress'`, so an
  unknown type is a no-op heartbeat). Older servers simply never emit it.
- **Reversibility:** delete the enum value + the three wirings; the row falls
  back to today's frozen-"Synthesising" behaviour.

## Invariants to preserve

- `GenerationTick.type` enum in `openapi.yaml` is the single source — regenerate
  `src/lib/api-types.ts`; do not hand-edit it.
- `Chapter.phase` in `src/lib/types.ts` is UI-only (comment at line 12) — the
  `verifying` member must not leak into the wire schema.
- The `chapter_verifying` slice handler mirrors `chapter_assembling`
  (`src/store/chapters-slice.ts:407`): sets `phase`, forces `state='in_progress'`,
  carries counters, returns early.
- The new code path is gated on the existing `asr` options (strict no-op when
  ASR is disabled). **ASR is ON in the current production deployment**
  (`server/.env`: `SEG_ASR_ENABLED=1`, `SEG_ASR_SAMPLE_EVERY=1`, `ASR_DEVICE=cuda`),
  so the verifying phase shows on every chapter — this is the live symptom fixed.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/synthesise-chapter-asr.test.ts`) — `asr.onProgress`
  fires once per sampled group **including `ok` verdicts**, with correct
  `verified`/`total`.
- Vitest unit (`src/store/chapters-slice.test.ts`) — `chapter_verifying` sets
  `phase='verifying'` + `state='in_progress'`; a later `chapter_assembling` /
  `chapter_complete` clears it.
- Vitest unit (`src/views/generation.test.tsx`) — the in-progress row caption
  renders "Verifying speech…" when `phase='verifying'`.
- Playwright e2e — best-effort: add a `chapter_verifying` frame to the mock
  generation stream if scripted; otherwise mock-mode does not run ASR and the
  slice + view units carry the behaviour (stated, not silently omitted).

### Manual acceptance walkthrough

Requires the real backend + sidecar with `SEG_ASR_ENABLED=1`.

1. Start generation on a multi-chapter book. Expected: row reads
   "Synthesising {name} · line N of Y" while groups render.
2. When a chapter's last group finishes and the ASR pass begins → row flips to
   "Verifying speech…" with the spinner; percent holds ~99%; the row does NOT go
   "Stalled" even on a long all-`ok` pass.
3. ASR pass done → row reads "Assembling…", then "Done".
4. Global top-bar pill reads "Generating" throughout (unchanged).

## Out of scope

- Numeric "N of M" count in the caption (chosen wording is the ellipsis form).
- Reflecting the verifying phase in the global `GenerationPill`.
- Any ASR threshold / sampling / re-record policy change (srv-31 owns those —
  `docs/features/archive/186-asr-content-qa.md`).

## Ship notes

(Filled in when status flips to `stable`.)
