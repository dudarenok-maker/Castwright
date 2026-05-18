---
status: active
shipped: null
owner: null
---

# Real chapter-audio peaks at encode time

> Status: active
> Key files: `server/src/audio/compute-peaks.ts`, `server/src/tts/mp3.ts`, `server/src/routes/chapter-audio.ts`, `server/src/routes/generation.ts`
> URL surface: `#/books/:bookId/listen` (waveform card)
> OpenAPI ops: `GET /api/books/{bookId}/chapters/{chapterId}/audio` (`peaks: number[]` field) — shape unchanged, value now derived from real audio

## Benefit / Rationale

- **User:** the Listen view's waveform card stops lying. Today the bars come from a mock sinusoid the frontend fills in when the server returns `peaks: []`; loud passages, silences, and fades are all invisible. After this plan the bars reflect the real chapter — spotting a stalled / silent / clipped chapter at a glance becomes possible.
- **Technical:** moves chapter-level audio metadata generation into the encode path where the PCM is already in memory, so the cost is one buffer walk per chapter (≤ a few ms even on 1-hour chapters) and zero re-reads from disk. Establishes a sibling-file pattern (`<slug>.peaks.json`) that future per-chapter audio metadata (loudness / true-peak / channel layout) can extend without renegotiating the wire shape.
- **Architectural:** keeps the pure-encoder boundary (`encodePcmToMp3` takes no fs, returns a `Buffer`) intact. The new `writeChapterPeaksFile` sibling owns the fs side — same separation of concerns as `writeJsonAtomic` ↔ `JSON.stringify`. Reads are graceful (missing / corrupt file → `peaks: []`), preserving the pre-plan contract for legacy chapters and avoiding a flag-day migration.

## Architectural impact

- **New seam:** `server/src/audio/compute-peaks.ts` — a pure function (`computePeaks(pcm, sampleRate) -> number[240]`). No fs, no shell-out, no timers. Tested in isolation so the reducer's normalization and RMS contract are pinned independently of any wire-up.
- **New seam:** `writeChapterPeaksFile(pcm, sampleRate, peaksPath)` in `server/src/tts/mp3.ts` — the fs wrapper. Uses the same temp-then-rename atomic-write pattern as `server/src/workspace/state-io.ts`'s `writeJsonAtomic` (write `.tmp-<pid>-<ts>`, rename over target; unlink the temp on terminal failure so the workspace doesn't accumulate droppings).
- **Invariants preserved:**
  - `encodePcmToMp3` (`server/src/tts/mp3.ts:30-95`) remains a pure encoder — same signature, same `Buffer` return, no fs reference. The peaks writer is a sibling, not a wrap.
  - `peaks: number[]` in `openapi.yaml` (and the generated `src/lib/api-types.ts`) is unchanged — the field already existed, only its value source changes. No `openapi:types` regen required.
  - Pre-plan-56 chapters keep loading: the meta endpoint's missing-file fallback returns `peaks: []` (the documented pre-plan contract), and the frontend's `Waveform` component has always handled empty arrays.
- **Migration story:** none required. The first regen of any chapter under this build drops a `<slug>.peaks.json` next to the MP3. Until then the meta endpoint returns the legacy `peaks: []` and the Listen card paints whatever the frontend's fallback (today: nothing visible) shows. No state.json bump, no schema version.
- **Reversibility:** deleting `<bookDir>/audio/<slug>.peaks.json` (or every `.peaks.json` across the workspace) is safe — the chapter-audio meta endpoint falls back to `peaks: []` and the next regen rewrites the file. Removing the writer call from `generation.ts` is a one-line revert; removing the read call from `chapter-audio.ts` is two lines.

## Invariants to preserve

