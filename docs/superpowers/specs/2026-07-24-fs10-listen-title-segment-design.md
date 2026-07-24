# fs-10 — Chapter-title segment on the Listen-view timeline

> Spec (validated design) · 2026-07-24 · fs-10 / [#412](https://github.com/dudarenok-maker/Castwright/issues/412)
> Branch: `feat/frontend-fs10-title-segment`
> Revised after an Opus-tier `assumption-checker` pass (2026-07-24) — see §10 for what changed
> and why. The pass contradicted six claims in the first draft, including the direction of the
> bug in §5.

## 1. Goal & scope

Since PR #101 every rendered chapter opens with a synthetic, narrator-voiced **title beat** —
`server/src/tts/synthesise-chapter.ts:1091-1099` writes it into `<slug>.segments.json` as
`{ groupIndex: -1, characterId: <narrator>, sentenceIds: [], kind: 'title', startSec, endSec }`.
The beat is audible, and the caption/SRT export already treats it as a first-class cue
(`server/src/export/caption-cues.ts:77,109,142,179`) — but it is invisible **in the app**, because
`server/src/routes/chapter-audio.ts:240` strips it before the `ChapterAudio` payload leaves the
server.

This spec surfaces it in the app. **In scope:**

1. Publish `kind` on the `ChapterAudio` wire contract and stop filtering the title row.
2. Paint a labelled title band at the head of the Listen view's mini-player scrubber.
3. Fix the segment-index off-by-one the filter has been causing (§5 — a live, user-visible bug).
4. Give the Generation view's existing "Narrative order" strip a distinct title treatment.

**Out of scope:** any new timeline widget on the Listen chapter rows; per-segment bands on the
mini-player for non-title segments; editing or re-recording the title beat.

## 2. Three corrections to the issue as filed

**The `sentenceId` premise is stale.** #412 says the wire contract "types `sentenceId` as a
required integer" and asks for it to be widened. It isn't. `openapi.yaml:4684-4692` declares the
segment item with no `required` list, so `src/lib/api-types.ts:3613` already generates
`sentenceId?: number`. The only contract delta is `kind`.

**"The listen view's chapter timeline" does not exist.** The band strip #412 describes is
`ChapterSegmentStrip`, and it lives on the **Generation** view (`src/views/generation.tsx:2284`,
rendered at `:2048`). `src/components/listen/listen-player-region.tsx` renders a peaks-only
`<Waveform>` per chapter row — it has click-to-seek on the *markers rail* (`:574`), but no
per-segment band strip anywhere. The only continuous timeline reachable from Listen is the global
mini-player scrubber (`src/components/mini-player.tsx:723-738`), which is where the band lands.
The implementation therefore touches `mini-player.tsx`, **not** the `listen-player-region.tsx`
named in the issue.

**The acceptance criterion "clicking it seeks to t=0" is not being met as written** — deliberately.
See §6.1; this is the one design deviation that needs sign-off.

## 3. Contract change

`openapi.yaml`, `ChapterAudio.segments.items` — one added property:

```yaml
kind:
  type: string
  enum: [title]
  description: >-
    fs-10 — present only on the synthetic narrator-voiced chapter-title beat
    (empty sentenceIds[] on disk, see synthesise-chapter.ts). Absent on every
    ordinary sentence-backed segment and on every pre-fs-10 render, so
    consumers MUST treat absence as "sentence".
```

Then `npm run openapi:types` to regenerate `src/lib/api-types.ts`.

**`kind?: 'title'`, not `kind?: 'title' | 'sentence'`** as #412 proposed. It mirrors the on-disk
shape exactly (`server/src/audio/segments-io.ts:56`), no consumer needs to distinguish "explicitly
a sentence" from "unmarked", and emitting `kind: 'sentence'` on every segment of every chapter
would inflate the payload for a distinction nothing reads.

**One caveat the first draft got wrong.** Widening this enum later (`'silence'`, `'credits'`) is
non-breaking for the *producer* but **is** breaking for TypeScript consumers written as
`seg.kind === 'title' ? A : B` — a third value silently falls into `B`. Both consumers added here
(§6.1, §6.2) branch exactly that way. Accepted, because a future `kind` would need a deliberate
UI decision at each site anyway; recorded so that decision isn't made by accident.

## 4. Server pass-through

`server/src/routes/chapter-audio.ts`:

- `publishSegment` (`:143`) spreads `kind` through when it is `'title'`, matching the existing
  conditional-spread style used for `suspect`/`reasons`.
- Delete `.filter((s) => s.kind !== 'title')` from **both** handlers — `/audio` (`:240`) and
  `/audio/previous` (`:277`). Both, because they read the same on-disk shape through the same
  `publishSegment` helper and a divergence between them would be arbitrary. (The first draft
  justified this by claiming `revision-diff.tsx` indexes into the pair positionally. It does not —
  `:116-126` and `:305-312` both do `find((s) => s.sentenceId === seg.id)`, a keyed lookup that a
  title row can never match. The conclusion stands; the reasoning was wrong.)
- The title row publishes with `sentenceId: undefined` (`s.sentenceIds[0]` of an empty array),
  which the contract already permits.
- Rewrite the two now-false comment blocks at `:107-114` and `:233-238`.

**Invariant this establishes: for a given snapshot of `segments.json`, the published `segments[]`
index equals the on-disk `segments[]` index, unconditionally.** Verified against every writer —
`synthesise-chapter.ts:1091,1899` (title first, then body groups in order, no sort/dedupe),
`splice-chapter.ts:153-233` (every index pushed exactly once, ascending, in all three branches),
`finalize-chapter-write.ts:190-209` (verbatim). `segments-io.ts` readers are all key-based.

**The invariant holds per snapshot, not across time.** `onFixLine` fetches the payload at click
time (`src/routes/index.tsx:917-919`) and submits the index later, after the user picks a model; a
regen or splice in between shifts the disk array under a held index. That TOCTOU is pre-existing
and out of scope, but it bounds what §5's fix can promise.

## 5. The off-by-one this fixes

`src/lib/resolve-segment-for-sec.ts:4-5` documents its return value as "the segment index … the
same index the splice route's `segmentIndices` addresses". That claim is currently false.

Let `D = [title, s₁, s₂, …]` be the on-disk array and `W` the published array. Today
`W = D.slice(1)`, so `W[i] = D[i+1]`.

- `resolveSegmentForSec` returns the **wire** position `i` of the marked sentence (`:34`, `:44`) —
  the sentence itself is `D[i+1]`.
- `src/routes/index.tsx:929-936` passes `i` straight through as `preScoped.segmentIndices`
  (untouched by `fix-character-audio.tsx:97` → `splice-slice.ts:28` →
  `splice-runner-middleware.ts:79` → `api.streamSplice`).
- `server/src/routes/chapter-splice.ts:152-171` resolves it against `D`, landing on `D[i]`.

**"Fix this line" therefore targets the line *before* the one the user marked.** (The first draft
of this spec said "after" — the arithmetic above is the corrected direction.) Because
`buildSentenceGroups` emits one segment per sentence (`synthesise-chapter.ts:750-774`), this splits
into two regimes that behave very differently:

| Situation | Today's behaviour |
|---|---|
| Marked line is mid-run of one speaker (`D[i]` and `D[i+1]` share a `characterId`) | Ownership check at `chapter-splice.ts:166-168` passes → **the wrong line is silently re-recorded** |
| Marked line is the first of a speaker's run | Ownership check fails → `"segmentIndices must all belong to the character in this chapter."` |
| Marked line is the chapter's **first body sentence** (`i = 0` → `D[0]` = the title) | Ownership passes (narrator), then `isRerecordableSegment` strips it → `"No re-recordable lines for this character in this chapter (title-only)."` |

All three are live today on every title-led chapter. Both error strings are things users have
presumably been hitting with no explanation.

The fix: un-filtering realigns `W` with `D`, and the resolver must then stop *returning* the title
row while keeping its position:

- Add `if (seg.kind === 'title') continue;` alongside the existing `!seg.characterId` guard at
  `resolve-segment-for-sec.ts:29`. The loop index `i` is untouched — skipping **without
  renumbering** is precisely what keeps the returned index disk-aligned.
- Without the guard, a marker in the chapter's first ~3.5 s would resolve to segment 0: the title
  carries the narrator's `characterId`, so the existing guard waves it through, and it wins the
  nearest-edge fallback at `:37-40`.

**New behaviour this introduces, which §7 must cover:** with the guard in place, a marker dropped
in the lead silence or over the title now clamps to the nearest *non-title* segment — i.e. it
re-records the chapter's first body line instead of erroring. That is the right call (a marker
there means "fix the opening"), but it is new, not merely a bug removal.

