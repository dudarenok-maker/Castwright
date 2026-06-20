---
status: active
shipped: null
owner: null
---

# 227 — Generation issue-waveform: per-segment QA overlay + MiniPlayer jump

> Status: active
> Issue: fs-47 (#959) · PR: #958
> Key files: `src/lib/chapter-issues.ts`, `src/components/waveform.tsx`, `src/views/generation.tsx` (ChapterDetailPanel), `src/components/mini-player.tsx`, `src/components/layout.tsx`, `server/src/routes/chapter-audio.ts`
> URL surface: `#/books/<id>/generate`, inline MiniPlayer preview strip
> OpenAPI ops: `GET /api/books/{bookId}/chapters/{chapterId}/audio` (extended `segments[]` with `suspect`, `reasons`)

## Benefit / Rationale

- **User:** suspect segments are now visible as amber bars on the generation-row waveform and in the MiniPlayer scrubber, so quality issues are discoverable without listening to the whole chapter. The ⚠ jump button and context-gated auto-seek take the reviewer straight to the problem.
- **Technical:** a pure `deriveIssues` function turns raw server QA flags into padded+merged `IssueRegion` structs, decoupling the rendering layer from the segments.json format.
- **Architectural:** `suspect`/`reasons` are published additivly (absent on clean/legacy renders) — no migration needed. The `Waveform` component gains an optional `issues` prop and is unchanged for callers that don't pass it.

## Architectural impact

**New seams / extension points:**
- `IssueRegion { startFrac, endFrac, seekSec, reasons }` in `src/lib/chapter-issues.ts` — the stable type that flows from `deriveIssues` to `Waveform` and `MiniPlayer`.
- `Waveform` `issues` prop — optional; absent → component renders as before.
- `MiniPlayer` `autoSeekToIssues?: boolean` prop — controls whether `onLoadedMetadata` seeks to the first issue instead of the resume bookmark. Set to `true` only when `view === 'generate'` in `layout.tsx`.
- `publishSegment` in `server/src/routes/chapter-audio.ts` — maps per-segment QA flags to the public shape.

**Invariants preserved:**
- Hash-router and `ui.stage` discriminated-union are untouched.
- `Waveform` callers that pass no `issues` prop get the original appearance (no amber, no sr-only list).
- The resume-bookmark logic (`putListenProgress` / `getListenProgress`) is preserved and wins in the Listen context (`autoSeekToIssues` defaults to `false`).

**Migration story:** additive. `suspect` and `reasons` are absent from legacy/clean renders; consumers treat absence as "no issues".

**Reversibility:** remove `issues` prop from `Waveform`, remove `autoSeekToIssues` from `MiniPlayer`, drop `publishSegment` changes on the server. No stored data changes.

## Invariants to preserve

1. **`publishSegment` ASR-noise gate** (`server/src/routes/chapter-audio.ts:143-157`): `suspect` is `true` when either `seg.suspect` (pre-assembly QA) or `seg.asrSuspect` (ASR content-QA) is true. `reasons` includes `seg.qa.reasons` only when `seg.suspect`; includes `seg.asr.reasons` only when `seg.asrSuspect === true` — inconclusive ASR verdicts (`asrSuspect` false/absent) never leak their reasons into the public payload.

2. **`deriveIssues` pad+merge+degenerate-drop** (`src/lib/chapter-issues.ts:22-58`): pads each suspect segment by `ISSUE_CONTEXT_PAD_SEC` (2 s) on both sides (clamped to [0, duration]), merges overlapping/abutting padded ranges (gap ≤ 0 between consecutive padded ends and starts), and drops any region whose `startFrac ≤ 0 && endFrac ≥ 1` (covers the whole track — indicates a short or fully-suspect chapter where band-painting adds no signal).

3. **`Waveform` amber overlay + sr-only** (`src/components/waveform.tsx`): when `issues.length > 0`, bars whose index falls inside an issue's `[startFrac, endFrac]` range are coloured `bg-amber-400` and the bar row carries `aria-hidden="true"`; a `<ul className="sr-only">` lists `Issue at <time>: <reason>` per issue. When `issues` is empty or absent: no amber bars, no sr-only list — component is byte-identical to its pre-feature behaviour.

4. **Generation-row waveform** (`src/views/generation.tsx`, `ChapterDetailPanel`): the `Waveform` renders only when the chapter is `done` and `hasPeaks` (non-empty `audio.peaks`). When `chapter.audioQa?.status === 'suspect'` and `issues.length === 0` (chapter-level flag only, no per-segment precision), a 2 px amber underline strip replaces the amber bars, and a "Chapter-level issue" caption is shown instead of the "N issues to review" count.

5. **MiniPlayer `autoSeekToIssues` context gate** (`src/components/layout.tsx:1381`, `src/components/mini-player.tsx:1010`): `autoSeekToIssues` is passed as `view === 'generate'` from `layout.tsx`. Inside `MiniPlayer.onLoadedMetadata`, the auto-seek block runs only when `autoSeekToIssues && issuesRef.current.length > 0` and seeks to `issues[0].seekSec`. This block runs **before** the resume-bookmark block, so it overrides the listen-progress resume in the generate context. In the Listen context (`autoSeekToIssues` false/absent), the resume bookmark wins unchanged.

## Test plan

### Automated coverage

- **Vitest unit** (`src/lib/chapter-issues.test.ts`) — asserts: single padded segment produces correct `seekSec`/`startFrac`/`endFrac`; two segments within 2×PAD merge into one region with combined reasons; two far-apart segments stay separate; near-start clamp yields `startFrac = 0`; whole-track degenerate region is dropped; non-suspect segments are ignored; `ISSUE_CONTEXT_PAD_SEC` is 2.
- **Vitest unit** (`src/components/waveform.test.tsx`) — asserts: `issues` present → amber bars rendered (`bg-amber-400`), bar row is `aria-hidden`, sr-only list contains `Issue at <time>: <reason>`; no `issues` → no amber bars, no sr-only list; empty peaks with issues → sr-only list still rendered.
- **Vitest unit** (`src/components/mini-player.test.tsx`, `describe('MiniPlayer — issue waveform scrubber')`) — asserts: when a suspect segment is resolved, sr-only issue list appears and `scrubber-thumb` is present.
- **Vitest unit** (`src/components/mini-player.test.tsx`, `describe('MiniPlayer — jump-to-issue + auto-seek')`) — asserts: ⚠ Next-issue click seeks `el.currentTime` to `seekSec` (first issue); `autoSeekToIssues=true` + listen-progress resume → `onLoadedMetadata` seeks to first issue (overrides 25 s resume); `autoSeekToIssues=false` + same resume → `onLoadedMetadata` uses the 25 s bookmark.
- **Vitest server** (`server/src/routes/chapter-audio.test.ts`) — asserts: `publishSegment` outputs `suspect: true` + `qa.reasons` for a segment-QA suspect; `suspect: true` + `asr.reasons` for an ASR suspect; does NOT include `asr.reasons` for inconclusive ASR (`asrSuspect: false`); clean segment omits `suspect`/`reasons` entirely.
- **Playwright e2e** (`e2e/issue-waveform.spec.ts`) — asserts end-to-end: on the Solway Bay generate view with two mock suspect segments, the Next-issue button advances the scrubber thumb from the issue-1 zone (≈30–39%) to the issue-2 zone (≈68–73%); `autoSeekToIssues` places the thumb at issue-1 before the click.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`).

1. **Open the generate view.** Navigate to `#/books/sb/generate` (Solway Bay fixture — all 18 chapters pre-seeded as `done`). Expected: chapter list loads, chapter rows show waveform strips under done rows.

2. **Verify issue waveform on a done row.** The Solway Bay mock seeds Chapter 1 with two suspect segments (≈768 s and ≈1624 s in a 2304 s chapter). Expand Chapter 1's detail panel. Expected: amber bars visible in the waveform at roughly 1/3 and 2/3 of the track; "2 issues to review" caption below.

3. **Verify chapter-level baseline.** Use The Coalfall Commission fixture (`#/books/cc/generate`) with a chapter that has `audioQa.status = 'suspect'` but no per-segment flags. Expected: 2 px amber underline strip on the waveform; "Chapter-level issue" caption (no "N issues" count).

4. **Open MiniPlayer with issues.** Click Preview on a done Solway Bay chapter. Expected: MiniPlayer appears; scrubber shows amber bars in the issue zones; ⚠ Next-issue button visible; auto-seek moves playhead to the first issue (≈766 s / ≈33% thumb position).

5. **Jump to second issue.** Click the Next-issue button. Expected: scrubber thumb advances to the second issue zone (≈1622 s / ≈70% thumb position); clicking again wraps back to issue 1.

6. **Verify Listen context does NOT auto-seek.** Navigate to `#/books/sb/listen`. Open any chapter with a prior `getListenProgress` resume point. Expected: MiniPlayer resumes at the saved bookmark, NOT at the first issue.

7. **Verify no amber when no issues.** Open a chapter that is clean (no suspect segments). Expected: waveform renders without any amber bars; no sr-only list; no ⚠ button in MiniPlayer.

The canonical pipeline fixture for deeper regression: `server/src/__fixtures__/the-coalfall-commission.md`. Use it to confirm end-to-end generation picks up segment QA flags from the sidecar and serves them via the chapter-audio route.

## Out of scope

- Repairing or re-recording suspect segments in-app — that is a separate feature.
- Surfacing suspect segments in the Listen view — the waveform scrubber there is unchanged.
- Whisper ASR enablement (`SEG_ASR_ENABLED`) — plan 186; this plan only ensures ASR reasons pass through correctly when ASR is on.

## Ship notes

(To be filled when status flips to `stable`.)
