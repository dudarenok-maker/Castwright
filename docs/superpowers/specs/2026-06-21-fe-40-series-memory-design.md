# fe-40 — Surface & prove series memory

_Design spec · 2026-06-21 · issue [#972](https://github.com/dudarenok-maker/Castwright/issues/972) (`area:fe`, `moscow:must`, `type:feature`)_

## Problem

Castwright's **series memory** — the same voice held for a character across every
book in a series — is one of our top *unclaimed* moats, and today it's nearly
invisible. The only surfacing is a per-cast-row **"Reused" badge** (`src/views/cast.tsx`,
backed by `matchedFrom`), buried inside one book's cast view and framed as a dry
provenance stamp ("Reused · Matched"). It never rises to the **series level**, and it
does nothing for the brand: it doesn't make the "book 1 → book N, same cast, every
time" story *shine*, and it gives marketing no provable, shareable claim.

The data already exists (cross-book reuse machinery, the `series-cast` endpoint, the
`authors → series → books` library shape with per-book `voiceIds`/`characterCount`).
**fe-40 is a surfacing + storytelling job, not a new computation.**

## Goals

- Make series memory **visible at the series level**, in the library, where the
  "same cast across the whole series" story lands.
- Make it **provable and shareable** — a premium artifact marketing can use as a
  claim, with a data export behind it.
- Tone: **premium + playful** — a confident, well-crafted little reveal; warm copy,
  never corporate.
- **Integrity:** celebrate genuine continuity; never overclaim.

## Non-goals (scope held for v1)

- **No library-wide / top-level rollup.** A cross-series headline ("38 voices across
  3 series") is deferred to the **voice-cloning / personalised-voices** release
  (`fs-38`), where a personal voice stable makes a cross-series claim meaningful.
  v1 is **series-level only**.
- **No action surface.** No "2 characters drifted — want to lock them?" nudge. That's
  a later, cast-management concern. v1 is a *celebration + proof* surface, read-only.
- **No re-computation.** Rides entirely on shipped cross-book reuse data.

## The integrity rule (load-bearing)

The claim is purely **additive — a count, never a fraction.** There is no
denominator anywhere in this feature.

- Later books add new characters who *couldn't* have been carried from book 1, so a
  percentage is not just risky, it's **incoherent**. The carried cast is always a
  subset by design, and that is the healthy state of a growing series.
- The feature knows only two states: **carried** (celebrated) and **not-applicable**
  (silent). There is **no "failed to carry" state** in any UI. A character introduced
  in book 3 is *new*, never a "miss."
- The headline is always a count of what was carried ("28 voices, kept true across 14
  books"). It never says "all" or "perfect" in a way a sharp user could falsify in
  their own library — that would be a self-inflicted wound on a QA-moat brand.

## The three surfaces

### 1. Library indicator (the door)

In the book-library, each series renders a thin header row (`library-grid.tsx:92–99`):
uppercase series label left, "N books" right, above the BookCard grid. fe-40 adds two
markers to that row, only when a genuine carried cast exists (≥1 character spanning ≥2
books) — standalone books and single-book series show nothing, so the markers stay a
signal, not chrome:

- **Chip** in the header row, beside the count: a brand-gradient pill
  (magenta→peach), label **`✦ Your cast · N voices, M books`**. White label on light
  theme; **ink** label on dark (the gradient brightens in dark mode, so ink keeps
  contrast — the app's ink-on-accent convention).
- **Sparkline strip** directly beneath the header row (full library width): one bar
  per book, full height = that book's total cast, the **gradient base = the carried
  voices**, the faint top = that book's new arrivals. The constant gradient floor
  across every bar is the comparison — *same cast, every book, each book growing its
  own*. Caption: **"The same N voices, kept true in every book."** Legend:
  *Carried* / *New that book*. (The per-book **total-cast comparison** is essential to
  the shine — seeing the carried floor against the growing total is what gives the
  number weight.)

Both chip and sparkline open Surface 2.

### 2. The reveal (the payoff)

Tapping the chip/sparkline opens a focused panel — centered dialog on desktop,
full-screen sheet on phone (per the mobile protocol). Choreography carries the
"premium + playful" tone, with entrance motion:

- **Eyebrow:** `✦ <Series> · series memory`.
- **Headline** (Lora, large), lands first: **"Twelve books in, and it never forgot a
  voice."** (book count spelled out / woven in per series).
- **Subtitle:** **"Nine of them — same as the day you cast them."**
- **Cast roster**, staggering in: one row per carried character — name (Lora), voice
  swatch + voice name + engine, and a **book-dot spine** (one dot per book; filled =
  present-and-carried, faint = before the character joined). The spine is the proof:
  a full run reads as "carried the whole way"; a later joiner simply starts later,
  annotated *"· joined Bk4"* — honest, never a miss. The panel **scrolls**, so it
  holds any cast size.
- **Actions:** primary **"Share this cast →"** (→ Surface 3); quiet **"Export data
  (.json)"** link.

### 3. The share card + JSON (the artifact)

**Share card** — a premium, screenshot-perfect **portrait social card** (≈1080×1350),
dark, brand-stamped, crediting the user. **Built scale-first**: this feature earns its
keep on a long-running saga with a large recurring cast, so the card is designed for
the big case, not the small one. Layout (top → bottom):

- `✦ Castwright` wordmark · eyebrow `Series memory · <Series>`.
- **Big number** — `56 voices` (Lora) — the headline brag; only more impressive as the
  series grows.
- **Elevated line** directly under it (peach serif): **"kept true across all 24
  books"** — a statement, not a footnote. (No dot/bar span device — removed.)
- Small claim line (the "never forgot a single one" wink).
- **Cast wall** — the hero, owning the card's middle with real breathing room: a
  centered theatrical **credits block** showing **every carried name** (✦ separators),
  no "+N more" hiding the ensemble — the full wall *is* the brag. **Auto-scales**: name
  size steps down with cast size (~14.5px → ~10px past 50 names). A tasteful cap kicks
  in only at extreme sizes (past ~45 names: show the bulk + "…and K more of your
  cast"), so the wall stays legible.
- **Footer:** `Kept true by <user>` byline (the "kept true by *you*" ownership) ·
  `castwright.ai`.

**JSON export** (behind the quiet link) — **provisional for v1.** A per-character
series-consistency record, versioned so it can be reshaped when export/import is
designed properly (it will flow naturally out of that work). The honesty that the card
omits lives here (`carriedFullSpan`, `firstBook`/`lastBook`). Shape:

```json
{
  "schemaVersion": 1,
  "kind": "series-consistency",
  "exportedAt": "2026-06-21T09:30:00Z",
  "keptTrueBy": "Alex",
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
        "voiceId": "v_kok_bf_emma",
        "voiceName": "bf_emma",
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

- `voiceId` is the durable key; `voiceName` + `engine` alongside for a future
  voices-library join.
- `schemaVersion` + `kind` let a later cast-export extend the shape without breaking
  consumers.

## Copy (locked, brand-voice)

| Surface | Copy |
|---|---|
| Chip | `✦ Your cast · N voices, M books` |
| Sparkline caption | "The same N voices, kept true in every book." |
| Reveal headline | "M books in, and it never forgot a voice." |
| Reveal subtitle | "N of them — same as the day you cast them." |
| Card big number | `N voices` |
| Card elevated line | "kept true across all M books" |
| Card byline | "Kept true by &lt;user&gt;" |

No "spine" in user-facing copy (engineering term). Numbers stay **numeric** on the
compact chip/sparkline/card-number; **spell out** in the large reveal headline.

## Visual / brand notes

- Brand tokens only — gradient = `magenta → peach`; Lora for numbers/headlines/names,
  General Sans for frame text. Dark surfaces lift slightly for elevation; gradient
  label flips to ink on dark for contrast.
- Markers appear **only** where a real carried cast exists — never blanket the library.
- Responsive per the mobile protocol: reveal = dialog (desktop) / full-screen sheet
  (phone); chip + sparkline reflow in the series header.

## Data sources (no new computation)

- Library shape: `authors → series → books`, per-book `voiceIds` / `characterCount`
  (`src/lib/types.ts`, `library-slice.ts`).
- Per-series carried roster: the `series-cast` machinery
  (`GET /api/books/:bookId/series-cast`, cross-book reuse helpers) — character →
  voice → which books, already computed for the existing reuse flow.

## Testing

- **Unit (Vitest):** carried-cast derivation (count, per-book carried-vs-total,
  joiner first/last book); the "no carried cast → no markers" gate; standalone /
  single-book → silent; JSON export serialization incl. `carriedFullSpan`.
- **Component:** chip + sparkline render only when a carried cast exists; reveal roster
  rows + dot-spine; share-card wall auto-scaling + cap threshold.
- **E2E (Playwright):** library → chip visible on a series with reuse → tap → reveal
  opens → Share/Export present. Add a case to `e2e/responsive/coverage.spec.ts` so it
  runs at phone/tablet/desktop.
- **Visual:** the share card is a screenshot artifact — a snapshot test guards its
  layout at a representative large scale.

## Acceptance (from #972)

- ✅ Series/library view shows a per-series consistency indicator for recurring
  characters — **chip + sparkline in the series header row.**
- ✅ A consistency summary can be exported for a series — **share card (image) +
  JSON.**
- ✅ No regression to existing cross-book reuse behaviour — fe-40 only reads.

## Open / deferred

- Library-wide top-level rollup → with `fs-38` (voice cloning / personalised voices).
- JSON export shape finalization → with the export/import workstream.
- Share-card image rendering pipeline (client canvas vs server render) → an
  implementation-plan decision, not a design-spec one.