This is a genuine bug fix riding along with the feature, and it is in scope because un-filtering is
what causes the realignment — it cannot be split into a separate PR.

## 6. UI

### 6.1 Mini-player title band (`src/components/mini-player.tsx`)

A **decorative, non-interactive** `<div>` rendered inside the existing scrubber container
(`:723-738`), as a sibling of the progress underline and thumb.

- **Geometry, from the payload — not hardcoded.** `left: (seg.start / totalSec) * 100%`,
  `width: max(4px, ((seg.end - seg.start) / totalSec) * 100%)`, full track height, peach at partial
  alpha so the bars read through, `rounded`. The width floor is necessary: a ~2 s beat in a
  41-minute chapter is 0.08 % of the track, i.e. sub-pixel.
- **Label, from the payload.** `title={`Chapter title · ${formatTime(seg.start)}–${formatTime(seg.end)}`}`
  plus an `sr-only` line, mirroring the pattern `Waveform` already uses for issue regions
  (`src/components/waveform.tsx:111-115`). The first draft hardcoded `0:00–0:03`; production's
  title runs `[1.5, ~3.5]` — `CHAPTER_LEAD_SILENCE_SEC = 1.5`
  (`synthesise-chapter.ts:387`) precedes it and `CHAPTER_POST_TITLE_SILENCE_SEC` follows it.