- `computePeaks` always returns exactly `BIN_COUNT` (= 240) numbers, every value finite and in `[0, 1]`. Cited: `server/src/audio/compute-peaks.ts:42-46`.
- Silence (all-zero PCM, or empty buffer) maps to `[0, 0, …, 0]` — never NaN. The normalization-by-zero branch is gated by `if (peakRms > 0)` (`server/src/audio/compute-peaks.ts:114-117`).
- Short PCM (`sampleCount < BIN_COUNT`) maps each sample 1:1 onto the leading bins; the trailing bins are zero. We do NOT upsample / repeat — that would smear waveform shape. Cited: `server/src/audio/compute-peaks.ts:64-83`.
- Long PCM: every sample lands in exactly one bin (`floor(i * N / BIN_COUNT)` window boundaries). No off-by-one drops the last sample. Cited: `server/src/audio/compute-peaks.ts:88-92`.
- `writeChapterPeaksFile` uses temp-then-rename so a crash mid-write never leaves a half-written `.peaks.json` that a subsequent read would choke on. Cited: `server/src/tts/mp3.ts:130-142`.
- The chapter-audio meta endpoint (`/api/books/:bookId/chapters/:chapterId/audio` AND `/audio/previous`) returns `peaks: []` when the sibling file is missing OR malformed — both routes go through `readPeaksOrEmpty`. Cited: `server/src/routes/chapter-audio.ts:43-65`.
- Per-chapter atomic ordering in `generation.ts` (segments JSON → mp3 rename → peaks write) preserves the existing "MP3 on disk = chapter complete" resumability rule. Peaks failure is non-fatal (logged, swallowed) so a peaks-write hiccup never strands an otherwise-finished chapter. Cited: `server/src/routes/generation.ts:511-526`.

## Test plan

### Automated coverage

- Vitest server (`server/src/audio/compute-peaks.test.ts`) — pins the pure reducer's contract across silence, full-scale sine, half-scale-mixed sine, ascending ramp, and very-short PCM. Asserts shape (length 240, finite, `[0, 1]`), normalization (loudest bin = 1.0, half-amplitude segment ≈ 0.5), monotonicity on a ramp, every-sample coverage on long PCM, and the sample-rate-invariance note.
- Vitest server (`server/src/tts/mp3.test.ts`'s `writeChapterPeaksFile` block) — covers the fs side: writes a valid `{peaks: number[240]}` JSON, creates intermediate directories, leaves no `.tmp-*` droppings on success, serializes all-zero peaks (no NaN) for silent PCM.
- Vitest server (`server/src/routes/chapter-audio.test.ts`'s `peaks sibling (plan 56)` block) — pins the wire-up: meta endpoint surfaces the sibling file's `peaks` when present (with a deterministic ramp fixture so we verify content flow-through, not just shape), returns `peaks: []` when the sibling is absent (graceful pre-plan-56 contract), absorbs a corrupt `.peaks.json` (returns `[]` instead of 500ing).

### Manual acceptance walkthrough

(Real backend mode — `cd server && npm run dev`. No mock-mode walkthrough; mock `getChapterAudio` already returns a 240-bin sinusoid and is unchanged.)

1. Render a fresh chapter via the Generation view. → `<bookDir>/audio/<slug>.peaks.json` exists on disk with 240 floats in `[0, 1]`.
2. Open the Listen view. → The waveform card paints the real per-chapter envelope (silences are visibly silent, loud passages are visibly louder).
3. Hand-delete the `.peaks.json` for one chapter on disk and refresh. → That chapter's waveform card falls back to the empty / mock visual; the Listen view does NOT 500 or surface an error.
4. Re-render the same chapter. → A new `.peaks.json` lands and the waveform refreshes on the next meta fetch.
5. Open a chapter generated BEFORE this plan shipped (no `.peaks.json` on disk). → Meta endpoint returns `peaks: []`; Listen view degrades gracefully exactly as in step 3.

## Out of scope

- **Frontend changes.** The Listen view's `Waveform` component already consumes `peaks: number[]`. The `peaks: []` mock-data fallback line in `src/lib/api.ts:795` (the revision-diff mock for the preserved "A" take) is intentionally left as-is — it's mock mode, not the real-mode path this plan touches.
- **Preserved (`.previous.peaks.json`) emission.** `preserveExistingAsPrevious` does not move peaks alongside the audio + segments pair today; the `/audio/previous` endpoint therefore typically returns `peaks: []` for the audition variant. That's a deliberate trade-off: the audition workflow is short-lived (accept/reject inside one session) and the A/B comparison doesn't lean on the waveform shape. A future preserve extension can light up both sides without a route change — the symmetrical `readPeaksOrEmpty` call is already in place.
- **Per-chapter loudness / true-peak / channel-layout metadata.** Tracked separately as BACKLOG Could #3; the sibling-file shape (`<slug>.peaks.json` with a single field today) is intentionally extensible — future metadata can land under a new top-level key (`{ peaks, loudness, … }`) without a schema version.
- **Recomputing peaks for legacy chapters in bulk.** Optional. Could be added later as a `scripts/backfill-peaks.mjs` that walks the workspace and emits sibling files for chapters that have an MP3 but no `.peaks.json`. Out of scope for the initial plan — the meta endpoint's graceful fallback means legacy chapters keep working, just without the new waveform fidelity.

## Ship notes

(Filled in when status flips to `stable`.)
