# fe-40 — Surface & prove series memory

_Design spec · 2026-06-21 · issue [#972](https://github.com/dudarenok-maker/Castwright/issues/972) (`moscow:must`, `type:feature`; **area: `fe` + `srv`** — see scope note)_

> Revised twice after adversarial + brand-voice review (2026-06-21), the second pass
> code-grounded. Round 1 pinned the carried predicate, the sparkline floor, and
> data-sourcing. Round 2 corrected the sparkline's mis-partition, unified
> carried-vs-recurring to one number, fixed the card's span claim, replaced the
> fabricated voice name with the real `describeVoice()` descriptor, switched the spine
> to library-sort ordering (`seriesPosition` is often null), and — the big one —
> established that the per-series summary is **net-new server work**, so this is not a
> frontend-only feature and "no new computation" was dropped as false.

**Scope note.** Despite #972's `area:fe`, this needs a **server change**: the library
scan is purely per-book today and does no cross-book matching, so the per-series carried
summary is net-new server-side derivation (see _Data sourcing_). Plan + labels are
`fe + srv`.

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
- **No new *analysis*.** Rides on shipped cross-book reuse data (the matcher already
  runs). The new work is a **presentation-layer aggregation** of it (server + frontend),
  not new model/analysis work — see the scope note and _Data sourcing_.

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

**Computed over confirmed casts only.** The cross-book matcher already considers only
books with `castConfirmed === true` (`library-cast-scan.ts:55`); carried inherits that —
so a book still analysing/cast-pending never flickers the count, and **`M` (the book
count in any claim) is the confirmed-cast span**, not raw series length.

**Book ordering & roster source.** The series is numbered `1..M` by the library's
existing sort (`seriesPosition ?? 0`, then title) — `seriesPosition` is `number | null`
and null is common (`scan.ts:601`), so the raw field is **never** trusted as the book
index. The roster comes from `GET /api/books/:id/series-cast` (whole series, confirmed
only, **excluding the anchor book** — `series-full-cast-scan.ts`), merged with the
anchor book's own cast to get the complete picture.

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

**This is net-new server work — there is no free lunch.** The library scan
(`scan.ts:589`) is **purely per-book today; it does zero cross-book matching.** Computing
"which characters appear in ≥2 confirmed books with the same `voiceId`" is genuinely new
derivation. Honest resolution:

- **A per-series `seriesMemory` summary is added to the library payload** —
  `{ carriedVoiceCount, spanBooks, perBook: [{ index, castSize, carriedPresent }] }` —
  computed in a **single post-scan union-find pass** over the already-read confirmed
  casts (group characters by `voiceId ?? id`, keep those spanning ≥2 books). That is
  `O(characters)` per series on top of the reads the scan already does — **not** the
  naïve `O(characters²)`. It feeds the chip + sparkline with no extra client round-trips.
- **The result is cached server-side**, keyed off the same inputs the scan already
  invalidates on, so repeated `GET /api/library` calls don't recompute. The initial
  build pays the union-find once.
- **The full reveal roster is fetched lazily on reveal-open** via `series-cast` (+ anchor
  merge), so the heavy per-character payload is paid only when a user actually opens a
  reveal — never for every series on the shelf.

`spanBooks` (not series length) is the count of confirmed books that contain ≥1 carried
voice — this is what every "M books" claim uses, so the claim can't overrun the carried
set's actual reach (e.g. a late-series cast turnover).

## The three surfaces

### 1. Library indicator (the door)

Each series renders a thin header row (`library-grid.tsx:92–99`): uppercase series label
left, "N books" right, above the BookCard grid. fe-40 adds, **only above threshold**:

- **Chip** in the header row beside the count: a brand-gradient pill (magenta→peach),
  marked with the **Castwave glyph** (the brand waveform — *not* a stock sparkle),
  label **`Your cast · N voices, M books`**. White label on light; **ink** label on dark
  (the gradient brightens in dark mode → ink keeps contrast, per the app's
  ink-on-accent convention). _`N` is the **carried** count, so "Your cast · N" slightly
  under-counts the full cast — a **deliberate warmth-over-precision** choice, bounded to
  this ephemeral in-app chip. The shareable card (the provable artifact) stays precise._
- **Sparkline strip** beneath the header (full width): one bar per book, full height =
  that book's total cast, split into **two buckets that partition cleanly**: gradient =
  **carried voices in that book**; faint = **the rest of that book's cast** (new *and*
  one-offs *and* re-cast recurrers — everything not carried). This avoids the round-2
  bug where re-cast recurrers fell through a "carried / new" split. The carried band
  **rises as late joiners arrive** (not flat — honest). Caption: **"N voices, kept true
  across the series."** Legend: *Carried* / *Rest of this book's cast*. Both chip and
  sparkline open Surface 2, with an aria-label carrying the facts in text (e.g. "9 voices
  carried across 12 books") so the proof isn't colour-only.

### 2. The reveal (the payoff)

Tapping the chip/sparkline opens a focused panel — centered dialog on desktop,
full-screen sheet on phone (mobile protocol). Choreography carries the tone, with
restrained entrance motion:

- **Eyebrow:** `<Castwave glyph> <Series> · series memory`.
- **Headline** (Lora, large): **"Twelve books in, and the cast never changed."**
  (book count per series; quiet brag, no swagger.)
- **Subtitle:** **"Nine voices — yours since book one."** ("yours", not "you cast" — the
  product casts; the listener owns.)
- **Cast roster**, staggering in: one row per carried character — name (Lora) + a voice
  **swatch + the `describeVoice()` label** (e.g. "Deep · Female · UK" for a catalogue
  voice, or the user's designed-voice name for Qwen — *never* the raw slug `bf_emma`, and
  **no engine name**: "Kokoro"/"Qwen" is jargon to a listener, kept to JSON only), and a
  **book-marker row** (one marker per book, **ordered by the library sort**, not raw
  `seriesPosition`). Two marker states: **filled** = present & carried that book;
  **faint** = not in that book — which covers *both* "before they joined" *and* a
  **mid-series gap** (a character who sits a book out), so the round-2 gap case is
  handled. First appearance is annotated *"· from Bk 4"*. A full run reads "carried the
  whole way"; never a miss. Each row's markers have a text equivalent (aria-label "in
  books 1, 2, 4–12"). The panel **scrolls**, so it holds any cast size.
- **Actions:** primary **"Share this cast"**; quiet **"Export data (.json)"** link.

### 3. The share card + JSON (the artifact)

**Share card** — a premium, screenshot-perfect **portrait social card** (≈1080×1350),
dark, brand-stamped, crediting the listener as *owner*. **Built scale-first** (this earns
its keep on a long saga with a big recurring cast). Top → bottom:

- **Castwave wordmark** · eyebrow `Series memory · <Series>`. _Branding is **mandatory
  and non-removable** — wordmark + `castwright.ai` always present (see Sharing)._
- **Big number** — `56 voices` (Lora) — the headline; only more striking as the series
  grows.
- **Elevated line** under it (peach serif): **"kept true across all `spanBooks`
  books."** Uses `spanBooks` (books actually containing carried voices), **not** raw
  series length — so "all" can't overclaim when a late-series cast turnover means the
  final books carried nothing. A statement, not a footnote. (No dot/bar span device.)
- Quiet claim line (the dry wit, e.g. *"Twenty-four books. The same cast."*).
- **Cast wall** — the hero, owning the card's middle with real air: a centered
  theatrical **credits block** of **every carried name** (Castwave-dot separators), no
  "+N more". The full wall *is* the brag. **Auto-scales**: name size steps down with cast
  size (~14.5px → ~10px); a tasteful cap engages only past ~45 names ("…and K more of
  your cast"), so it stays legible.
- **Footer:** ownership credit — **`<user>'s cast · kept true`** (fallback when no
  display name is set: **`Your cast · kept true`**, never "undefined") · `castwright.ai`.

**Sharing.** End-user sharing is **first-class and unrestricted** — every card carries
Castwright's wordmark + `castwright.ai`, so a shared cast card *is* free, branded
marketing. We don't gate it. The one hard requirement: **the branding is mandatory and
cannot be removed** from the artifact. (Castwright's own marketing cards are the same
artifact, generated from owned content — Coalfall, originals.) The card names characters
from the book; a low-key spoiler note at export is optional courtesy, never a block.
Because the card is an **image**, its text is invisible to screen readers and
un-indexable — so the in-app preview gets real alt text, and the **JSON is the
machine-readable twin** of the same claim.

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
        "voiceLabel": "Deep · Female · UK",
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

- `voiceId` is the durable key; `voiceLabel` is the `describeVoice()` descriptor (or the
  designed-voice name), `engine` alongside; the catalogue slug is *not* a display field.
- `aliases` preserves the rename chain; `carriedFullSpan`/`firstBook`/`lastBook` capture
  the joiner reality the card omits.
- `schemaVersion` + `kind` let a later cast-export extend the shape without breaking
  consumers.

## Copy (locked, house-voice)

| Surface | Copy |
|---|---|
| Chip | `Your cast · N voices, M books` _(warm; N = carried count, in-app only)_ |
| Sparkline caption | "N voices, kept true across the series." |
| Sparkline legend | "Carried" / "Rest of this book's cast" |
| Reveal headline | "M books in, and the cast never changed." |
| Reveal subtitle | "N voices — yours since book one." |
| Reveal joiner note | "· from Bk K" |
| Card big number | `N voices` |
| Card elevated line | "kept true across all `spanBooks` books" |
| Card claim | "M books. The same cast." |
| Card footer | "&lt;user&gt;'s cast · kept true" (fallback "Your cast · kept true") |

`N` = **carried** count, the same number on every surface (the term is always
"carried", never "recurring"). On the warm in-app chip `M` = series book count; in every
**shared/exported** claim the book number is `spanBooks` (books that actually carry), so
the provable artifact never overclaims.

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
- **Vocabulary coherence.** The shipped cast-row badge calls this moat "**Reused ·
  Matched**" (`cast.tsx`). fe-40 makes **"carried / kept true"** the canonical
  series-level language. Harmonising the older per-row badge to match is a **noted
  follow-up**, deliberately out of this PR's scope (surgical-change discipline) — but
  flagged so the moat doesn't keep speaking with two voices.

## Data sources (existing analysis, new aggregation)

- Library shape: `authors → series → books` (`src/lib/types.ts`, `library-slice.ts`),
  plus the **new** server-computed per-series `seriesMemory` summary (above).
- Per-series carried roster: the `series-cast` machinery
  (`GET /api/books/:bookId/series-cast`, cross-book reuse helpers), fetched lazily on
  reveal-open.

## Testing

- **Unit (Vitest):** the carried predicate against the hard cases — voice-changed
  mid-series (excluded), renamed via alias (single canonical row), partial carry
  (excluded), late joiner (included, correct first/last book), **mid-series gap**
  (faint marker, not "before joined"); **confirmed-cast-only** (a `cast_pending` book
  doesn't move the count); the union-find summary (`O(characters)`, correct
  `spanBooks`); per-book two-bucket partition (carried + rest = total cast, incl. a
  re-cast recurrer landing in "rest"); the **≥3-voice/≥2-book threshold gate**;
  heuristic-series → no chip without real continuity; **book ordering by library sort
  when `seriesPosition` is null**; `spanBooks` span claim never exceeds carried reach;
  JSON serialization incl. `carriedFullSpan` + `aliases` + `describeVoice` label; byline
  fallback when no display name.
- **Component:** chip + sparkline render only above threshold; reveal roster rows +
  book-marker row + joiner note; `describeVoice` label (never slug, no engine name);
  share-card wall auto-scaling + cap threshold; mandatory branding present on the card;
  aria-labels on the visual proofs.
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
- Harmonising the cast-row "Reused · Matched" badge to the "carried / kept true"
  vocabulary → follow-up (out of this PR's scope).