- **Clicks pass straight through.** No `onClick`, no `stopPropagation`, no `<button>`. The parent's
  existing `onScrub` (`:628-635`) handles the click exactly as it does today, and its
  `e.currentTarget.getBoundingClientRect()` still resolves to the parent track, so the seek maths
  is unchanged.
- **Absence.** Null-renders when no `kind === 'title'` segment is present — the graceful degrade
  #412 asks for. Chapters rendered before PR #101 simply show no band.

**This deliberately drops #412's "Clicking it seeks to t=0" acceptance line.** The first draft
specified a `<button>` with `stopPropagation`; the review showed that the 4–5 px width floor makes
the button *wider than the beat it represents*, so on a ~400 px scrubber it would swallow ~1.25 %
of the track — **~29 seconds of a 38-minute chapter that could no longer be scrubbed to**, every
click there hard-seeking to 0. That is a regression of an existing affordance, not the benign
"wanted 0.0, got 0.2" the first draft argued. Making the band decorative removes it, and also
removes the WCAG 2.5.5 touch-target exception the first draft asked for and the new tab stop inside
the player. What is lost is a low-value action already served by the previous-chapter and skip-back
controls; what is kept is the feature's actual stated benefit — *"listener sees 'you're hearing the
title now'"*.

### 6.2 Generation strip (`src/views/generation.tsx:2324-2338`)

The strip maps every segment to a character-palette band. Once the title row arrives it would
otherwise render in the narrator's colour, implying the narrator spoke a line where no sentence
exists. Branch on `kind === 'title'`: neutral `ink/25` fill, a small `minWidth` so it stays
visible, tooltip `Chapter title · <start>–<end>`.

