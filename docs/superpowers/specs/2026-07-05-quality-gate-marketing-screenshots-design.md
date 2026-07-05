# Quality Gate — real screenshots + comprehensive wiki coverage

Status: draft
Date: 2026-07-05

## Context

`docs/wiki/The-Quality-Gate.md` ships today with a placeholder note: the acoustic
QA gate's screenshots were never captured because the Coalfall Commission run used
to build the wiki rendered clean (nothing flagged, nothing to show). Tracked as
issue #1286 ("docs: capture a real flagged/re-recorded Quality Gate example for the
wiki").

Investigation while scoping #1286 found the gap is smaller than it looked, and
also found more than it looked for: the QA gate is one of Castwright's core
feature differentiators (`brand/project-narrative.md`'s own description leads
with it — "the honest worry with any AI voice is a line that comes out fluent
but wrong"), and the current wiki page under-documents it. There are **three**
segment-level QA gates, not the one the page currently describes, plus the
separate chapter-level voice-drift detector the page already covers as "Check
two." This spec covers making the wiki page comprehensive and brand-voiced
across all of them, and capturing real, dual-purposed (wiki + marketing)
screenshots to back it.

## The QA mechanisms (ground truth, for the prose rewrite)

All three of the following write into the same per-segment `suspect`/`reasons`
data and roll up into the same chapter `audioQa` / "Suspect" badge / amber
waveform system — one screenshot with three flagged segments (one per flavor)
honestly represents all three:

1. **Acoustic-signal QA** (`server/src/tts/segment-qa.ts`, always-on) — dead
   air, near-silence, clipping/runaway, duration drift against expected length.
2. **ASR content-QA** (`server/src/tts/segment-asr-qa.ts`, `SEG_ASR_ENABLED`,
   **off by default**) — Whisper transcribes each line and flags word-error-rate
   / truncation / substitution against the script — "fluent but wrong words."
3. **Speaker-verification QA** (`SEG_SPK_ENABLED`, **off by default**, the
   srv-36 "render integrity" work) — an ECAPA voice-embedding check per line;
   flags a line that's acoustically a different voice even though the words
   are right.

Both off-by-default gates are user-toggleable in **Advanced Configuration → QA
gates** (matches existing phrasing in `src/data/help-topics.ts` and
`src/components/whisper-install.tsx`).

Separate from all three: the **voice-drift detector** (already "Check two" in
the wiki) — a chapter-level comparison of a rendered chapter against the
character's established *profile* (tone attributes: warmth/pace/authority/
emotion), surfaced through its own `DriftEvent`/drift-report-modal system, not
the segment/audioQa pipeline above.

Not covered: the golden-audio regression harness (CI/dev-only, no user surface,
out of scope for a user-facing wiki page).

## Wiki structure decision

Keep the existing two-check framing (**Check one: the acoustic gate** / **Check
two: voice drift**) rather than splitting into four headings. Check one's prose
expands to name and describe all three segment-level flavors as one family
feeding the same Suspect badge — matches how the code actually works and avoids
implying four independent systems where there's really one visual surface plus
one separate detector.

## Screenshots (three, dual-purposed)

All three captured at desktop viewport, both light + dark (marketing capture's
default), landing in `mockups/marketing-screens/` (git-ignored, reusable for
marketing) — light-theme copies get committed into
`docs/wiki/images/the-quality-gate/` for the wiki embed, following the existing
`images/<page-slug>/NN-name.png` convention.

1. **`chapter-suspect`** — `#/books/hollow-tide-2/generate`, action expands
   Saltgrave chapter 3's row. Shows the Suspect badge, amber waveform bands,
   and "N issues to review" caption, with three flagged segments — one per
   gate flavor (see Fixtures below).
2. **`voice-drift-report`** — `#/books/hollow-tide-2/cast`, action clicks the
   "Voice drift detected in N chapters" banner to open the modal. Two drift
   events (Severe + Moderate) so the severity-tiered UI and Auto-regen control
   both show.
3. **`preview-flagged`** — `#/books/hollow-tide-2/generate`, action clicks
   "Preview" on chapter 3. Shows the amber band persisting into the pinned
   mini-player scrubber (the "a flag follows you" claim in the page's closing
   section).

None of the three existing scenes (`generating`, `cast-reuse`) are modified —
`generating.*` is already embedded in `Installing-Castwright.md`.

## Fixture changes (additive, `DEMO_CAPTURE`-gated only — no production code path changes)

