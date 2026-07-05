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
but wrong"), and the current wiki page under-documents it.

**Revision note (post-adversarial-review):** the first draft of this spec
claimed three segment-level QA gates all fed the same Suspect badge/waveform
surface. An Opus-tier `assumption-checker` pass (round 1) read the actual
publish path (`server/src/routes/chapter-audio.ts`'s `publishSegment`,
`server/src/tts/synthesise-chapter.ts`'s embed-pass code, and
`server/src/audio/render-integrity/aggregate.ts`) and found that claim
contradicted for the third gate. Corrected below — see "The QA mechanisms."

## The QA mechanisms (ground truth, for the prose rewrite)

**Two** segment-level gates write into the same per-segment `suspect`/
`reasons` data and roll up into the same chapter `audioQa` / "Suspect" badge /
amber waveform system — confirmed by reading `publishSegment` in
`server/src/routes/chapter-audio.ts:143-158`, which computes `suspect =
Boolean(s.suspect || s.asrSuspect)` and merges `qa.reasons`/`asr.reasons`
accordingly. One screenshot with two flagged segments (one per flavor)
honestly represents both:

1. **Acoustic-signal QA** (`server/src/tts/segment-qa.ts`, always-on) — dead
   air, near-silence, clipping/runaway, duration drift against expected length.
2. **ASR content-QA** (`server/src/tts/segment-asr-qa.ts`, `SEG_ASR_ENABLED`,
   **off by default**, user-toggleable in **Advanced Configuration → QA
   gates**, matching existing phrasing in `src/data/help-topics.ts` and
   `src/components/whisper-install.tsx`) — Whisper transcribes each line and
   flags word-error-rate / truncation / substitution against the script —
   "fluent but wrong words."

**Not the same surface — excluded from the wiki entirely:**
**Speaker-verification QA** (`SEG_SPK_ENABLED`, off by default, the srv-36
"render integrity" work) is a genuinely separate mechanism: it runs an ECAPA
voice-embedding pass per line (`synthesise-chapter.ts:1672-1696`), but the
result is returned as a *chapter-level* `embeddings: EmbeddingRow[]` array,
never folded into a segment's `suspect`/`reasons`. It's then scored offline,
per-book, by `server/src/audio/render-integrity/aggregate.ts` — an
operator-run batch tool that builds per-character voice centroids and writes
one `<slug>.render-integrity.json` per chapter (matches the "operator
re-render → gates → go/no-go" workflow this was built for). **A repo-wide
search of `src/` found zero frontend references to embeddings, render-
integrity, or speaker-verification** — there is no Advanced Settings toggle
UI and no result display in the app today. Same treatment as the golden-audio
regression harness: an internal/operator-only QA mechanism with no user-facing
surface, so it doesn't belong in a user-facing wiki page and cannot appear in
an app screenshot. (Separately, `src/data/help-topics.ts:150-159`'s
"voice-consistency-flag" entry currently describes this as if it has an
in-app "flagged line," which appears to be a pre-existing inaccuracy in that
help topic — out of scope for this spec to fix, noted here so it isn't
mistaken for confirmation that a surface exists.)

Separate from both: the **voice-drift detector** (already "Check two" in
the wiki) — a chapter-level comparison of a rendered chapter against the
character's established *profile* (tone attributes: warmth/pace/authority/
emotion), surfaced through its own `DriftEvent`/drift-report-modal system, not
the segment/audioQa pipeline above.

Not covered: the golden-audio regression harness (CI/dev-only, no user surface,
out of scope for a user-facing wiki page) — same reasoning as speaker-
verification above.

## Wiki structure decision

Keep the existing two-check framing (**Check one: the acoustic gate** / **Check
two: voice drift**) rather than splitting into more headings. Check one's prose
expands to name and describe the two segment-level flavors (acoustic + ASR
content) as one family feeding the same Suspect badge — matches how the code
actually works. Speaker-verification is not named as a third flavor of Check
one, or as its own check — it has no user-facing surface to document.

## Screenshots (three, dual-purposed)