Watch the flex arithmetic: bands are flex children with percentage widths inside `overflow-hidden`
(`:2321-2338`). Real chapters leave silence gaps so the widths sum to <100 %, but the *mock* currently
tiles `[0, totalSec]` contiguously — §8's mock fix (which introduces the real silence gaps) is what
keeps the sum under 100 % once a title band is added.

## 7. Testing

The §5 fix spans a wire→disk seam that **no single test can cross**: mock mode has no disk
(`mockStreamSplice`, `src/lib/api.ts:1670-1684`, fabricates the SSE and never reads
`segmentIndices`), so no Playwright spec can distinguish a correct index from an off-by-one. The
guarantee is therefore established by **two tests that compose**, and this is stated explicitly so
a future reader doesn't mistake either half for the whole:

- the server test pins *published array ≡ disk array*, and
- the resolver test pins *returned index is a position in the array as handed in, with title rows
  skipped but not renumbered*.

| Layer | File | Assertion |
|---|---|---|
| Server | `server/src/routes/chapter-audio.test.ts` | Write a **title-led** `segments.json`, GET `/audio`, assert for every `k` that `body.segments[k]` corresponds to `disk.segments[k]` **matched by `sentenceId`** (and `k=0` is the title: `kind: 'title'`, `sentenceId` undefined). Non-vacuous — fails on a re-added filter, a reorder, or a dedupe. Repeat for `/audio/previous` |
| Unit | `src/lib/resolve-segment-for-sec.test.ts` | Marker at 1.0 s (lead silence) in a title-led chapter resolves to index 1, not 0 — **fails before the guard**. Plus the §5 new behaviour: a marker over the title clamps to the first body segment |
| Unit | `src/lib/resolve-segment-for-sec.test.ts` | A title row in the middle of the array is skipped **without renumbering** the rows after it — pins "skip, don't renumber", the half the server test can't see |
| Unit | `src/components/mini-player.test.tsx` | Band renders with payload-derived left/width when a title segment is present; absent otherwise; **a click on the band still scrubs** (does not hard-seek to 0) — pins §6.1's pass-through |
| Unit | `src/views/generation.test.tsx` | Title band takes the neutral fill + `Chapter title` tooltip, not the narrator colour |
| E2E | `e2e/` (mini-player spec) | Band is visible on the scrubber for a title-led chapter. **Scoped to the band only** — it cannot cover §5 |

Dropped from the first draft: an assertion that "a post-title marker's index equals its disk index",
which passes before the change too (the function returns the loop position into whatever array it
is handed, so it is a restatement of `for (let i = 0; …)`); and the claim that the e2e covers §5.

## 8. Risks and accepted trade-offs

**The mock needs a production-shaped title segment.** `mockGetChapterAudio`
(`src/lib/api.ts:1686-1766`) emits four segments tiling `[0, totalSec]` contiguously, none a title,
so no frontend or e2e test can exercise any of this as-is. The first draft proposed inserting a
title at `[0, 3]` — which would have produced a fixture where two segments both claim seconds 0–3,
a shape the server *cannot* emit, making `resolveSegmentForSec`'s "direct hit wins immediately"
branch (`:33-35`) order-dependent in a way no real payload is. **Use production geometry instead:**
title at `[1.5, 3.5]`, body spans starting at 5.0. Consequence: every existing mock segment index
moves by one. The review swept the dependants — `api-demo-capture.test.ts:11-24` compares
`suspect`/`characterId`/`start`/`end` and never an index; `mini-player.test.tsx` fixtures are
hand-built; `layout.test.tsx` uses `segments: []`; `e2e/character-splice.spec.ts` asserts modal
state only — so nothing is expected to break. That is a prediction to verify while implementing,
not a licence to skip re-running the suites.

