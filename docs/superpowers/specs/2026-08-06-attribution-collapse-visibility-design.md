---
status: draft
date: 2026-08-06
---

# Attribution collapse visibility: say what happened, where the user will see it

Design work behind **#1984** — _"Attribution collapse is invisible: the
dropped-quotes panel shows the last batch only, in a transient view, and never
the effect."_

## Problem

On 2026-07-14 a real book in the library — _Der Auftrag von Coalfall_ (de) —
lost **103 of its 144 quoted sentences to the narrator** during analysis.
Dialogue collapsed from 178 lines to 41; ten of thirteen cast members ended up
with almost nothing to say. The book then sat that way for **17 days**, and the
damage was found only while chasing an unrelated bug. A library-wide sweep found
one other affected book (_Юный дрессировщик_, ru, 78%). Every other book in the
library measured ≤ 15%, most 0–3%.

The signal was not absent. It could not have communicated the damage:

1. **Latest batch only.** `DroppedQuotesPanel`
   (`src/components/analysing/phase-card.tsx:252`) narrows to
   `batches[batches.length - 1]`. The book accumulated 16 dropped attributions
   across 5 batches; the final batch dropped 1. The user was shown _"Verifier
   dropped 1 quote across 1 character."_
2. **Styled to recede.** A `<details>` at `text-[11px] text-ink/60`.
3. **Transient.** It exists only on the analysing screen. Once analysis
   finished there was no residue anywhere — no badge, no banner, nothing on the
   book.
4. **It reports the cause, not the effect.** "N quotes dropped" is a
   verifier-internal statistic. The number that decides whether the book is
   usable is _"103 of 144 quoted sentences are now attributed to the narrator"_,
   and that number is never computed anywhere.

Point 4 is the crux: **the two numbers are not proportional.** Dropping one
quote can re-attribute a long run of dialogue; dropping ten can be harmless.
Here, 16 drops produced a 72% collapse. A user cannot infer the second number
from the first.

### What this is not