All three captured at desktop viewport, both light + dark (marketing capture's
default), landing in `mockups/marketing-screens/` (git-ignored, reusable for
marketing) — light-theme copies get committed into
`docs/wiki/images/the-quality-gate/` for the wiki embed, following the existing
`images/<page-slug>/NN-name.png` convention.

1. **`chapter-suspect`** — `#/books/hollow-tide-2/generate`, action expands
   Saltgrave chapter 3's row. Shows the Suspect badge, amber waveform bands,
   and "N issues to review" caption, with **two** flagged segments — one per
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
  ],
}
```
This flows through the existing hydrate path (`chapters-slice.ts:335`) with no
code change — it's what the top-level Suspect pill checks.

**Segment data for chapter 3** — `mockGetChapterAudio` in `src/lib/api.ts`
currently returns the same two generic canned suspect segments
(`halloran`/`narrator`) for literally any chapter, which is fine for ordinary
mock-mode testing but uses a character id (`halloran`) that doesn't exist in
Saltgrave's cast. Add a `DEMO_CAPTURE`-gated branch: when `bookId ===
'hollow-tide-2' && chapterId === 3`, return two segments using real Saltgrave
cast ids, one per gate flavor that actually shares this surface:

| Character | Flavor | Reason text |
|---|---|---|
| narrator | acoustic | "Near-silent — dead air detected before this line." |
| dockhand-remy | ASR content | 'Content drift — heard "the ropes" where the script says "the ledger."' |

**Implementation note:** `mockGetChapterAudio` currently destructures only
`{ chapterId, duration }` from its `AudioArgs` parameter (`api.ts:1657`);
`bookId` is already part of the `AudioArgs` type (`api.ts:631`) and already
passed by the caller (`ChapterSegmentStrip` in `generation.tsx` calls
`api.getChapterAudio({ bookId, chapterId: chapter.id })`), so this is a
one-line destructure widening, not a caller change.

**New `HOLLOW_TIDE_DRIFT_EVENTS: DriftEvent[]`** (full shape required by
`DriftEvent` in `src/data/drift.ts` — `chapterTitle`, `factorLabel`,
`description`, `snapshot`, `current`, `detected`, `suggestedAction` are all
mandatory; spelled out here so nothing is left for an implementer to invent):

```ts
export const HOLLOW_TIDE_DRIFT_EVENTS: DriftEvent[] = [
  {
    id: 'drift:hollow-tide-2:2:insp-cray:register',
    bookId: 'hollow-tide-2',
    characterId: 'insp-cray',
    chapterId: 2,
    chapterTitle: 'Chapter 2',
    severity: 'severe',
    factor: 'register',
    factorLabel: 'Vocabulary register',
    description:
      "Cray's register here reads far more formal than his established " +
      "dogged, plainspoken voice from Book 1 — likely a manuscript edit " +
      'sharpening his dialogue after this chapter rendered.',
    metrics: { current: 70, expected: 35, unit: 'formality' },
    snapshot: {
      voiceId: 'v_marin_cray', gender: 'male', ageRange: 'adult',
      tone: { warmth: 40, pace: 45, authority: 85, emotion: 50 },
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
    },
    current: {
      name: 'Insp. Cray', voiceId: 'v_marin_cray', gender: 'male', ageRange: 'adult',
      tone: { warmth: 40, pace: 30, authority: 85, emotion: 30 },
      attributes: ['Male', 'Baritone', 'Northern English', '50s', 'Dogged'],
    },
    detected: '2 hr ago',
    suggestedAction: 'regenerate_chapter',
    autoQueueable: true, // required for the Auto-regen control to render —
    // it's a field the SERVER sets (api-types.ts:3454's "today: severity ===
    // 'severe'"), not something the client derives, so a hand-authored mock
    // event must set it explicitly or the modal falls back to manual Regenerate.
  },
  {
    id: 'drift:hollow-tide-2:5:dr-wren:warmth',
    bookId: 'hollow-tide-2',
    characterId: 'dr-wren',
    chapterId: 5,
    chapterTitle: 'Chapter 5',
    severity: 'moderate',
    factor: 'warmth',
    factorLabel: 'Warmth',
    description:
      "Wren reads cooler here than her established precise-but-humane " +
      'profile — worth a listen before shipping.',
    metrics: { current: 40, expected: 58, unit: 'warmth score' },
    snapshot: {
      voiceId: 'v_marin_wren', gender: 'female', ageRange: 'adult',
      tone: { warmth: 58, pace: 40, authority: 60, emotion: 45 },
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
    },
    current: {
      name: 'Dr. Wren', voiceId: 'v_marin_wren', gender: 'female', ageRange: 'adult',
      tone: { warmth: 40, pace: 40, authority: 60, emotion: 45 },
      attributes: ['Female', 'Mezzo', 'RP English', '40s', 'Precise'],
    },
    detected: '1 hr ago',
    suggestedAction: 'review',
  },
];
```

Both chapters (2 and 5) are within Saltgrave's 7 done chapters
(`completedSlugs` = first 7 of 11, `hollow-tide.ts:240`).

**Wire into `mockPollRevisions`** (`src/lib/api.ts`) only — under
`DEMO_CAPTURE`, merge `HOLLOW_TIDE_DRIFT_EVENTS` (filtered by `args.bookId`)
into the returned `drift` array in addition to the existing
`VOICE_DRIFT_EVENTS` filter. `pollRevisionsBulk`'s mock (`api.ts:7762-7773`)
already delegates per-book to `mockPollRevisions`, so it inherits the new
events for free — no separate wiring needed there (the original draft of this
spec over-specified this and risked a double-merge).

**`PENDING_REVISIONS` bleed:** `mockPollRevisions` currently returns
`pending: PENDING_REVISIONS` (`src/data/revisions.ts`'s dev fixture, an
Eliza/Book-`sb` revision-diff with no `bookId` field) unconditionally for
*every* book (`api.ts:1773`), and `pending.length > 0` is one of the triggers
for the top-bar Status pill (`layout.tsx` line ~1521). Today this doesn't
visibly matter for Hollow Tide because nothing else populates the poll
response for those book ids; once `HOLLOW_TIDE_DRIFT_EVENTS` makes the
response non-trivial, an unrelated Eliza pending-revision surface could bleed
into the `voice-drift-report` and `preview-flagged` scenes. Fix: under
`DEMO_CAPTURE`, return `pending: []` for Hollow Tide book ids in
`mockPollRevisions` (dev-mode `sb`/`cc` behavior unaffected).

## Capture + embed steps

1. `CAPTURE_SCENE=chapter-suspect npm run capture:marketing`,
   `CAPTURE_SCENE=voice-drift-report npm run capture:marketing`,
   `CAPTURE_SCENE=preview-flagged npm run capture:marketing` — each captures
   both themes.
2. Copy the light-theme PNGs into new `docs/wiki/images/the-quality-gate/`:
   `01-suspect-chapter.png`, `02-voice-drift-report.png`,
   `03-preview-surface.png`.
3. Rewrite `docs/wiki/The-Quality-Gate.md`:
   - Expand "Check one" prose to name both segment gates in brand voice
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
`mockPollRevisions` are new logic and get a small Vitest unit test each:
asserting the flagged-chapter segment override returns the two expected
reason flavors (and only for `hollow-tide-2` chapter 3 — every other
chapter/book keeps the existing generic canned segments), and that
`pollRevisions`/`pollRevisionsBulk` return `HOLLOW_TIDE_DRIFT_EVENTS` with
`pending: []` for `hollow-tide-2` under `DEMO_CAPTURE`, while non-demo-capture
mode is unaffected. The scene registry's existing guard in `capture.spec.ts`
(dup-id / hash-prefix check) covers the three new rows for free.

## Mechanics

New branch off `main` (`docs/frontend-1286-quality-gate-screenshots`). PR body
`Closes #1286`. Touches `src/mocks/`, `src/lib/api.ts`, `e2e/marketing/`, and
`docs/wiki/` — gets the standard `code-review` gate at `medium` effort (single-
scope docs+fixture change, not a multi-scope refactor).