**The visual baselines at risk are `generate.png` / `generate-dark.png`, not `listen.png`.**
`listen.png` (`e2e/responsive/visual.spec.ts:149-154`) navigates to the listen route with the
mini-player closed, so the band cannot appear. But Solway Bay hydrates 18 `done` chapters and
`generation.tsx:2047-2049` renders a `ChapterSegmentStrip` for each, so **both** the new mock title
segment and §6.2's neutral-fill branch land inside `generate.png` / `generate-dark.png`
(`visual.spec.ts:155-167,337-343`). Baselines are per-platform (`e2e/{linux,win32}/`), so both need
regenerating.

**No test currently asserts the filter exists**, so removing it breaks nothing — and would have
been caught by nothing. The §7 server test closes that hole in both directions.

**Non-frontend consumers are unaffected, verified rather than assumed.** The Android companion
reads only `j['peaks']` from this endpoint (`apps/android/lib/src/data/api_client.dart:155`, with a
blanket catch); `caption-cues.ts` / `build-captions.ts` read the on-disk shape directly, not the
wire payload; no MCP surface consumes it.

## 9. Documentation

**`docs/features/176-character-splice.md` must be updated in the same diff.** It is `status: active`
and its 2026-06-05 entry documents the exact flow §5 changes — *"resolves the marker's timestamp →
the chapter segment (`lib/resolve-segment-for-sec.ts`) → `{characterId, segmentIndex}` …
`segmentIndices` threaded through `splice-slice`/`splice-runner-middleware`"*. `CLAUDE.md`'s
before-shipping checklist step 1 requires changed behaviour cited in an existing plan to be updated
alongside. The first draft's blanket "no `docs/features/` plan needed" was wrong on this point; no
*new* plan doc is needed, but that existing one is not optional.

Release notes get entries in both `docs/release-notes-next.md` and `RELEASE_NOTES.md`. The
user-visible delta is two things, not one: the title cue, **and** the corrected "Fix this line"
targeting — including that two confusing error messages (`"segmentIndices must all belong to…"`,
`"No re-recordable lines… (title-only)"`) stop appearing.

## 10. Revision note — what the assumption-checker pass changed

Confirmed sound and unchanged: the stale-`sentenceId` finding, the `kind?: 'title'` shape, the
index-parity invariant across every writer, the completeness of the consumer sweep (exactly four
`ChapterAudio.segments` consumers in `src/`), the `jumpToIssue`-vs-`onScrub` `currentSecRef`
observation, and the both-handlers conclusion.

Corrected:

1. **§5 direction reversed** — the bug targets the *preceding* line, not the following one; and the
   single failure mode is actually three distinct regimes, two of which surface as error strings.
2. **§6.1 redesigned** — the interactive `<button>` with a width floor would have made ~29 s of a
   38-minute chapter unscrubbable. Now a decorative pass-through band; the WCAG exception and the
   new tab stop both disappear, and #412's "seeks to t=0" line is knowingly dropped.
3. **§6.1 geometry/label corrected** — the title starts at 1.5 s, not 0; both are now derived from
   the payload rather than hardcoded.
4. **§7 rewritten** — one row was vacuous, one was a tautology, and the e2e row claimed coverage
   that mock mode makes impossible. Replaced with a `sentenceId`-matched server assertion and an
   explicit statement of how two tests compose to the guarantee.
5. **§8 mock geometry corrected** to production shape, and the at-risk visual baselines renamed
   from `listen.png` to `generate.png` / `generate-dark.png`.
6. **§9 corrected** — `docs/features/176-character-splice.md` is `active` and must be updated.
7. **§4's both-handlers reasoning replaced** — `revision-diff.tsx` matches by `sentenceId`, so it
   could not have desynchronised.
8. **§1/§2 narrowed** — the caption export already surfaces the title beat, and
   `listen-player-region.tsx` does have click-to-seek on its markers rail.
