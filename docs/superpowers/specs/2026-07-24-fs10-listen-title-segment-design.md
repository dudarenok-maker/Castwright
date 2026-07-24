# fs-10 — Chapter-title segment on the Listen-view timeline

> Spec (validated design) · 2026-07-24 · fs-10 / [#412](https://github.com/dudarenok-maker/Castwright/issues/412)
> Branch: `feat/frontend-fs10-title-segment`

## 1. Goal & scope

Since PR #101 every rendered chapter opens with a synthetic, narrator-voiced **title beat** —
`server/src/tts/synthesise-chapter.ts:1097` writes it into `<slug>.segments.json` as
`{ groupIndex: -1, characterId: <narrator>, sentenceIds: [], kind: 'title', startSec, endSec }`.
The beat is audible but invisible: `server/src/routes/chapter-audio.ts:240` strips it before the
`ChapterAudio` payload leaves the server, so no UI surface knows it exists.

This spec surfaces it. **In scope:**

1. Publish `kind` on the `ChapterAudio` wire contract and stop filtering the title row.
2. Paint a clickable title tick at the head of the Listen view's mini-player scrubber.
3. Fix the segment-index off-by-one that the filter has been causing (§5 — a live bug).
4. Give the Generation view's existing "Narrative order" strip a distinct title treatment.

**Out of scope:** any new timeline widget on the Listen chapter rows; per-segment bands on the
mini-player for non-title segments; editing or re-recording the title beat.

## 2. Two corrections to the issue as filed

**The `sentenceId` premise is stale.** #412 says the wire contract "types `sentenceId` as a
required integer" and asks for it to be widened. It isn't. `openapi.yaml:4684-4692` declares the
segment item with no `required` list at all, so `src/lib/api-types.ts:3613` already generates
`sentenceId?: number`. No widening is needed — the only contract delta is `kind`.

**"The listen view's chapter timeline" does not exist.** The band strip #412 describes is
`ChapterSegmentStrip`, and it lives on the **Generation** view
(`src/views/generation.tsx:2284`, rendered at `:2048`). `src/components/listen/listen-player-region.tsx`
renders a peaks-only `<Waveform>` per chapter row — no per-segment bands, and no seek affordance
anywhere in the file. The only clickable timeline reachable from Listen is the global mini-player
scrubber (`src/components/mini-player.tsx:723-738`), which is where the title tick lands. The
implementation therefore touches `mini-player.tsx`, **not** the `listen-player-region.tsx` named
in the issue.

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

**`kind?: 'title'`, not `kind?: 'title' | 'sentence'`** as #412 proposed. Rationale: it mirrors
the on-disk shape exactly (`server/src/audio/segments-io.ts:56` types the same field as optional
`'title'`), no consumer needs to distinguish "explicitly a sentence" from "unmarked", and an
optional single-value enum widens later without a breaking change. Emitting `kind: 'sentence'`
on every segment of every chapter would also inflate the payload for a distinction nothing reads.

## 4. Server pass-through

`server/src/routes/chapter-audio.ts`:

- `publishSegment` (`:143`) spreads `kind` through when it is `'title'`, matching the existing
  conditional-spread style used for `suspect`/`reasons`.
- Delete `.filter((s) => s.kind !== 'title')` from **both** handlers — `/audio` (`:240`) and
  `/audio/previous` (`:277`). Both, not one: `src/views/revision-diff.tsx:116-126` fetches the
  live and preserved payloads side by side and indexes into them, so a filter surviving on one
  handler would silently desynchronise the pair.
- The title row publishes with `sentenceId: undefined` (`s.sentenceIds[0]` of an empty array),
  which the contract already permits.
- Rewrite the two now-false comment blocks at `:107-114` and `:233-238`.

**Invariant this establishes, and which §7 pins with a test: the published `segments[]` index is
identical to the on-disk `segments[]` index, for every chapter, unconditionally.** `publishSegment`
maps 1:1 with no filter, so this holds by construction — but it is exactly the property §5 depends
on, so it gets asserted rather than assumed.

## 5. The off-by-one this fixes

`src/lib/resolve-segment-for-sec.ts` documents its return value as "the segment index … the same
index the splice route's `segmentIndices` addresses" (`:4-5`). That claim is currently false.

- `resolveSegmentForSec` computes the index by walking the **wire** array (`:27`, `:44`).
- `src/routes/index.tsx:929-936` passes that index straight into the Fix-audio modal as
  `preScoped.segmentIndices`.
- `server/src/routes/chapter-splice.ts:152-171` resolves `segmentIndices` against the **on-disk**
  array.

For any chapter rendered with a voiced title, the wire array was short one leading element, so
every wire index sat one below its disk counterpart. **"Fix this line" from a Listen-view
re-record marker has been re-recording the line after the one the user marked.** Dropping the
filter realigns the two arrays and the bug disappears — but only if the resolver also stops
*returning* the title row, so:

- Add `if (seg.kind === 'title') continue;` alongside the existing `!seg.characterId` guard at
  `resolve-segment-for-sec.ts:29`. The loop index `i` is unchanged, which is the point: skipping
  without renumbering is what keeps the returned index disk-aligned.
- Without this guard, a marker dropped in the chapter's first ~3 s would resolve to segment 0
  (the title carries the narrator's `characterId`, so the existing guard waves it through), and
  the splice route would reject the request outright at `chapter-splice.ts:176-181`
  ("No re-recordable lines for this character in this chapter (title-only)").

This is a genuine bug fix riding along with the feature. It is in scope because un-filtering is
what causes the realignment — it cannot be split into a separate PR.

## 6. UI

### 6.1 Mini-player title tick (`src/components/mini-player.tsx`)

A `<button type="button">` rendered inside the existing scrubber container (`:723-738`), as a
sibling of the progress underline and thumb:

- **Geometry.** `position: absolute; left: 0`, full track height,
  `width: max(5px, (titleEnd / totalSec) * 100%)`. The floor matters: a 3 s beat in a 41-minute
  chapter is 0.12 % of the track, i.e. sub-pixel. Peach at partial alpha so the waveform bars
  read through it, `rounded-l` to sit flush with the track's left edge.
- **Click.** `stopPropagation` first — the parent div's `onScrub` would otherwise also fire.
  Then seek to 0 following the **`jumpToIssue` pattern** (`:514-517`): set `el.currentTime`,
  `setCurrentSec`, **and** `currentSecRef.current`. Explicitly *not* `onScrub`'s pattern
  (`:628-635`), which omits the ref update — the ref is what the resume-bookmark flush reads, so
  skipping it would persist a stale position.
- **Labelling.** `title="Chapter title · 0:00–0:03"`, an `aria-label`, and
  `data-testid="mini-player-title-segment"`.
- **Absence.** Null-renders when no `kind === 'title'` segment is present. That is the graceful
  degrade #412 asks for: chapters rendered before PR #101 simply show no tick.

### 6.2 Generation strip (`src/views/generation.tsx:2324-2338`)

The strip maps every segment to a character-palette band. Once the title row arrives it would
otherwise render in the narrator's colour, implying the narrator spoke a line where no sentence
exists. Branch on `kind === 'title'`: neutral `ink/25` fill, `minWidth: 3px` so it stays visible,
tooltip `Chapter title · 0:00–0:03`.

## 7. Testing

| Layer | File | Assertion |
|---|---|---|
| Server | `server/src/routes/chapter-audio.test.ts` | title row published with `kind: 'title'` and `sentenceId` undefined; **published index === on-disk index** (§4 invariant); identical behaviour on `/audio/previous` |
| Unit | `src/lib/resolve-segment-for-sec.test.ts` | marker at 1.0 s in a title-led chapter resolves to index 1, not 0; a post-title marker's index equals its disk index. **Both fail before the §5 change** |
| Unit | `src/components/mini-player.test.tsx` | tick renders when a title segment is present; absent otherwise; click sets `currentTime` to 0 and updates the readout |
| Unit | `src/views/generation.test.tsx` | title band takes the neutral fill + `Chapter title` tooltip, not the narrator colour |
| E2E | `e2e/` (mini-player spec) | tick is visible and clicking it resets the elapsed readout to `0:00` — required by the testing-discipline rule, since this crosses the redux/layout seam |

## 8. Risks and accepted trade-offs

**The mock needs a title segment, and that shifts every mock segment index.**
`mockGetChapterAudio` (`src/lib/api.ts:1686-1766`) emits four segments, none of them a title, so
no frontend or e2e test can exercise any of this as-is. The mock gains a `kind: 'title'` segment
at `[0, 3]`, which is what production looks like — and which makes the e2e cover the §5 fix
rather than only the tick. Consequence: every existing mock segment index moves by one. Any
fix-this-line assertion in `src/lib/api-demo-capture.test.ts`, `mini-player.test.tsx`, or the e2e
specs that hardcodes an index must be re-checked. (The demo-capture assertions read
`.filter(s => s.suspect)` and compare `start`/`end` seconds, not indices, so those are expected to
survive untouched — but that is a prediction to verify, not an assumption to rely on.)

**Visual baselines may move.** If any `listen.png` / `listen-dark.png` snapshot in
`e2e/{linux,win32}/` captures the mini-player mid-playback, the tick lands inside it and the
baselines need regenerating on both platforms.

**The 5 px tick does not meet the 44 px touch target** required by the mobile-testing protocol.
Accepted as a documented exception rather than fixed. Justification: the tick sits inside the
scrubber, which already seeks on tap at that same position, so the worst outcome of a mis-tap is
seeking to 0.2 s instead of 0.0 s. That is a benign miss, categorically unlike the tablet-toggle
class of failure the rule exists to prevent, where an undersized target reads as unresponsive.
The alternative considered and rejected was hiding the tick on coarse pointers — that would
withhold the *visual* cue ("you're hearing the title now") which is the feature's entire stated
user benefit, from exactly the devices most likely to be used for listening.

## 9. Documentation

Spec only — no `docs/features/` regression plan. The change is small, localized, and fully
covered by §7; per `CLAUDE.md`'s before-shipping checklist, "small/localized items skip the plan
doc — the issue body + paired test is the spec." Release notes get an entry in both
`docs/release-notes-next.md` and `RELEASE_NOTES.md`: the user-visible delta is the title cue plus
the corrected "Fix this line" targeting.
