---
status: stable
shipped: 2026-05-20
owner: null
---

# Per-chapter loudness report card (EBU R128 drift surfacing)

> Status: stable
> Key files: `src/components/loudness-report.tsx`, `src/components/listen/listen-player-region.tsx`, `src/store/chapters-slice.ts`, `server/src/routes/chapter-audio.ts`, `server/src/routes/book-state.ts`, `openapi.yaml`, `src/lib/types.ts`
> URL surface: `#/books/<id>/listen` (card is rendered inside the player region, between the chapter list and the share-clip modal)
> OpenAPI ops: extends `getChapterAudio` response with `lufs` field; book-state response gains a per-chapter `chapterLufs` map (hand-written type — book-state has no OpenAPI binding)
> Paired tests: `src/components/loudness-report.test.tsx`, `src/components/listen/listen-player-region.test.tsx`, `src/store/chapters-slice.test.ts` (hydration), `server/src/routes/chapter-audio.test.ts` (loudness sidecar section), `server/src/routes/book-state.test.ts` (chapterLufs section), `e2e/listen-loudness-report.spec.ts`
> Cross-links: [71 — Audio loudness normalization](71-audio-loudness-normalization.md) (the writer this plan consumes), [28 — Audio output format](28-chapter-audio-format.md)

## Benefit / Rationale

Plan 71 writes per-chapter EBU R128 measurements to disk but nothing surfaces them. A loudness-normalised book is supposed to sit at one perceived volume across narrators and chapters — but the user only finds out something drifted when they hear it. This plan closes the loop: every Listen view now shows a colour-coded badge per chapter and a book-level report card so problem chapters are visible before export, not after.

- **User:** at a glance, see which chapters landed on target (green), which drifted a little (amber), and which are off (red). The expandable per-chapter table backs the badge with the actual numbers (i / drift / measured-at) so a user evaluating their book before publishing has the data they need without re-running ffprobe by hand.
- **Technical:** the chapter-audio meta endpoint and the book-state response both now carry the loudnorm sidecar payload, so the Listen view doesn't have to N-fan-out one fetch per chapter row. The per-row badge consumes the slice; the report card consumes the slice; both read from one source of truth.
- **Architectural:** the redux Chapter shape gains a `lufs` field that mirrors plan 71's `LoudnormSidecarJson`. The sidecar JSON disk schema is unchanged — this plan is a pure reader. Any future plan that needs the loudness data (cross-book drift comparison, per-chapter re-normalise trigger) reads from the same slice field.

## Architectural impact

- **New seams added:**
  - `ChapterAudio.lufs` (OpenAPI) — optional, mirrors `LoudnormSidecarJson` on disk. Null when no loudnorm pass landed.
  - `BookStateResponse.chapterLufs` (hand-written type in `src/lib/types.ts`) — `Record<chapterId, ChapterLoudness | null>`. Empty `{}` when no audio dir; null entry per chapter when sidecar is absent.
  - `Chapter.lufs` (runtime, UI-only) — populated by `hydrateFromBookState` from the per-book map. `undefined` when the response omits the field (back-compat for older servers); `null` when fetched-but-no-data.
  - `LoudnessReport` component (`src/components/loudness-report.tsx`) — pure presentational; reads from chapter slice via the listen-player-region wrapper.
  - `LoudnessBadge` (inline in `listen-player-region.tsx`) — per-row pill gated on `lufs.twoPass === true`.
  - Helper export `classifyDrift(lufs)` — the single source of truth for the on-target / slight / off-target / no-data buckets, shared between the row badge and the report card.
- **Invariants preserved:**
  - The `.lufs.json` sidecar JSON shape is unchanged (plan 71 contract). This plan only adds READ paths; no writer touched.
  - The chapter-audio meta endpoint's existing fields (`url`, `durationSec`, `peaks`, `sampleRate`, `segments`) round-trip unchanged. `lufs` is additive.
  - The book-state response's existing fields round-trip unchanged. `chapterLufs` is additive (older clients ignore it).
  - The `twoPass === true` gate is enforced in TWO places: the per-row badge AND the report card's bucket classifier. Drift comparisons NEVER happen against single-pass values.
- **Migration story:**
  - Chapters generated before plan 71 → `chapterLufs[id] = null` → row badge omitted, report card row shows "No measurement" pill.
  - Books generated before plan 71 with ZERO loudnormed chapters → empty-state copy points the user at `AUDIO_LOUDNORM_ENABLED` (default on since plan 71).
  - Older server (no `chapterLufs` in response) → slice field stays `undefined` → same UI as legacy chapters.
- **Reversibility:** revert the slice + UI commits; the server fields stay harmless (any consumer ignores unknown JSON keys).

## Sidecar contract

Persisted by plan 71's encoder at `<bookDir>/audio/<chapterSlug>.lufs.json`. This plan reads it back verbatim — DO NOT redesign:

```json
{
  "i": -16.02,
  "lra": 8.4,
  "tp": -2.1,
  "target": -16,
  "twoPass": true,
  "measuredAt": "2026-05-20T12:00:00.000Z"
}
```

- `i` — measured integrated loudness (LUFS). In TWO-PASS mode this is the FIRST-PASS measurement of the source PCM; in SINGLE-PASS mode it's the nominal target (no re-measurement). Consumers MUST gate drift comparisons on `twoPass === true`.
- `lra` — measured loudness range (LU). Same single-pass caveat.
- `tp` — measured true peak (dBTP). Same single-pass caveat.
- `target` — target integrated loudness used. Default `-16` (ACX audiobook submission target).
- `twoPass` — `true` when the measure-then-apply flow ran; `false` for single-pass streaming normalisation.
- `measuredAt` — ISO-8601 timestamp at encode time.

Missing file = no loudnorm pass landed (legacy chapter / `AUDIO_LOUDNORM_ENABLED=false` / silent-source fallthrough). UI degrades to "no data" — no synthesised default target.

## Two-pass vs single-pass gate (CRITICAL)

Single-pass loudnorm writes the NOMINAL TARGET into `i`/`lra`/`tp`, not a re-measurement of the output. A chapter normalised in single-pass mode whose actual integrated loudness is several LU off-target will still report `i === target`. Rendering that as "on target" would silently mislead the user.

The gate is enforced in `classifyDrift()` (single function, single source of truth):

```ts
if (!lufs || lufs.twoPass !== true) return 'no-data';
```

Every consumer in the UI calls through this function. The per-row badge renders nothing for single-pass; the report card treats them as no-data (so they roll up under "no measurement" rather than skewing the on-target count). Locked in by `loudness-report.test.tsx`'s "single-pass gate (CRITICAL)" describe block and `listen-player-region.test.tsx`'s "does NOT render a badge when twoPass is false" case.

## Drift thresholds

| drift = `|i − target|` | bucket       | colour | copy            |
| ---------------------- | ------------ | ------ | --------------- |
| ≤ 2 LU                 | `on-target`  | green  | On target       |
| 2 LU < d ≤ 4 LU        | `slight`     | amber  | Slight drift    |
| > 4 LU                 | `off-target` | rose   | Off target      |
| no data / single-pass  | `no-data`    | neutral| No measurement  |

The 2 LU boundary is the EBU R128 tolerance the encoder targets; the 4 LU boundary is the audible-on-careful-listening threshold. Numbers locked in by `classifyDrift` and exercised exhaustively in `loudness-report.test.tsx` "bucket thresholds".

## Mount point

The `LoudnessReport` card is mounted inside `ListenPlayerRegion` (`src/components/listen/listen-player-region.tsx`), immediately after the chapter list and before the `ShareClipModal`. Rationale:

- Per CLAUDE.md, `src/views/listen.tsx` is a thin orchestrator and new listen-view features land in the relevant region sub-component.
- The card SUMMARISES the chapter list directly above it; visual proximity is the whole point.
- The download section (`listen-download-section.tsx`) is about exports — adding a loudness card there would mix concerns.
- The header (`listen-header.tsx`) carries top-of-view cover + book-meta; the loudness card is too detail-heavy for that slot.

The per-row badge lives inline in `ChapterListenRow` next to the title, sharing the same line as the resume pill. No layout breakage on rows that lack a measurement — the badge null-renders.

## Invariants to preserve

1. The `.lufs.json` sidecar JSON shape (`LoudnormSidecarJson` in `server/src/tts/loudnorm.ts:64`) is stable contract with plan 71. Adding fields requires a new plan that updates BOTH the writer (loudnorm.ts) and every reader (chapter-audio.ts, book-state.ts, frontend `classifyDrift`).
2. `classifyDrift()` in `src/components/loudness-report.tsx` is the SOLE bucket-classification function. New consumers MUST import it rather than re-deriving thresholds.
3. The single-pass gate (`lufs.twoPass !== true → no-data`) MUST stay enforced. Any future "show single-pass anyway" affordance needs a separate signal that doesn't conflate nominal-target with measured-value.
4. The chapter-audio meta endpoint's `lufs` field is OPTIONAL (`null` when sidecar absent). Removing the null branch in any reader would 500 the listen view on every legacy chapter.
5. `book-state.ts`'s `chapterLufs` map MUST have a null entry per chapter when the sidecar is absent (not a missing key). The frontend uses the keys to detect "we asked, the answer was no" vs. "older server didn't send it".

## Test plan

### Automated coverage

