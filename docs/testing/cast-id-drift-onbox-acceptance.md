# Cast/analysis characterId drift (Wave 1) — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with a real sidecar and the real, already-affected book. Do not
> pre-fill them.
>
> Design of record: [`docs/superpowers/specs/2026-08-01-cast-character-identity-design.md`](../superpowers/specs/2026-08-01-cast-character-identity-design.md)
> Plan of record: [`docs/superpowers/plans/2026-08-01-cast-character-identity.md`](../superpowers/plans/2026-08-01-cast-character-identity.md)
> Register row: [`onbox-acceptance-register.md` A32](onbox-acceptance-register.md)
> Issue: [#2040](https://github.com/dudarenok-maker/Castwright/issues/2040)

---

## 1. Purpose & scope

Wave 1 shipped a **read-time** fix only: `buildCastResolver` now resolves a
frozen segment's `characterId` through a Unicode-preserving separator/case
normaliser (`normaliseIdKey`) before falling through to the narrator. It is
entirely unit- and route-tested against synthetic fixtures. What no automated
suite proves is the one thing the feature is *for* — that re-rendering a
chapter on the real, already-drifted workspace now puts the drifted
character's own voice on their lines instead of the narrator's.

A read-only, dry-run measurement of this already happened (see the design
spec §6): running the compiled resolver against the real 20-book workspace at
`C:\AudiobookWorkspace\books`, with an entirely empty history, recovers 68 of
the 188 orphaned segments — via the normalised-id tier alone, no schema
change. **That was an offline id-resolution check, not a render.** This run
sheet is the render: pressing the real "re-record this character" / chapter
regenerate button against a real sidecar and listening to what comes out.

**The fixture is real, not synthetic**, and its exact shape was confirmed by
reading the files directly ahead of this run sheet (2026-08-02):

- **Book:** *Playing with Fire* (Derek Landy, Skulduggery Pleasant), at
  `C:\AudiobookWorkspace\books\Derek Landy\Skulduggery Pleasant\Playing with Fire`
  (`bookId: derek-landy__skulduggery-pleasant__playing-with-fire`, English).
- **`the-torment`** — the analysis-cache id for cast character `the_torment`
  ("Torment", `voiceState: tuned`, `ttsEngine: qwen`, `ttsModelKey:
  qwen3-tts-1.7b`, tuned voice `qwen-YaC5ot82IqTLpeDbHd77F`). RC2: `the_torment`
  was minted by `cast-create.ts`'s underscore slugifier; the analyzer
  independently mints `the-torment` for the same character. **37** segments
  in `19-chapter-fifteen-point-blank.segments.json`, the rest spread across
  chapters 17, 20 and 38 (67 total across the book).
- **`lightning-dave`** — the analysis-cache id for cast character
  `lightning_dave` ("Lightning Dave", `voiceState: generated`, no voice
  override — a catalogue voice). **1** segment, in
  `16-chapter-twelve-barfight.segments.json`.
- **Negative control, same chapter: `pool-player-2`** — cast character
  `pool_player` ("Pool Player"). The analyzer's id carries a `-2` collision
  suffix that Tier B's separator/case normalisation does **not** strip
  (`normaliseIdKey` never equates ids whose letters differ, and `pool-player`
  vs `pool-player-2` differ by more than separators/case). **6** segments in
  `16-chapter-twelve-barfight.segments.json`. Wave 1 must **not** recover
  these — they need Wave 2 or Wave 3. If they resolve too, something is
  matching more aggressively than the design specifies and that is a defect,
  not a bonus.

**Confirmed pre-fix state (read directly from the files, 2026-08-02):** every
`the-torment` / `lightning-dave` / `pool-player-2` segment in the affected
chapters carries `"renderedFallbackEngine": "kokoro"` and **no**
`characterSnapshots` entry under its own id — i.e. today's narrator
substitution, exactly as the design describes. None carry
`renderedFallbackCharacterId` (that stamp postdates these chapters' last
render — #2023 shipped after them), so do not expect to see it flip; judge the
fix by the fields below instead.

## 2. Preconditions

- [ ] Real TTS sidecar running, Qwen resident (or loadable) — Torment's voice
      is on the `qwen3-tts-1.7b` tier. Not mock mode.
- [ ] The real workspace book above is present and untouched (`git status`
      equivalent for the workspace: do not run the Wave-3 repair script or any
      cast edit against it before this run — this row is about the resolver
      alone).
- [ ] **Back up the three affected chapter files first** —
      `16-chapter-twelve-barfight.segments.json`,
      `19-chapter-fifteen-point-blank.segments.json`, and their `.mp3`s —
      before re-rendering, so a bad run can be reverted without re-importing
      the book.
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

## 3. Re-render chapter 19 — the high-volume recovery case

1. Open *Playing with Fire* in the app. Re-record chapter 19
   ("Chapter Fifteen: Point Blank") — either via the chapter's own
   regenerate control, or a per-character re-record targeting Torment if the
   UI offers it for an unresolved id.
2. After it completes, read the fresh
   `19-chapter-fifteen-point-blank.segments.json` for the segments with
   `characterId: "the-torment"`.

Expected:

- `characterSnapshots["the-torment"]` now exists, with `voiceEngine: "qwen"`
  and `resolvedVoiceName` naming Torment's own tuned voice
  (`qwen-YaC5ot82IqTLpeDbHd77F`) — **not** `qwen-narrator`.
- Those segments no longer carry `renderedFallbackEngine: "kokoro"` (the
  fallback that only fires when the line is being rendered as a
  *different* character/engine than its own).

Result (`characterSnapshots["the-torment"].resolvedVoiceName`): ______________

Result (`renderedFallbackEngine` still present? Y/N): ________________________

3. **Listen to the chapter.** Torment is a menacing interrogator (his line at
   `groupIndex: 25` is "Kill the child."). Confirm the line at that beat is
   spoken in a distinct voice from the narrator's — not the same voice
   reading every other unattributed line in the chapter.

Result (by ear, distinct voice from narrator): _______________________________

## 4. Re-render chapter 16 — recovery AND the negative control together

4. Re-record chapter 16 ("Chapter Twelve: Barfight").
5. Read the fresh `16-chapter-twelve-barfight.segments.json`.

Expected for **`lightning-dave`** (1 segment, `groupIndex: 39`) — same
recovery shape as Torment: a `characterSnapshots["lightning-dave"]` entry
now exists and `renderedFallbackEngine: "kokoro"` is gone from that segment.

Result: _______________________________________________________________

Expected for **`pool-player-2`** (6 segments) — **must still fall back to the
narrator**, unchanged from before this PR: `renderedFallbackEngine: "kokoro"`
still present, no `characterSnapshots["pool-player-2"]` entry. This is the
row's negative control — Wave 1 explicitly does not close the `-2` collision
suffix case (that needs Wave 2/3), and this chapter is the one place both the
recovered and the not-yet-recovered case sit side by side.

Result (`pool-player-2` still narrator-substituted, unchanged): ______________

## 5. Cast-screen banner cross-check

6. Open the Cast screen for this book (the #2023 orphaned-id banner, per
   `RELEASE_NOTES.md`'s "A line attributed to a character Castwright doesn't
   recognise no longer renders in silence about it").

Expected: after the two re-renders above, the banner no longer names
`the-torment` or `lightning-dave` for this book. It still names
`pool-player-2` (and the book's other genuinely-unresolved ids, if any are
surfaced from the chapters not touched by this run).

Result: _______________________________________________________________

## 6. Outcome

- [ ] All sections run
- [ ] §3 and §4 run (the two that matter — the by-ear check is not
      optional; a resolved `resolvedVoiceName` with a silently-substituted
      voice underneath would not be caught by the JSON fields alone)
- [ ] Defects filed: ____________________________________

Record what was observed, by whom, and when — here and in the register row.
"The JSON fields look right" is not a substitute for the by-ear check in §3
step 3. **Do not run the Wave-3 repair pass or the Wave-2 remap against this
book as part of this acceptance run** — they don't exist yet on this branch,
and this row is scoped to the resolver alone.
