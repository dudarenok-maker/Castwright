---
status: stable
shipped: 2026-05-22
owner: null
---

# Series-prior roster dedup

> Status: stable
> Key files: `server/src/workspace/series-prior-dedup.ts`, `server/src/routes/analysis.ts`, `src/views/analysing.tsx`
> URL surface: indirect — the dedup powers the `series-prior` SSE event consumed by `#/books/<id>/analyse`
> OpenAPI ops: `POST /api/manuscripts/{id}/analysis` (SSE), `POST /api/manuscripts/{id}/analysis/chapters` (SSE)

## Benefit / Rationale

- **User:** the "Carried in from prior books in this series · N characters" pill on the analysing view now reports the count of **unique characters**, not raw cast.json rows summed across every prior book. the Hollow Tide #4 (Saltgrave) previously showed 136 because Wren / Marlow / Oduvan et al. were each counted once per prior book; the deduped count reflects what the user actually expects (one entry per recurring character).
- **Technical:** the Phase 0a per-chapter detection prompt no longer carries duplicate rows for series-regulars. On a 4-book series with ~30 recurring characters, the prompt's "Known characters from prior books in this series" block shrinks from ~120 rows to ~30 — a measurable per-chapter token saving that compounds across the per-chapter call fan-out.
- **Architectural:** dedup is a derived-view concern; the producer (`scanSeriesCharacters`) stays raw because a second consumer (`GET /api/books/:bookId/series-roster` — the Profile Drawer's manual continuity-link picker) legitimately needs per-book provenance to support "fold this duplicate into Wren-from-Keeper specifically." Adding a thin merge layer at the analyser route preserves both shapes without forking the scan.

## Architectural impact

- **New seam:** `dedupSeriesPrior(records: LibraryCharacterRecord[]): DedupedSeriesPriorEntry[]` in `server/src/workspace/series-prior-dedup.ts`. Pure function over the producer's record shape; testable in isolation.
- **Type rename:** `SeriesPriorCharacter.fromBookTitle?: string` → `fromBookTitles?: string[]`. Both prompt-rendering sites (`buildStage1ChapterInbox` and its subset-retry sibling at `analysis.ts:~3315-3331`) emit the plural field. The skill doc and `04-analysing-view-progress.md` were updated to match.
- **SSE payload unchanged:** the `{ kind: 'series-prior', count, names }` event keeps the same shape — `count` now reports the deduped count, `names` is the first three unique-character names. The frontend pill (`SeriesPriorPill` in `src/views/analysing.tsx`) and the analysis slice's `setSeriesPrior` reducer needed no changes.
- **Producer + Profile Drawer route preserved:** `server/src/workspace/series-cast-scan.ts` and `server/src/routes/series-roster.ts` are untouched. The per-book list still flows verbatim to the manual continuity-link picker.
- **Reversibility:** revert the route's `dedupSeriesPrior(siblingRecords)` call to restore the pre-dedup behaviour. The helper file and tests can stay or be deleted independently.

## Invariants to preserve

1. **Match rule matches the prompt template's own contract.** The dedup key normalises name and each alias via `toLowerCase().replace(/[^a-z0-9]/g, '')` — the same "case-insensitive, ignoring punctuation" rule the prompt instructs the model to apply (`server/src/routes/analysis.ts:~832`). Drift between the two would let the model see merged rows it then tries to re-split, or vice versa.
2. **Union-find for transitive merges.** Three records A↔B (via alias) and B↔C (via name) collapse into one group. A pairwise single-pass index would miss the A↔C link.
3. **First-occurrence wins the canonical id + name.** The lowest record index in the input becomes the group root. Producer book-walk order is deterministic, so the canonical id is stable across runs.
4. **Producer un-deduped.** `scanSeriesCharacters` and `scanSeriesCharactersForBookId` (`server/src/workspace/series-cast-scan.ts`) keep emitting one row per character per book. The Profile Drawer's manual continuity-link picker depends on this shape; do not push dedup into the producer.
5. **Canonical-name alias collapsed in output.** If a record's only alias is its own name (case/punct-insensitive), it is dropped from the rendered aliases array — saves prompt tokens.
6. **Empty / whitespace-only aliases do not bridge records.** Defensive against bad cast.json data: a `""` alias must NOT act as a token that unions two unrelated characters.

## Test plan

### Automated coverage

- Vitest server (`server/src/workspace/series-prior-dedup.test.ts`) — 10 cases covering: empty input, same-name across two books → 1 merged entry with both source titles, alias-overlap merge (Book B alias matches Book A name), punctuation/case-insensitive merge (`Mr. Casper` ↔ `mr casper`), disjoint characters stay separate, alias union across 3 books with canonical-name collapse, alias-chain transitive merge via union-find, first-seen book-walk output ordering, empty/whitespace aliases do NOT bridge, compact output omits empty aliases.
- Vitest server (`server/src/routes/analysis.test.ts:~1151`) — asserts `buildStage1ChapterInbox` renders the plural `fromBookTitles` array shape, that the singular legacy field is absent, and that a single-entry case still renders as a one-element array (schema stability for downstream prompt-parity tests).

### Manual acceptance walkthrough

1. **Cold boot, the Hollow Tide Saltgrave analysis** → start analysis on Saltgrave. Expected: under the "Detecting characters" phase card, the pill reads `Carried in from prior books in this series · ~30-50 characters` (one row per unique character across prior books). The console log entry "Carrying in N characters from prior books in this series (…)" reports the same N. Pre-fix: ~136.
2. **Profile Drawer continuity-link picker** → in the cast view, open a character's profile and trigger the manual continuity-link picker. Expected: the per-book entries still show up separately (Wren-from-Keeper AND Wren-from-Exile are both selectable). This proves the producer scan + `GET /api/books/:bookId/series-roster` route were NOT affected by the dedup.
3. **Standalone book** → start analysis on a standalone (no series siblings). Expected: pill is omitted entirely; the prompt section is omitted entirely. Same behaviour as pre-fix.
4. **Subset retry** → trigger a single-chapter retry on a series book. Expected: the per-chapter prompt's "Known characters from prior books in this series" section carries the deduped roster (same shape as the main run).

## Out of scope

- Cross-series carry-over (Wren appearing in Keeper + a spinoff in a different series). Tracked in `server/src/workspace/series-cast-scan.ts:12-15` and `docs/BACKLOG.md`.
- Fixing schema drift where the same character has different `id`s across books. Dedup picks first-wins; if a user has bad cross-book id drift the merged entry surfaces it, but no automated id reconciliation.
- Touching per-book cast.json files on disk. The dedup is purely a derived view; no migration.

## Ship notes

Shipped: 2026-05-22 — commit `4d80397`, merged via [PR #137](https://github.com/dudarenok-maker/AudioBook-Generator/pull/137) as merge commit `cb69843`.

Behaviour delta vs. the original Phase 0a series-prior implementation (plan 04 §series-cast prior bullet): the prompt and the pill both saw raw per-book rows; this plan inserts `dedupSeriesPrior` between the producer and both consumers so the pill reflects unique-character count and the prompt carries one row per character. The producer and the Profile Drawer's continuity-link picker route were intentionally left raw.
