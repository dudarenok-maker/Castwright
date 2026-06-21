# fe-40 — Surface & prove series memory

_Design spec · 2026-06-21 · issue [#972](https://github.com/dudarenok-maker/Castwright/issues/972) (`area:fe`, `moscow:must`, `type:feature`)_

> Revised after an adversarial + brand-voice review (2026-06-21). The carried
> predicate, the sparkline's honest floor, and the data-sourcing question were the
> three blockers; the copy was retuned to the house voice (_understated, earns its
> claims; "kept true, kept yours, book after book"_ — not marketing swagger).

## Problem

Castwright's **series memory** — the same voice held for a character across every book
in a series — is one of our top *unclaimed* moats, and today it's nearly invisible. The
only surfacing is a per-cast-row **"Reused" badge** (`src/views/cast.tsx`, backed by
`matchedFrom`), buried inside one book's cast view and framed as a dry provenance stamp.
It never rises to the **series level**, and it gives marketing no provable, shareable
claim.

The data already exists (cross-book reuse machinery, the `series-cast` endpoint, the
`authors → series → books` library shape). **fe-40 is a surfacing + storytelling job,
not a new computation.**

## Goals

- Make series memory **visible at the series level**, in the library.
- Make it **provable and shareable** — a premium artifact with a data export behind it.
- Tone: **the house voice** — quiet confidence, dry warmth, claims that earn
  themselves. Premium = craft, not loudness.
- **Integrity:** celebrate genuine continuity; never overclaim.

## Non-goals (scope held for v1)

- **No library-wide / top-level rollup.** Deferred to **voice-cloning / personalised
  voices** (`fs-38`), where a personal voice stable makes a cross-series claim
  meaningful. v1 is **series-level only**.
- **No action surface.** No "2 characters drifted — want to lock them?" nudge. v1 is a
  read-only *celebration + proof* surface.
- **No re-computation.** Rides on shipped cross-book reuse data.

## What "carried" means (the load-bearing predicate)

The entire feature hinges on this, so it is defined exactly:

> A character is **carried** iff they appear in **≥ 2 books** of the series **and hold
> the same `voiceId` in every book in which they appear.**

Consequences, all deliberate:

- **Identity across renames** uses the existing alias chain (the cross-book matcher
  already writes a renamed character's old name into the new one's aliases). The
  **canonical (latest) name** is displayed; a character never appears twice on the wall.
- **Voice changed mid-series** (same character, re-cast at some book) → **not carried**,
  silently excluded. This is consistent with the "no miss state" rule below — it is not
  surfaced as a failure, it simply isn't part of the carried set.
- **Partial carry** (same voice books 1–3, different 4–6) → **not carried** (the "every
  appearance" clause fails). Same silent exclusion.
- **Late joiner** (first appears at book 4, same voice 4→N) → **carried**. Its span
  starts at book 4; the surfaces show that honestly (see L1/reveal).

**What the claim asserts — and doesn't.** "Carried" means *the same voice **profile**
(`voiceId`) was used everywhere the character speaks*. It does **not** assert the audio
is acoustically identical across books — perceptual drift is a separate concern owned by
`srv-36`/`fs-51`. Copy stays on the defensible side of that line: "the same voice," not
"sounds identical."

## The integrity rule

The claim is purely **additive — a count, never a fraction.** There is no denominator
anywhere in this feature.

- Later books add new characters who *couldn't* have been carried from book 1, so a
  percentage is incoherent, not merely risky. The carried cast is a subset by design —
  the healthy state of a growing series.
- The feature knows only two states: **carried** (celebrated) and **not-applicable**
  (silent). There is **no "failed to carry" state** in any UI.
- The headline is always a count of what was carried. It never claims "all the cast" or
  "perfect" — only a sharp, true statement a user can't falsify in their own library.

## When the markers appear (threshold)

The moat shines on a *large, long* series; a trivially-true marker cheapens it. So the
markers appear only when:

> **≥ 3 carried voices** across **≥ 2 books** of the series.

A standalone, a single-book series, or a series with one or two incidental carryovers
shows **nothing** — keeping the markers a genuine signal, never chrome. Note this
threshold is *also* the heuristic-series guard (L4): because the gate is real
carried-voice provenance (matcher-confirmed `voiceId` continuity), a wrongly-grouped
"series" from the `seriesFromTitle` title heuristic can never trip it on its own — only
actual cross-book voice continuity does.

## Data sourcing & feasibility

The chip needs a per-series carried **count**; the reveal needs the full carried
**roster** (character → voice → which books). Neither is in today's library payload
(which carries per-book `voiceIds`/`characterCount`, not the cross-book character→voice
map). Resolution:

- **Library payload gains a cheap per-series `seriesMemory` summary** — `{ carriedVoiceCount, bookCount, perBook: [{ position, castSize, carriedPresent }] }` —
  computed server-side from the same `series-cast` logic that already runs. This feeds
  the chip + sparkline with **no extra client round-trips on library load.**
- **The full roster is fetched lazily on reveal-open** (the existing `series-cast` data
  for the series), so the heavy per-character payload is paid only when the user opens
  the reveal, not for every series on the shelf.

This keeps the "no new computation" promise honest (it's the same derivation, surfaced)
while answering *where* and *when* it runs.

## The three surfaces

### 1. Library indicator (the door)

Each series renders a thin header row (`library-grid.tsx:92–99`): uppercase series label
left, "N books" right, above the BookCard grid. fe-40 adds, **only above threshold**:

- **Chip** in the header row beside the count: a brand-gradient pill (magenta→peach),
  marked with the **Castwave glyph** (the brand waveform — *not* a stock sparkle),
  label **`Your cast · N voices, M books`**. White label on light; **ink** label on dark
  (the gradient brightens in dark mode → ink keeps contrast, per the app's
  ink-on-accent convention).
- **Sparkline strip** beneath the header (full width): one bar per book, full height =
  that book's total cast. The gradient portion = **carried voices present in that book**;
  the faint portion = voices unique to that book. **The carried band is not claimed to
  be flat** — it rises as late joiners arrive, which reads honestly as *the recurring
  cast accreting*. Caption: **"N recurring voices — none ever re-cast."** Legend:
  *Recurring* / *New to this book*. Both chip and sparkline open Surface 2. Each carries
  an aria-label with the same facts in text (e.g. "12 recurring voices across 16 books")
  so the proof isn't colour-only.

### 2. The reveal (the payoff)

Tapping the chip/sparkline opens a focused panel — centered dialog on desktop,
full-screen sheet on phone (mobile protocol). Choreography carries the tone, with
restrained entrance motion:

- **Eyebrow:** `<Castwave glyph> <Series> · series memory`.
- **Headline** (Lora, large): **"Twelve books in, and the cast never changed."**
  (book count per series; quiet brag, no swagger.)
- **Subtitle:** **"Nine voices — yours since book one."** ("yours", not "you cast" — the
  product casts; the listener owns.)
- **Cast roster**, staggering in: one row per carried character — name (Lora), a voice
  **swatch + a human voice label** (never the raw catalogue slug; the slug lives only in
  JSON) + engine, and a **book-marker spine** (one marker per book; filled = present &
  carried, faint = before the character joined). A full run reads "carried the whole
  way"; a late joiner starts later, annotated *"· from Bk 4"* — honest, never a miss.
  Each spine has a text equivalent (aria-label "books 4–12"). The panel **scrolls**, so
  it holds any cast size.
- **Actions:** primary **"Share this cast"**; quiet **"Export data (.json)"** link.

### 3. The share card + JSON (the artifact)

**Share card** — a premium, screenshot-perfect **portrait social card** (≈1080×1350),
dark, brand-stamped, crediting the listener as *owner*. **Built scale-first** (this earns
its keep on a long saga with a big recurring cast). Top → bottom:

- **Castwave wordmark** · eyebrow `Series memory · <Series>`.
- **Big number** — `56 voices` (Lora) — the headline; only more striking as the series
  grows.
- **Elevated line** under it (peach serif): **"kept true across all 24 books."** A
  statement, not a footnote. (No dot/bar span device.)
- Quiet claim line (the dry wit, e.g. *"Twenty-four books. The same cast."*).
- **Cast wall** — the hero, owning the card's middle with real air: a centered
  theatrical **credits block** of **every carried name** (Castwave-dot separators), no
  "+N more". The full wall *is* the brag. **Auto-scales**: name size steps down with cast
  size (~14.5px → ~10px); a tasteful cap engages only past ~45 names ("…and K more of
  your cast"), so it stays legible.
- **Footer:** ownership credit — **`<user>'s cast · kept true`** (fallback when no
  display name is set: **`Your cast · kept true`**, never "undefined") · `castwright.ai`.

**Sharing & IP guard.** The card prints the book title + full character roster — for a
copyrighted book that is both an IP smell (the brand's stance is *personal use only*) and
a spoiler. v1 surfaces a one-line caution at export time ("for personal use — this names
characters from the book"); a later pass may scope the public-share affordance to
user-owned/original works.

**JSON export** (behind the quiet link) — **provisional for v1**, versioned so it can be
reshaped when export/import is designed properly (it'll flow naturally out of that work).
The honesty the card omits lives here. Shape:

```json
{
  "schemaVersion": 1,
  "kind": "series-consistency",
  "exportedAt": "2026-06-21T09:30:00Z",
  "owner": "Alex",
  "series": {
    "name": "The Ninth House",
    "author": "A. Kell",
    "bookCount": 24,
    "books": [
      { "bookId": "bk_house-of-ash", "title": "House of Ash", "position": 1, "castSize": 14 }
    ]
  },
  "carried": {
    "voiceCount": 56,
    "characters": [
      {
        "character": "Marrow",
        "aliases": ["The Warden"],
        "voiceId": "v_kok_bf_emma",
        "voiceLabel": "Emma",
        "engine": "kokoro",
        "firstBook": 1,
        "lastBook": 24,
        "booksSpanned": [1, 2, "…", 24],
        "carriedFullSpan": true
      }
    ]
  }
}
```

- `voiceId` is the durable key; `voiceLabel` (human) + `engine` alongside; the catalogue
  slug is *not* a display field.
- `aliases` preserves the rename chain; `carriedFullSpan`/`firstBook`/`lastBook` capture
  the joiner reality the card omits.
- `schemaVersion` + `kind` let a later cast-export extend the shape without breaking
  consumers.

## Copy (locked, house-voice)

| Surface | Copy |
|---|---|
| Chip | `Your cast · N voices, M books` |
| Sparkline caption | "N recurring voices — none ever re-cast." |
| Reveal headline | "M books in, and the cast never changed." |
| Reveal subtitle | "N voices — yours since book one." |
| Reveal joiner note | "· from Bk K" |
| Card big number | `N voices` |
| Card elevated line | "kept true across all M books" |
| Card claim | "M books. The same cast." |
| Card footer | "&lt;user&gt;'s cast · kept true" (fallback "Your cast · kept true") |

Rules: no catalogue slugs (`bf_emma`) in any user-facing surface — JSON only. No "spine"
(engineering term) in UI; the device is a **book-marker row**. Marker glyph is the
**Castwave** mark, never a generic sparkle. Numbers stay **numeric** on chip/sparkline/
card-number; **spell out** in the large reveal headline. Ownership via *"yours"*, never
*"you cast"* — the engine casts; the listener owns.

## Visual / brand notes

- Brand tokens only — gradient `magenta → peach`; Lora for numbers/headlines/names,
  General Sans for frame text. Dark surfaces lift for elevation; gradient label flips to
  ink on dark.
- The brand glyph is the **Castwave** waveform, sourced from existing brand assets — do
  not introduce new iconography.
- Markers appear **only** above threshold — never blanket the library.
- Responsive per the mobile protocol: reveal = dialog (desktop) / full-screen sheet
  (phone); chip + sparkline reflow in the series header.

## Data sources (no new computation)

- Library shape: `authors → series → books` (`src/lib/types.ts`, `library-slice.ts`),
  plus the new server-computed per-series `seriesMemory` summary (above).
- Per-series carried roster: the `series-cast` machinery
  (`GET /api/books/:bookId/series-cast`, cross-book reuse helpers), fetched lazily on
  reveal-open.

## Testing

- **Unit (Vitest):** the carried predicate against the hard cases — voice-changed
  mid-series (excluded), renamed via alias (single canonical row), partial carry
  (excluded), late joiner (included, correct first/last book); per-book
  carried-present count (rising floor); the **≥3-voice/≥2-book threshold gate**;
  heuristic-series → no chip without real continuity; JSON serialization incl.
  `carriedFullSpan` + `aliases`; byline fallback when no display name.
- **Component:** chip + sparkline render only above threshold; reveal roster rows +
  book-marker spine + joiner note; human voice label (never slug); share-card wall
  auto-scaling + cap threshold; aria-labels on the visual proofs.
- **E2E (Playwright):** library → chip on a series with real carryover → tap → reveal
  opens → Share/Export present. Add a case to `e2e/responsive/coverage.spec.ts` (runs at
  phone/tablet/desktop).
- **Visual:** the share card is a screenshot artifact — a snapshot test guards its layout
  at a representative large scale.
- **A11y:** axe pass on the reveal; assert the dot-spine/sparkline text equivalents.

## Acceptance (from #972)

- ✅ Series/library view shows a per-series consistency indicator for recurring
  characters — **chip + sparkline in the series header row.**
- ✅ A consistency summary can be exported — **share card (image) + JSON.**
- ✅ No regression to existing cross-book reuse behaviour — fe-40 only reads.

## Open / deferred

- Library-wide top-level rollup → with `fs-38` (voice cloning / personalised voices).
- JSON export shape finalization → with the export/import workstream.
- Share-card image rendering pipeline (client canvas vs server render) → an
  implementation-plan decision.
- Scoping public-share to user-owned/original works (beyond the v1 caution) → follow-up.