All in `src/mocks/marketing/hollow-tide.ts` unless noted.

**Saltgrave chapter 3 → `audioQa`:**
```ts
audioQa: {
  status: 'suspect',
  reasons: [
    'Near-silent stretch before a line',
    'Word substitution against the script',
    "A line drifted from Magistrate Cross's profile",
  ],
}
```
This flows through the existing hydrate path (`chapters-slice.ts:335`) with no
code change — it's what the top-level Suspect pill checks.

**Segment data for chapter 3** — `mockGetChapterAudio` in `src/lib/api.ts`
currently returns the same two generic canned suspect segments
(`halloran`/`narrator`) for literally any chapter, which is fine for ordinary
mock-mode testing but uses a character id (`halloran`) that doesn't exist in
Saltgrave's cast and only demonstrates the acoustic flavor. Add a
`DEMO_CAPTURE`-gated branch: when `bookId === 'hollow-tide-2' && chapterId ===
3`, return three segments using real Saltgrave cast ids, one per gate flavor:

| Character | Flavor | Reason text |
|---|---|---|
| narrator | acoustic | "Near-silent — dead air detected before this line." |
| dockhand-remy | ASR content | 'Content drift — heard "the ropes" where the script says "the ledger."' |
| magistrate-cross | speaker-verification | "Voice drifted from Magistrate Cross's established profile for this line." |

**New `HOLLOW_TIDE_DRIFT_EVENTS: DriftEvent[]`** (shape mirrors
`src/data/drift.ts`), two events on Saltgrave (`hollow-tide-2`):
- Severe — Insp. Cray, chapter 2 (done), factor `register` (mirrors the
  existing dev fixture's Eliza events — "manuscript edits propagated the
  change" narrative device), `suggestedAction: 'regenerate_chapter'`
  (Auto-regen shows for Severe).
- Moderate — Dr. Wren, chapter 5 (done), factor `warmth`.

**Wire into `mockPollRevisions` / `pollRevisionsBulk`** (`src/lib/api.ts`):
under `DEMO_CAPTURE`, merge `HOLLOW_TIDE_DRIFT_EVENTS` (filtered by
`args.bookId`) into the returned `drift` array in addition to the existing
`VOICE_DRIFT_EVENTS` filter — additive, doesn't touch dev-mode (`sb`/`cc`)
behavior.

## Capture + embed steps

1. `CAPTURE_SCENE=chapter-suspect npm run capture:marketing`,
   `CAPTURE_SCENE=voice-drift-report npm run capture:marketing`,
   `CAPTURE_SCENE=preview-flagged npm run capture:marketing` — each captures
   both themes.
2. Copy the light-theme PNGs into new `docs/wiki/images/the-quality-gate/`:
   `01-suspect-chapter.png`, `02-voice-drift-report.png`,
   `03-preview-surface.png`.
3. Rewrite `docs/wiki/The-Quality-Gate.md`:
   - Expand "Check one" prose to name all three segment gates in brand voice
     (modeled on `brand/project-narrative.md`'s existing QA paragraph and the
     off-by-default honesty already used in `help-topics.ts`), embed
     screenshot 1.
   - Keep "Check two: voice drift" prose, embed screenshot 2, remove the
     "(Refs #1286)" placeholder callout.
   - Keep the preview-surface closing section, embed screenshot 3.
4. `npm run wiki:sync` — **only after explicit confirmation**, since it force-
   pushes to the separate public `Castwright.wiki.git` remote.

## Testing

Marketing capture is explicitly a tool, not a regression gate (excluded from
`npm run verify`). The new `DEMO_CAPTURE` branches in `mockGetChapterAudio` and
`mockPollRevisions`/`pollRevisionsBulk` are new logic and get a small Vitest
unit test each: asserting the flagged-chapter segment override returns the
three expected reason flavors, and that `pollRevisions`/`pollRevisionsBulk`
return `HOLLOW_TIDE_DRIFT_EVENTS` for `hollow-tide-2` under `DEMO_CAPTURE`
while non-demo-capture mode is unaffected. The scene registry's existing guard
in `capture.spec.ts` (dup-id / hash-prefix check) covers the three new rows for
free.

## Mechanics

New branch off `main` (`docs/frontend-1286-quality-gate-screenshots`). PR body
`Closes #1286`. Touches `src/mocks/`, `src/lib/api.ts`, `e2e/marketing/`, and
`docs/wiki/` — gets the standard `code-review` gate at `medium` effort (single-
scope docs+fixture change, not a multi-scope refactor).