- **Server `chapter-audio.test.ts` "loudness sidecar" describe block** — 5 cases: two-pass payload round-trips verbatim, single-pass payload surfaces `twoPass: false` unchanged (UI degrades on consumer side), missing sidecar returns `lufs: null`, malformed JSON returns `lufs: null` (no 500), full payload round-trip preserves every field.
- **Server `book-state.test.ts` "chapterLufs hydration (plan 77)" describe block** — 4 cases: empty `{}` when no audio dir, surfaces per-chapter payload when present, null entry when sidecar missing, null entry on malformed JSON.
- **Frontend `chapters-slice.test.ts`** — 2 cases: `hydrateFromBookState` copies `chapterLufs[id]` onto each chapter row's `lufs` field; absent map leaves `lufs` undefined.
- **Frontend `loudness-report.test.tsx`** — 15 cases covering bucket thresholds (≤2 / 2-4 / >4 LU), the single-pass gate (CRITICAL), null/undefined → no-data, mixed-drift summary counts, sparkline column attributes, excluded-chapter filtering, empty state, and expand-collapse of the per-chapter table.
- **Frontend `listen-player-region.test.tsx`** — 9 cases covering each badge colour, missing-data null render, single-pass gate null render, tooltip content, formatted LUFS value, and the report card mount-point.
- **E2E `e2e/listen-loudness-report.spec.ts`** — 3 cases: card + summary + sparkline render in a real browser on the Solway Bay mock seed, expandable table toggles open and shows the right buckets per row, per-row badge appears on measured chapters and is absent on single-pass / no-data chapters.

### Manual acceptance walkthrough

Mock mode (`VITE_USE_MOCKS=true`) — the Solway Bay seed in `src/lib/api.ts` ships deterministic chapterLufs payloads that exercise every badge colour.

1. **Open `#/books/sb/listen`** → expected stage = `{ kind: 'ready', view: 'listen', bookId: 'sb' }`, expected UI = listen view with header + chapter list + loudness report card visible below the chapter list.
2. **Inspect the summary line** → reads "N of M chapters within ±2 LU of -16.0 LUFS" where N counts the chapters with two-pass on-target measurements (15 in the mock seed) and M counts chapters with ANY two-pass measurement (16 — chapters 11 and 15 are single-pass, chapter 14 is null).
3. **Eyeball the sparkline** → 18 bars total. Chapter 9 (one of the tallest, rose-coloured) is off-target; chapter 4 / 5 (amber-tinted, 2.6 / 0 LU drift respectively) shows the slight bucket; the rest are mostly green; chapter 14 is a tiny neutral stub (no-data).
4. **Per-chapter row badges** → chapter 1's row shows a green "−15.9 LUFS" pill; chapter 4 shows an amber "−13.4 LUFS" pill; chapter 9 shows a rose "−11.6 LUFS" pill; chapter 11 / 15 have NO badge (single-pass); chapter 14 has NO badge (null).
5. **Hover a badge** → native tooltip surfaces target + LRA + true peak + measured-at relative time.
6. **Click "Show per-chapter table"** → the table expands. Each row carries `data-bucket="…"` for the visual regression hook. Single-pass / null rows render `—` in the measured / drift cells with a neutral "No measurement" pill.
7. **Click "Hide per-chapter table"** → the table collapses back.
8. **Generate a fresh book end-to-end** (real backend, AUDIO_LOUDNORM_ENABLED=true) → the book's `chapter-audio` meta endpoint surfaces real `lufs` payloads; the listen view shows real per-chapter measurements. Open `<bookDir>/.audiobook/state.json` and compare against the disk `.lufs.json` files to confirm round-trip.
9. **Set `AUDIO_LOUDNORM_ENABLED=false` and regenerate one chapter** → its `.lufs.json` disappears; the chapter's badge is suppressed on next listen-view load; the report card summary count drops by one but the rest of the book reads unchanged.

## Out of scope

- **No histogram interactivity for v1.** The sparkline is read-only — no hover-to-highlight-row, no click-to-seek. The expandable table is the cross-reference affordance.
- **No per-chapter "re-normalize" button.** That's a future Could; would require a server-side re-encode endpoint and a queue UI. The current loop is: tweak `AUDIO_LOUDNORM_ENABLED` / target in env → regenerate from the Generate view.
- **No cross-book drift comparison.** Comparing Book A's loudness curve against Book B's is a future Could; sits more naturally on the workspace activity view.
- **No telemetry / aggregation.** The per-book card stays per-book. No "your library averages -16.3 LUFS" rollup.
- **No M4B chapter-level loudness export.** The report is for the audiobook author; the listener gets one normalised stream.

## Ship notes

Shipped 2026-05-20 on branch `feat/frontend-audio-loudness-report` (see end-of-turn summary for the commit SHA). Implementation: server adds `lufs` to chapter-audio meta + `chapterLufs` to book-state response, openapi.yaml gains `ChapterLoudness` schema, frontend Chapter shape gains `lufs?`, new `LoudnessReport` component (~280 lines) plus inline `LoudnessBadge` in listen-player-region. Mock seed populates 18 deterministic chapterLufs entries for Solway Bay so design-system mode has real content. 34 new automated tests: 5 server (chapter-audio) + 4 server (book-state) + 2 frontend slice + 15 frontend report-card + 9 frontend region badge — plus 3 Playwright e2e cases. No `.lufs.json` writer touched; this is a pure read path.