The corruption itself was produced by the pre-fix analyzer of
[#1598](https://github.com/dudarenok-maker/Castwright/issues/1598), which closed
11 minutes after this book's journal was written. Re-analysis on current `main`
takes the book from 72% → 0% and 41 → 178 dialogue lines with all 13 voice
assignments preserved, so #1598's fix is confirmed good on real data.

**This spec changes no analyzer behaviour.** It is about the fact that when
attribution collapses — for any reason, including future ones — the product does
not tell the user in terms they can act on, and the damage persists silently
into every downstream render.

## Decisions taken

Recorded here because each was a product call, not an engineering one:

| # | Decision |
|---|---|
| D1 | **Warn everywhere; require an acknowledgement before generating; never permanently refuse.** A collapsed book can always be generated — but not by accident. |
| D2 | **One book-level threshold decides the state; per-chapter figures are shown as detail** and never trigger anything on their own. |
| D3 | **Badge on the library card AND a banner in the Cast view.** Auto-clears when a re-analysis drops it under the line; an explicit per-book dismiss handles the false positive. |
| D4 | **A dismissal re-arms on every new analysis.** A new run is new evidence. |
| D5 | **Copy leads with the effect; the verifier's cause is available but secondary.** |
| D6 | **The analysing-view panel is fixed in place (cumulative, not last-batch); the collapse warning appears at the end of the run, not live mid-run** — the figure swings wildly over a novel's opening chapters. |
| D7 | **Stamp for the library, live compute for the detail surfaces** (§Storage). |

## The metric

New pure module `server/src/store/attribution-health.ts`. No I/O, no model call.

**Universe.** Sentences from the book's analysis cache
(`server/handoff/cache/{manuscriptId}.json`), minus chapters marked `excluded`
in `state.json` — EPUB back-matter would otherwise skew the denominator — and
minus sentences flagged `excludeFromSynthesis` (import residue: page numbers,
running headers).

**Numerator and denominator.**

- Denominator: sentences where `isSpokenLine(text)` is true, **reusing
  `server/src/analyzer/narrator-default.ts:29` verbatim, not a second copy.**
  Whatever the analyzer treats as a spoken line is what we measure; a divergent
  second implementation would report a number the analyzer does not act on.
- Numerator: of those, sentences whose speaker resolves to `narrator`.

**Resolution, not raw comparison.** The sentence's `characterId` goes through
`buildCastResolver` (`server/src/store/cast-resolve.ts`) before the narrator
test, per the CLAUDE.md rule that an analyzer `characterId` is only an alias
into `cast.json`. A raw `=== 'narrator'` comparison would miscount any book
whose ids drifted — the #2040 class of bug.

**Thresholds** — hardcoded exported constants. Deliberately **not** registry
knobs: nobody asked for them to be tunable, and a knob would owe an
Advanced-Settings row and a config-sync entry for no benefit.

```
COLLAPSE_SHARE_THRESHOLD = 0.40   // book is collapsed at or above
MIN_SPOKEN_FOR_VERDICT   = 20     // fewer spoken sentences → no verdict at all
MIN_SPOKEN_PER_CHAPTER   = 5      // fewer → chapter shows "—", not a misleading %
```

0.40 sits clear of the worst healthy book measured (15%) and well under both
damaged books (72%, 78%).

**Shape:**

```ts
interface AttributionHealth {
  spokenTotal: number;
  narratorSpoken: number;
  share: number | null;          // null when spokenTotal < MIN_SPOKEN_FOR_VERDICT
  collapsed: boolean;            // share !== null && share >= COLLAPSE_SHARE_THRESHOLD
  chapters: {
    chapterId: number;
    spokenTotal: number;
    narratorSpoken: number;
    share: number | null;        // null under MIN_SPOKEN_PER_CHAPTER
  }[];
  quietCastCount: number;        // cast members other than narrator with < 2 spoken lines
  castCount: number;             // cast members other than narrator
  analysedAt: string;            // set ONLY by an analysis run — the dismissal key
  measuredAt: string;            // bumped by any recompute
}
```

**The two timestamps are load-bearing.** Under D7 the stamp is refreshed
opportunistically by detail-surface reads. If the dismissal keyed on
`measuredAt`, a dismissed book would re-arm the next time anyone opened it.
`analysedAt` moves only when an analysis run writes it, so D4 ("re-arms on every
new analysis") means exactly that and nothing more.

**When there is no prior stamp** — a book analysed before this shipped, read by a
detail surface before the backfill runs — the refresh has no `analysedAt` to
preserve. It uses the analysis cache file's mtime, identical to what the backfill
script would have written. The two paths must agree, or whichever runs second
would silently re-arm a dismissal the other had honoured.

## Storage and data flow

`GET /api/library` never reads the analysis cache, and it must not start:
measured on the reference box, the cache is **76 files, 24.9 MB total, largest
3.4 MB.** Loading all of it to render a badge on every library navigation is not
viable. Hence the split.

### Two files, not one

The derived counts and the user's dismissal are different kinds of data — one is
a cache anything may overwrite, the other is user intent nothing may lose.
Storing them together would make every opportunistic refresh a read-merge-write
over the dismissal, with a race that silently discards it.

| File | Written by | Contains |
|---|---|---|
| `.audiobook/attribution-health.json` | analysis completion, opportunistic refresh, backfill script | the counts, `analysedAt`, `measuredAt` |
| `.audiobook/attribution-dismissal.json` | the dismiss endpoint only | `{ dismissedForAnalysedAt: string }` |

Both get path constants in `server/src/workspace/paths.ts` alongside
`droppedQuotesJsonPath`. Neither touches `cast.json`, so no `withCastLock`
involvement and no new lock class.

### Write sites at analysis completion

The same two places that already append a dropped-quotes batch:
`analysis-stream` and `analysis-chapters` in `server/src/routes/analysis.ts`.

**`analysis-chapters` is a subset re-run and must recompute over the whole
book,** not the chapters it just did. A subset run that fixes three chapters
still moves the book-level figure, and it does count as new evidence — so it
stamps a fresh `analysedAt` and re-arms any dismissal.

### API

`openapi.yaml` is edited first (it is the type source of truth), then
`npm run openapi:types`.

- `GET /api/books/:bookId/attribution-health` — computes live from that book's
  cache, refreshes the stamp as a side effect while preserving `analysedAt`, and
  returns `AttributionHealth` plus two merged fields the store shape does not
  carry:

  ```ts
  type AttributionHealthResponse = AttributionHealth & {
    state: 'ok' | 'collapsed' | 'unmeasurable';
    dismissed: boolean;    // dismissedForAnalysedAt === analysedAt
  };
  ```

  `state` is derived server-side so the three placements and the library badge
  cannot drift into four different readings of the same numbers.
- `POST /api/books/:bookId/attribution-health/dismiss` — body
  `{ analysedAt: string }`, writes the dismissal file.
- `GET /api/library` — each book gains `attributionCollapsed: boolean`, read
  from the stamp and already net of the dismissal.

### Backfill

`scripts/backfill-attribution-health.mjs` walks the workspace and stamps every
book that lacks one, using the analysis cache file's mtime as `analysedAt`.
Books with no cache are skipped and reported. Pure helpers unit-tested in
`scripts/tests/`, matching the `build-companion-apk.test.mjs` pattern. Run once
after deploy; the two known damaged books badge immediately.

### Frontend state

The library badge comes free from the existing `library-slice.ts` payload. The
three detail surfaces share one small `attribution-slice.ts`, fetched once when
a book is opened, with an optimistic dismissal — rather than three independent
`useEffect` fetches. The generation acknowledgement reads the same slice via the
existing `start-generation-flow.ts`.

## Surfaces and copy

One shared component, `src/components/attribution-collapse-notice.tsx`, in three
placements plus a badge and a bug fix.

### The notice

```
⚠  Most of this book's dialogue is being read by the narrator.

   72% of quoted lines (103 of 144) went to the narrator.
   10 of 13 cast members have almost nothing to say.

   The verifier dropped 16 quotes across 5 passes in this
   analysis, which is often the cause.

   [ Re-run analysis ]  [ Chapter breakdown ▾ ]
   [ Dropped quotes ▾ ] [ This book is fine — dismiss ]
```

- **"almost nothing to say"** is defined, or it cannot be computed: cast members
  other than the narrator with **fewer than 2** spoken sentences attributed to
  them (`quietCastCount` / `castCount`). Same single pass as the metric.
- The cause line is **omitted entirely** when the run dropped no quotes.
  Collapse has other causes, and a "dropped 0 quotes" line would misdirect.
- `Chapter breakdown` and `Dropped quotes` are collapsed `<details>`. The
  breakdown renders the per-chapter table; chapters under
  `MIN_SPOKEN_PER_CHAPTER` show `—`.

### Placements

| Surface | Treatment |
|---|---|
| `src/views/confirm-cast.tsx` | Full notice above the cast list. `Re-run analysis` wires to the existing `onReanalyse` prop. |
| `src/views/cast.tsx` | Full notice at the top of the view, where the empty cast members are visibly the symptom. |
| `src/views/generation.tsx` / `src/store/start-generation-flow.ts` | Full notice as the acknowledgement gate. Buttons become `[ Re-run analysis ]` and `[ Generate anyway ]`. Asked on **every** generation start until fixed or dismissed. |
| `src/components/library/library-status-ui.tsx` | Badge only — warning icon + `Attribution`, no number. |

The badge goes through the shared status module so the **grid and the table**
both get it; adding it to `library-grid.tsx` alone would leave the table view
silent.

Dismissal clears all four at once — it writes `dismissedForAnalysedAt`, and
every surface reads the same slice.

### The panel fix

`phase-card.tsx:252`'s `batches[batches.length - 1]` becomes a sum over the
current run's batches. "The run" needs an identity the ledger does not currently
have — batches carry only `recordedAt` and `route`. So `DroppedQuotesBatch`
gains a **`runId`**: an ISO timestamp minted at run start and threaded to the
batch write in both analysis routes.

Backward compatible: the file is append-only and existing batches have no
`runId`, so they group as a single legacy run. Without this, "sum across
batches" can only mean "sum across all history" — which would show a
re-analysed, now-healthy book its old failures forever, since the ledger is
never truncated.

## Failure modes

The computation **fails open**: a book whose cache is absent or corrupt must not
500 the library or block generation. But failing open is how a book goes silent,
which is the entire complaint in #1984. So there are **three** states, not two:

| State | Library | Cast view |
|---|---|---|
| `ok` | nothing | nothing |
| `collapsed` | badge | full notice |
| `unmeasurable` | nothing | quiet line: _"Attribution health couldn't be measured for this book."_ |

A book that has never been analysed is `ok`, not `unmeasurable` — there is
nothing to measure yet. `assertCacheChaptersShape`
(`server/src/store/analysis-cache.ts`) already throws a named error on
corruption; we catch it, log it, and land in `unmeasurable` rather than
swallowing it into silence.

### Edge cases, decided

| Case | Behaviour |
|---|---|
| Zero spoken sentences (non-fiction, pure narration) | `share: null`, not collapsed. There is nothing to collapse. |
| Fewer than 20 spoken sentences | `share: null`, no verdict. |
| Dismissal file present, `analysedAt` mismatched | Ignored — re-armed. |
| User excludes back-matter chapters after analysis | Live compute on the detail surfaces picks it up immediately; the stamp catches up on the next read. Consistent with D7. |
| First-person book | See below. |

### Known false positive: first-person narration

The analyzer resolves a first-person speaker to a **roster character**
(`server/src/analyzer/dialogue-structure/evidence.ts:28`, `windows.ts:56`), not
to `narrator`, so a healthy first-person book should not trip this. If that
resolution fails, the protagonist's dialogue legitimately lands on `narrator`
and the book reads as collapsed when it is not.

This is why D3 keeps a manual dismiss. It is a documented limitation, not a
defect to be designed away.

## Testing

**Pure metric (Vitest, server).** Thresholds at 0.39 / 0.40 / 0.41; the
20-sentence floor; chapter floor rendering `null`; excluded chapters and
`excludeFromSynthesis` removed from **both** numerator and denominator; a
sentence carrying a retired id still counting as narrator through
`buildCastResolver`; zero spoken → `null`; the `quietCastCount` "< 2 lines"
count.

**Store.** Stamp read/write; dismissal read/write; refresh preserves
`analysedAt` while bumping `measuredAt`.

**Routes.** GET computes and refreshes; POST dismiss; a **subset** re-run
recomputes the whole book and re-arms a dismissal; corrupt cache →
`unmeasurable`, not 500; `GET /api/library` carries `attributionCollapsed` net
of the dismissal.

**The named regression test.** A ledger fixture with 5 batches in one run whose
last batch holds 1 entry, asserting the panel reads "16 quotes across 5 passes".
**Fails on current `main`, passes after** — this is the fails-before/passes-after
test the bug fix owes.

**Frontend (Vitest + RTL).** Notice renders each state; cause line omitted at 0
drops; chapter rows show `—` under the floor; badge present in **both** the grid
and the table; dismissal clears all four surfaces.

**E2E (Playwright).** One spec: a collapsed book badges in the library, banners
in Cast, gates generation, and dismissal clears all three. It crosses
router/redux/layout seams, so it is required rather than optional.

**Scripts.** Backfill pure helpers unit-tested in `scripts/tests/`.

**Neutralisation proof.** Every threshold assertion is mutated on its own line
and observed to go red, and the proof is recorded in the PR body. Given how
often a green-checking-nothing test has shipped in this repo, the plan makes
this a step rather than a hope.

## On-box acceptance — owed

Fixtures prove the metric. They cannot prove that on the real workspace exactly
the two known books flag and the other ~74 stay quiet.

Register row: run `scripts/backfill-attribution-health.mjs` against the live
workspace, record which books flagged, and specifically confirm no first-person
book in the library false-positives. The register, the per-feature run sheet,
and the live view all move in the shipping PR.

## Out of scope

- **Any change to the analyzer.** #1598's fix is confirmed good on real data;
  this is visibility only.
- **Automatic re-analysis.** The button is the only trigger; nothing re-runs on
  its own.
- **Threshold configurability.** No registry knob.
- **A per-chapter warning state.** Per D2, chapters are detail, never a trigger.
- **Live mid-run collapse warning.** Per D6.

## Acceptance criteria

1. A book at ≥ 40% narrator-attributed spoken lines (≥ 20 spoken lines) shows a
   badge in the library grid **and** table, and a full notice in Cast and at the
   confirm step.
2. Starting generation on such a book requires an explicit acknowledgement; it
   is never permanently refused.
3. Dismissing clears all four surfaces, and a subsequent analysis run re-arms
   the warning.
4. A re-analysis that drops the figure below the threshold clears the warning
   with no user action.
5. The analysing-view panel reports the run's cumulative drops across all its
   batches, not the last batch.
6. A book with an absent or corrupt analysis cache neither 500s nor silently
   reads as healthy in the Cast view.
7. The backfill script stamps every existing book; the two known damaged books
   badge, and no book measured ≤ 15% in the original sweep does.
