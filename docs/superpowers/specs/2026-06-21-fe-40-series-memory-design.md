# fe-40 — Surface & prove series memory

_Design spec · 2026-06-21 · issue [#972](https://github.com/dudarenok-maker/Castwright/issues/972) (`moscow:must`, `type:feature`; **area: `fe` + `srv`** — see scope note)_

> Revised three times after adversarial + brand-voice review (2026-06-21), rounds 2–3
> code-grounded. R1 pinned the carried predicate, sparkline floor, data-sourcing. R2
> fixed the sparkline mis-partition, the span claim, the voice label, library-sort
> ordering, and established this is **net-new server work** (not frontend-only). R3 fixed
> the deepest one: the unit is **carried *characters*** (not voiceIds — a shared
> catalogue voice would miscount), assembled by **chaining persisted `matchedFrom`
> links** (no matcher re-run, no cache exists to hook), with the principal-cast
> denominator so walk-ons can't undersell consistency; and it folds in the **bespoke
> distinction** — designed (Qwen) / cloned (XTTS) carry is the moat, preset (Kokoro)
> carry isn't, so the markers gate on ≥1 bespoke and the proof leads on the designed
> count.

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

The data already exists: the cross-book matcher already runs at analysis time
(`series-reuse-link.ts:222`) and **persists** its links (the `matchedFrom` provenance the
"Reused" badge reads), and the library has the `authors → series → books` shape. fe-40
surfaces and proves what's already true — but, in honesty, it is **not zero-compute**:
assembling the per-series picture is net-new server work (see _Data sourcing_).

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

**The unit is the *character*, never the voice.** `N` is *how many cast members kept
their voice* across the series. Catalogue voices are shared across characters (28 Kokoro
voices, dozens of speakers), so a *voiceId* count is a different, smaller, misleading
number — `N` counts carried **characters**, and "voices" is only the warm everyday label
for them. The chip number and the reveal row count are therefore **the same `N`** (the
card's *hero* number deliberately leads on the bespoke/designed figure — a subset of `N`
— see Surface 3). Identity across books is the **real cross-book matcher** (`scoreOne`,
`voice-match.ts:178` — name + alias + token overlap), via its already-persisted
`matchedFrom` links — **never** an `id` or `voiceId` shortcut (character `id` is per-book
and unstable; two different characters routinely share one catalogue voice). voiceId is
used only to *test* that the voice held along a character's chain.

**Not all carry is equal — the moat is *bespoke* carry.** A character carried on a
**bespoke voice** — a Qwen-*designed* or XTTS-*cloned* voice, unique to that character —
is the real, unownable proof: that exact voice exists nowhere else and was held across
the whole saga. A character carried on a **shared preset** (a Kokoro catalogue voice) is
much weaker — it's preset reuse, which any tool can do. So each carried character is
tagged **`voiceKind ∈ { designed, cloned, preset }`** (derived from `engine` +
`overrideTtsVoices` provenance), and the proof surfaces **lead on bespoke** (designed +
cloned), reporting a `bespokeCount` alongside the total.

**The headline case is a Qwen-*designed* cast.** Among bespoke, `designed` is the
premier proof because Qwen is the only path that designs a **whole unique cast** at scale
— a distinct bespoke voice per character across 20–30 characters (plan 108). `cloned`
(XTTS) is bespoke too, but in practice it's one or two *personal* voices, not a full
ensemble. So the strongest artifact this feature can produce is **a full Qwen-designed
cast carried across a long series**, and the surfaces should be tuned to make *that* sing
(e.g. "23 designed voices, held across all 12 books"). Preset (Kokoro) carry is shown
honestly but never dressed up — and a series with **zero bespoke carry** is a candidate
for showing *nothing* (see threshold). Proof, not jargon: a wall of shared presets is not
the moat; a designed cast held for twelve books is.

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
  starts at book 4; the reveal shows that honestly (the "from Bk 4" note + book-marker
  row), and `carriedFullSpan` is `false`.

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

> **≥ 3 carried characters** across **≥ 3 confirmed books**, **including ≥ 1 bespoke
> (designed/cloned) carried character.**

≥3 *books* (not 2) matches the steer that this earns its keep on a *large, long* series,
not a two-book pair. The **bespoke clause** is the proof-not-jargon gate: a series carried
purely on shared Kokoro presets shows **nothing** — preset reuse isn't a moat, and a card
bragging about it would be exactly the marketing jargon we're avoiding. A standalone, a
two-book series, or an all-preset carry shows nothing — keeping the markers a genuine
signal, never chrome. This threshold is *also* the heuristic-series guard: because the
gate is real carried-voice provenance (matcher-confirmed `voiceId` continuity), a
wrongly-grouped
"series" from the `seriesFromTitle` title heuristic can never trip it on its own — only
actual cross-book voice continuity does.

## Data sourcing & feasibility

**Net-new server work, but it rides persisted matcher output — no per-request
re-matching.** The cross-book matcher already runs at analysis and writes `matchedFrom`
links onto each book's cast.json (the same data the cast-row "Reused" badge reads). The
library scan already reads cast.json per book. So:

- **A per-series `seriesMemory` summary is added to the library payload** —
  `{ carriedCount, spanBooks, perBook: [{ bookId, index, principalCount, carriedPresent }] }`.
  It's assembled by **chaining the persisted `matchedFrom` links** across the series'
  confirmed books (follow each latest-book character's backward links to reconstruct the
  full chain) and keeping chains whose `voiceId` held throughout. This is `O(characters)`
  over data the scan already reads — **no matcher re-run at request time** (the matcher
  is `O(characters²)` and only pays off once, at analysis, which already happened).
- **Caveat (link freshness):** `matchedFrom` points *backward* (a new book matches into
  the prior library), so the chain is reconstructable from the latest confirmed book
  downward. A book never re-linked after later books arrived is still correct for its own
  backward links; the assembly must walk from newest→oldest, not trust any single book's
  forward view. Tested explicitly.
- **No cache exists today** (verified: `GET /api/library` recomputes from disk every
  call). Assembly is cheap enough over already-read cast data that **v1 ships without a
  cache**; if profiling shows the extra parse hurts, a *net-new* cache invalidated on
  cast mutations (reanalysis / merge / override / cast-patch) is the follow-up — not a
  thing we can hook onto an existing layer.
- **The full reveal roster is fetched lazily on reveal-open** via `series-cast`
  (`O(books×characters)`, no cache — acceptable for a single user-initiated open),
  anchored on the **latest confirmed book** in the series and merged with its own cast
  (series-cast excludes the anchor).

`spanBooks` (not series length) = the count of confirmed books containing ≥1 carried
character — every "M books" claim on a shared/exported artifact uses it, so the claim
can't overrun the carried set's actual reach (e.g. a late-series cast turnover).

## The three surfaces

### 1. Library indicator (the door)

Each series renders a thin header row (`library-grid.tsx:92–99`): uppercase series label
left, "N books" right, above the BookCard grid. fe-40 adds, **only above threshold**:

- **Chip** in the header row beside the count: a brand-gradient pill (magenta→peach),
  marked with the **Castwave glyph** (the brand waveform — *not* a stock sparkle),
  label **`Your cast · N voices, M books`**. White label on light; **ink** label on dark
  (the gradient brightens in dark mode → ink keeps contrast, per the app's
  ink-on-accent convention). _`N` is the count of **carried characters** ("voices" is the
  warm label). "Your cast · N" slightly under-counts the full cast (new joiners aren't in
  it) — a **deliberate warmth-over-precision** choice, bounded to this ephemeral in-app
  chip. The shareable card (the provable artifact) stays precise._
- **Sparkline strip** beneath the header (full width): one bar per book over the book's
  **principal cast** (named speaking characters — *not* every distinct voice, so a crowd
  of one-line walk-ons can't swamp the bar and make a consistent series look
  inconsistent). Two buckets that partition cleanly: gradient = **carried characters in
  that book**; faint = **that book's other principals** (new + re-cast). The carried band
  **rises as late joiners arrive** (not flat — honest). Caption: **"N of your cast, kept
  true across the series."** Legend: *Carried* / *Other principals this book*. Both chip
  and sparkline open Surface 2, with an aria-label carrying the facts in text (e.g. "9 of
  your cast carried across 12 books") so the proof isn't colour-only. _"Principal" =
  characters above a small line-count floor; exact threshold is an implementation
  detail, but the denominator is principals, never walk-ons._

### 2. The reveal (the payoff)

Tapping the chip/sparkline opens a focused panel — centered dialog on desktop,
full-screen sheet on phone (mobile protocol). Choreography carries the tone, with
restrained entrance motion:

- **Eyebrow:** `<Castwave glyph> <Series> · series memory`.
- **Headline** (Lora, large): **"Twelve books in, and not a voice has changed."**
  (book count = `M`, matching the chip the user just tapped; "not a voice changed" is
  precise — the cast may have *grown* with new joiners, but no carried voice ever changed;
  "the cast never changed" would falsely imply no additions.)
- **Subtitle:** **"Nine voices, yours — book after book."** ("yours", not "you cast" — the
  product casts, the listener owns; "book after book", not "since book one", because late
  joiners didn't start at book one.)
- **Cast roster**, staggering in: one row per carried character — name (Lora) + a voice
  **swatch + the `describeVoice()` label** (e.g. "Deep · Female · UK" for a catalogue
  voice, or the user's designed-voice name for Qwen — *never* the raw slug `bf_emma`, and
  **no engine name**: "Kokoro"/"Qwen" is jargon to a listener, kept to JSON only). A
  **designed** or **cloned** voice carries a small premium tag ("Designed" / "Cloned") —
  the bespoke ones are the proof, so **bespoke-carried rows sort to the top**; preset
  rows follow, untagged. Then a **book-marker row** (one marker per book, **ordered by
  the library sort**, not raw `seriesPosition`). Two marker states: **filled** = present & carried that book;
  **faint** = not in that book — which covers *both* "before they joined" *and* a
  **mid-series gap** (a character who sits a book out). First appearance is annotated
  *"· from Bk 4"*. A full run reads "carried the
  whole way"; never a miss. Each row's markers have a text equivalent (aria-label "in
  books 1, 2, 4–12"). The panel **scrolls**, so it holds any cast size.
- **Actions:** primary **"Share this cast"**; quiet **"Export data (.json)"** link.

### 3. The share card + JSON (the artifact)

**Share card** — a premium, screenshot-perfect **portrait social card** (≈1080×1350),
dark, brand-stamped, crediting the listener as *owner*. **Built scale-first** (this earns
its keep on a long saga with a large carried cast). Top → bottom:

- **Castwave wordmark** · eyebrow `Series memory · <Series>`. _Branding is **mandatory
  and non-removable** — wordmark + `castwright.ai` always present (see Sharing)._
- **Big number** — the **bespoke** figure leads: `39 designed voices` (Lora), the
  unownable proof (the ≥1-bespoke threshold guarantees there's always at least one). Falls
  back to the total `N voices` only when bespoke is a small minority of the carried set.
  Only more striking as the series grows.
- **Elevated line** under it (peach serif): **"kept true across all `spanBooks`
  books."** Uses `spanBooks` (books actually containing carried characters), **not** raw
  series length — so "all" can't overclaim when a late-series cast turnover means the
  final books carried nothing. A statement, not a footnote. (No dot/bar span device.)
- Quiet claim line (the dry wit, e.g. *"Twenty-four books. The same cast."*).
- **Cast wall** — the hero, owning the card's middle with real air: a centered
  theatrical **credits block** of **every carried name** (Castwave-dot separators), no
  "+N more". The full wall *is* the brag — the hero number proves *depth* (the designed
  count), the wall proves *breadth* (the whole carried ensemble); they're different facets
  of the same set, not a number that must match a row count. **Auto-scales**: name size
  steps down with cast size (~14.5px → ~10px); a tasteful cap engages only past ~45 names
  ("…and K more of your cast"), so it stays legible.
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
    "confirmedBookCount": 24,
    "spanBooks": 24,
    "books": [
      { "bookId": "bk_house-of-ash", "title": "House of Ash", "index": 1, "principalCount": 12 }
    ]
  },
  "carried": {
    "count": 56,
    "bespokeCount": 41,
    "designedCount": 39,
    "characters": [
      {
        "character": "Marrow",
        "aliases": ["The Warden"],
        "voiceId": "v_qwen_marrow",
        "voiceLabel": "Marrow (designed)",
        "engine": "qwen",
        "voiceKind": "designed",
        "firstBookId": "bk_house-of-ash",
        "lastBookId": "bk_last-light",
        "bookIndices": [1, 2, "…", 24],
        "carriedFullSpan": true
      }
    ]
  }
}
```

- **Books are keyed by durable `bookId`**, with `index` = the **library-sort order**
  (1..M) — *never* raw `seriesPosition` (often null; never trusted — see _What "carried"
  means_). `firstBookId` / `lastBookId` / `bookIndices` follow suit.
- `count` = carried **characters** (the unit); `bespokeCount` = designed + cloned;
  `designedCount` = Qwen-designed (the headline figure). `voiceKind ∈
  {designed,cloned,preset}` per character; `voiceLabel` is the `describeVoice()`
  descriptor (or designed-voice name); the catalogue slug is *not* a display field.
- `aliases` preserves the rename chain. **`carriedFullSpan` ≔ present in *every* confirmed
  book of the series** (1..M, no gap) — a late joiner or a mid-series gap is `false`, with
  `firstBookId`/`lastBookId`/`bookIndices` carrying the true reach.
- `schemaVersion` + `kind` let a later cast-export extend the shape without breaking
  consumers.

## Copy (locked, house-voice)

| Surface | Copy |
|---|---|
| Chip | `Your cast · N voices, M books` _(warm; N = carried **characters**, in-app only)_ |
| Sparkline caption | "N of your cast, kept true across the series." |
| Sparkline legend | "Carried" / "Other principals this book" |
| Reveal headline | "M books in, and not a voice has changed." |
| Reveal subtitle | "N voices, yours — book after book." |
| Reveal joiner note | "· from Bk K" |
| Card big number | `D designed voices` (bespoke-led; falls back to `N voices`) |
| Card elevated line | "kept true across all `spanBooks` books" |
| Card claim | "`spanBooks` books. The same cast." |
| Card footer | "&lt;user&gt;'s cast · kept true" (fallback "Your cast · kept true") |

`N` = **carried characters** — the number on the **chip** and the **reveal** (the term is
always "carried", never "recurring"). The **card's hero number leads on the
bespoke/designed figure `D`** (a subset of `N`). Book numbers split by surface: the warm
**in-app** surfaces (chip + reveal) use `M` = series book count, so a tapped chip and its
reveal always agree; the **exported** artifacts (card + JSON) use `spanBooks` (books that
actually carry), so nothing shared can overclaim.

Rules: no catalogue slugs (`bf_emma`) in any user-facing surface — JSON only. No "spine"
(engineering term) in UI; the device is a **book-marker row**. Marker glyph is the
**Castwave** mark, never a generic sparkle. Numbers stay **numeric** on chip/sparkline/
card-number; **spell out** in the large reveal headline (a small num-to-words helper,
spelling out through twenty and falling back to numerals above — "Fifty-six voices" is
clumsy at headline size). Ownership via *"yours"*, never *"you cast"* — the engine casts;
the listener owns.

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

- **Unit (Vitest):** the carried predicate (unit = **characters**) against the hard
  cases — voice-changed mid-series (excluded), renamed via alias (single canonical row,
  one carried character not two), **shared catalogue voice across two different
  characters** (two carried characters, *not* one — the bug a voiceId-grouping would
  cause), partial carry (excluded), late joiner (included, `carriedFullSpan:false`),
  **mid-series gap** (faint marker, `carriedFullSpan:false`); **confirmed-cast-only** (a
  `cast_pending` book doesn't move the count); **chain assembly walks newest→oldest over
  persisted `matchedFrom`** with no matcher re-run, correct `spanBooks`; per-book
  two-bucket partition over **principals** (carried + other-principals = principal count;
  walk-ons excluded); chip `N` == reveal row count; **`voiceKind` classification**
  (Qwen→designed, XTTS-clone→cloned, Kokoro→preset) and `bespokeCount`/`designedCount`;
  **bespoke-clause threshold** (all-preset carry → no markers); bespoke rows sort above
  preset; card big number = designed figure when it dominates, else total; the
  **≥3-character / ≥3-book / ≥1-bespoke threshold gate**; heuristic-series → no markers
  without real continuity; **book index by library sort when `seriesPosition` is null**; `spanBooks`
  never exceeds carried reach; JSON keyed by `bookId` (+ library `index`), incl.
  `carriedFullSpan` + `aliases` + `describeVoice` label; byline fallback when no display
  name.
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
