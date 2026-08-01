# Cast-authoritative character identity — design

**Status:** draft
**Closes:** #2040
**Upstream of:** #2023 (which recorded and surfaced the symptom, deliberately
leaving this root cause alone — see that issue's "Piece 3 — FILE ONLY" note)
**Related prior art:** #1972 (segments.json vs analysis-cache divergence on the
re-record path), #1981 / the cast.json write-lock design (§10 — sequencing)

## 1. What is actually wrong

A character's `id` is **free text produced by the LLM**, not derived from the
character's name by code. `characterSchema` validates it as
`z.string().min(1)` and nothing more (`server/src/handoff/schemas.ts:32`). The
analyzer prompt asks the model for "kebab-case ids that will be stable across
the rest of the book" (`server/src/routes/analysis.ts:1390`) and to "reuse
their `id` verbatim" on later chapters (`:1420`) — prose instruction to a
sampling model, with no code-side slugify anywhere on the analysis path.
`gemini.ts` and `ollama.ts` both pass the model's id through untouched.

That id is then used as the **join key between three independently-persisted
artifacts**: `cast.json`, the analysis cache (`server/handoff/cache/*.json`),
and each chapter's frozen `<slug>.segments.json`. When the model picks a
different slug on a later run, the join breaks, and
`synthesise-chapter.ts`'s `resolveGroup` silently substitutes the narrator.

`merge-analysis-cast.ts:1-27` already documents the non-determinism, naming the
exact incident this issue was filed about:

> The analyzer is non-deterministic about a character's id across runs (it
> relabelled the dragon `coalfall` → `coalfall-dragon` between two analyses of
> the same book).

### 1.1 Evidence

A scan of all 20 books in `C:\AudiobookWorkspace\books`, comparing each book's
`cast.json` against its analysis cache and its rendered segments, found drift
in **15 of them, across all 7 languages**. The id↔name mapping **flips
direction between books**, which no deterministic function of the name can do:

| display name | `cast.json` id | analysis-cache id |
|---|---|---|
| `Мэйрин` | `mairin` | `mayrin` |
| `Коалфолл` | `coalfall-dragon` | `coalfall` |
| `Brann Weir` (fr) | `brann-weir` | `brann` |
| `Brann` (es) | `brann` | `brann-weir` |
| `Alden` | `aldan` | `alden` |
| `Dame Alina` | `dame-alina` | `lady-alina` |

Five books carry rendered wrong-voice audio today (~9 minutes total), matching
the table filed on #2040.

### 1.2 Three distinct mechanisms

The issue was filed as one bug. It is three.

**RC1 — re-analysis rebuilds `cast.json` from the fresh roster.**
`mergeAnalysisResultWithExistingCast` (`merge-analysis-cast.ts:126-204`) takes
the *fresh* roster as its base and overlays only the nine
`PRESERVED_VOICE_FIELDS` from the prior cast, matched on id. Its same-name
fallback is gated on `isVoicedOrReused` (`:76-85`), so an **unvoiced**
character whose id drifted matches neither by id nor by name: `if (!old)
return f` writes the fresh row under the new id and the old id vanishes with no
trace. Already-rendered `segments.json` files are frozen at render time —
`segments-io.ts` has no writer outside the render pipeline — so they keep the
old id forever.

**RC2 — `cast-create.ts` mints ids with a different separator.** Its private
`slugify` (`server/src/routes/cast-create.ts:40-47`) uses
`.replace(/[^a-z0-9]+/g, '_')` — underscores — while every other minting path
uses `safeId`'s hyphens. _Playing with Fire_'s cast contains `the_torment`,
`pool_player`, `lightning_dave`, `desmond_edgley`; its analysis calls the same
characters `the-torment`, `pool-player-2`, `lightning-dave`. `the_torment` is
`voiceState=tuned, lines=0` — a voice was deliberately tuned for a character
that has never spoken a line, while 67 of its segments rendered in the
narrator's voice. This is the single largest wrong-voice population on the
issue's table.

**RC3 — folds target an id that is not a cast member.** `foldMinorCast` folds
minor characters into `unknown-male` / `unknown-female`, but 10 of the 20 books
have no such cast row. Three folds across two books point at a target that does
not exist — an orphan created by construction.

### 1.3 What actually happened to _Заказ Коалфолла_

Worth stating because it disproves the obvious fix. The Jul-14 re-analysis
produced the new ids **and correctly updated `cast.json`** —
`cast.json.bak.prewipe-20260714` holds `mayrin`/`coalfall`/`brann`/`berrin`/
`lessom`. `cast.json` was then restored from `cast.json.bak.castfix` (Jul 13,
pre-re-analysis; the current file is id-for-id identical to it) **without
reverting the analysis cache**. Chapter 3, rendered Jul 7, matches `cast.json`;
chapter 2, rendered Jul 31, reads the cache and orphans.

So reconciling *at re-analysis time* would not have saved this book — the
re-analysis was the one step that got it right. The fix has to make the
**join** robust, not try harder to keep three copies in step.

Chapter 3 is armed but has not fired: re-render it against today's cache and
five characters orphan at once.

## 2. Goals

- A `characterId` that drifted between runs still resolves to the right cast
  member at render time, including from a frozen `segments.json`.
- Re-analysis stops generating new drift.
- The two discrete defects (RC2, RC3) are fixed.
- The 15 already-drifted books are repaired, and the chapters holding
  wrong-voice audio are enumerated for re-render.
- A drift that cannot be resolved safely is **surfaced as actionable**, not
  silently narrator-substituted.

## 3. Non-goals

- Replacing the id with a UUID primary key. Considered and rejected for this
  round: it touches every artifact that stores a `characterId` and needs a
  migration for all 20 books. Revisit if this design proves insufficient.
- Rewriting `segments.json` or `chapterCast` to reconcile them. Both are
  historical record by explicit existing convention (`cast-merge.ts:14-16`);
  the resolver reads through the drift instead.
- Making the LLM's id deterministic. Out of our control, and the design should
  not depend on it.
- Auto-resolving name near-misses (`"Torment"` vs `"The Torment"`). See §4.2.

## 4. Design

### 4.1 `cast.json` is authoritative; the analyzer id becomes an alias

A `Character` gains one optional field:

```ts
/** Every analyzer-assigned id previously seen for this character. The
    analyzer is non-deterministic about ids across runs (#2040); a frozen
    segments.json or a stale analysis cache may still reference any of
    them. Resolution reads through this set — see cast-resolve.ts. */
idAliases?: string[];
```

Added to `characterSchema` (`server/src/handoff/schemas.ts`) as
`z.array(z.string()).optional()`, mirroring the existing `aliases` field.
`openapi.yaml` carries `Character` (line 6451, with `aliases` at 6462), so the
field is added there too and `src/lib/api-types.ts` is regenerated with
`npm run openapi:types` — the generated file is the type source of truth and is
never hand-edited.

`aliases` (display-name spellings) and `idAliases` (analyzer ids) stay separate.
They are matched against different things and conflating them would let a
display name resolve as an id.

### 4.2 The matcher: exact and encoding-equivalent only

Two mechanisms are easy to conflate; they are separate and this section
governs only the first.

- **The matcher** (this section) runs at **merge time**, over *display names
  and ids*, and decides whether a fresh analyzer row is the same person as an
  existing cast row — i.e. whether an `idAliases` entry is recorded at all.
- **The resolver** (§4.3) runs at **read time**, over *ids only*, and looks a
  `characterId` up against whatever aliases were already recorded. It never
  matches on names and never records anything.

Two matcher tiers auto-match. Nothing else does.

**Tier A — exact.** Byte-identical id, or byte-identical normalised display
name via the existing `normaliseForMatch` (`server/src/util/text-match.ts:18`).

**Tier B — encoding-equivalent.** A new pure helper:

```ts
// server/src/util/character-id.ts
/** Collapse the separator/case differences that distinguish two ids minted
    for the SAME name by different code paths (#2040 RC2: cast-create.ts
    minted `the_torment` while the analyzer minted `the-torment`). This is an
    encoding difference, not a semantic guess — it never merges two ids whose
    letters differ. */
export function normaliseIdKey(id: string): string;
```

Lowercase, collapse runs of `[-_\s]+` to a single `-`, trim leading/trailing
separators. `normaliseIdKey('the_torment') === normaliseIdKey('the-torment')`.

**Everything else is surfaced, not guessed.** `"Torment"` vs `"The Torment"`
and `unknown-male` carrying the name `"Lord Cassius"` are reported for a human
decision. This follows #1972's finding directly: on that repro the *analysis*
was the damaged copy, so a matcher confident enough to auto-reconcile is also
confident enough to destroy correct data.

The existing ambiguity guard is retained unchanged: if more than one candidate
on either side shares a normalised key, no match is recorded.

### 4.3 One resolver, every read site

```ts
// server/src/store/cast-resolve.ts
export interface CastResolution {
  character: CastRecord;
  /** Set when the id matched through an alias or a normalised key rather
      than an exact id — the caller may want to report the reconciliation. */
  viaAlias?: string;
}
export function buildCastResolver(cast: readonly CastRecord[]): {
  resolve(characterId: string): CastResolution | undefined;
};
```

Resolution order — four id-only lookups, tried in order, first hit wins: exact
id → exact `idAliases` → `normaliseIdKey`'d id → `normaliseIdKey`'d
`idAliases`. Display names are not consulted. Maps are built once per call, as
`castById` is today (`synthesise-chapter.ts:1474`).

The normalised tiers are what make wave 1 useful before any alias has been
recorded: `the-torment` resolves to the cast's `the_torment` on the third tier
with an empty `idAliases`.

Every site that today does a raw id lookup against the cast and can be reached
by *render-derived* data switches to the resolver:

| Site | Today | After |
|---|---|---|
| `synthesise-chapter.ts:2256` `resolveGroup` | `castById.get(id)` → narrator | resolver → narrator only on a true miss |
| `synthesise-chapter.ts:1526` `rendersNarrator` | `!castById.has(id)` | resolver miss |
| `synthesise-chapter.ts:2005` `chapterHasQwenGroups` | `castById.get(id)` | resolver |
| `revisions.ts:154` drift detector | `continue` on miss | resolver, then `continue` |
| `render-integrity/aggregate.ts:501` audition centroid | `undefined` hint | resolver |
| `chapter-qa-repair.ts:405` | falls back to `{}` | resolver |

The request-driven CRUD routes (`cast-aliases`, `cast-design`, `cast-merge`,
`cast-series-patch`, `qwen-voice`, `single-design`, `voice-library`,
`voice-override-linked`, `voice-style`) are **not** converted. Their id comes
from an API caller, not from manuscript attribution, and they correctly fail
loud with a 404. Resolving an alias there would let a stale client mutate a
character it did not name.

`resolveGroup`'s orphan path — the `console.warn`, `renderedFallbackCharacterId`
stamp, and the `UnresolvableClonedVoiceError` gate added by #2023 — is
untouched, and still fires when the resolver genuinely misses.

### 4.4 Stopping the generation of new drift

In `mergeAnalysisResultWithExistingCast`, when a fresh row matches a prior row:

1. **Keep the prior row's id.** The prior cast is the identity of record.
2. **Push the fresh id into `idAliases`** (deduped, first-seen order, mirroring
   `unionAliases`) so a frozen `segments.json` written under the fresh id still
   resolves.
3. **Emit `rewrites[freshId] = priorId`** into the rewrite table
   `applyRewriteToPriorCast` already consumes (`merge-analysis-cast.ts:224`,
   wired at `analysis.ts:4766`).

Step 3 is the load-bearing one. Today the run rewrites its sentence
attributions to the *fresh* ids and lets `cast.json` take them, which is
self-consistent within the run but strands every prior render. Emitting the
reverse rewrite lets the **existing** plumbing carry the prior id through the
analysis cache sentences and `manuscript-edits.json`. No new synchronisation
mechanism is introduced — the drift simply stops being produced.

**The name-fallback is widened past its `isVoicedOrReused` gate.** That gate is
RC1: it is exactly why unvoiced characters swap ids silently. The ambiguity
guard stays. This is the riskiest single change in the design (§9).

### 4.5 RC2 — `cast-create.ts` uses `safeId`

Replace the private `slugify` with `safeId` (`server/src/util/safe-id.ts`), the
canonical Unicode-preserving minter. Besides the separator, the private one
deletes every non-Latin character — the exact failure `safe-id.ts`'s own header
warns about, which would collapse a Cyrillic or CJK name to an empty or
colliding id. Existing underscore ids are handled by Tier B and by the repair
pass; no forced migration.

### 4.6 RC3 — a fold target must exist

`foldMinorCast` ensures its target row exists in the cast before folding into
it, creating it if absent (the shape 10 of 20 books already carry). A fold that
cannot establish its target is refused rather than silently producing an
orphan.

### 4.7 Surfacing what could not be resolved

#2023's banner (`src/views/cast.tsx:939-968`) currently lists every orphaned id
in one undifferentiated block. It splits in two:

- **Auto-reconciled** — resolved through an alias or normalised key.
  Informational, collapsed by default.
- **Needs your decision** — a genuine miss. Actionable, and shows the closest
  candidate by name so the user can confirm or reject a merge rather than
  reading raw ids.

`collectOrphanedCharacterFallbacks` (`segments-io.ts:292-306`) already carries
the per-segment data; it gains the resolution outcome so the frontend can split
the list without a second pass.

### 4.8 The repair pass

`scripts/repair-cast-id-drift.mjs`, following the existing repair-script
conventions (`chore(scripts)` commits, `.bak.<tag>` backups, pure helpers unit
tested):

- **Dry-run by default**; `--apply` to write.
- Walks `WORKSPACE_DIR`; for each book builds the resolver, then collects every
  analysis-cache and `segments.json` `characterId` with no cast resolution.
- Auto-records `idAliases` for Tier A / Tier B matches; writes
  `cast.json.bak.id-drift-<date>` first.
- Reports unresolved cases with their closest name candidate — the list the
  user works through by hand.
- Emits the **re-render list**: book, chapter, orphaned id, segment count,
  approximate affected duration. Deciding whether to spend GPU time on those
  re-renders is a separate call, not part of this work.

## 5. Testing

Per the testing-discipline rules, each behaviour ships paired coverage.

**Regression test that fails before and passes after** (the #2040 repro): a
chapter whose sentence group carries `mayrin`, against a cast holding `mairin`
with `idAliases: ['mayrin']`, renders in Мэйрин's designed voice — not the
narrator's — and stamps no `renderedFallbackCharacterId`.

| Layer | Coverage |
|---|---|
| unit (`server`) | `normaliseIdKey`: separator collapse, case, trim, non-Latin preserved, and that it never equates ids whose letters differ |
| unit (`server`) | `buildCastResolver`: each of the four tiers hits, and a true miss returns `undefined` |
| server | `mergeAnalysisResultWithExistingCast`: keeps the prior id, records the fresh id as an alias, emits `rewrites[fresh] = prior` |
| server | an **unvoiced** drifted character keeps its prior id (locks RC1) |
| server | the ambiguity guard still refuses to match when two candidates share a name key |
| server | a fold whose target is absent creates it; one that cannot is refused (RC3) |
| server | `cast-create` mints hyphen ids and preserves a Cyrillic name (RC2) |
| server | `resolveGroup` still records the #2023 orphan stamp on a genuine miss |
| scripts | repair-script pure helpers (candidate selection, re-render list shape) |
| e2e | cast view renders both banner states |

The golden-audio tier is not involved — no audio-assembly behaviour changes.

## 6. Waves

Each wave is independently shippable and independently useful.

| Wave | Ships | Standalone effect |
|---|---|---|
| 1 | `normaliseIdKey`, `buildCastResolver`, the six read sites, `idAliases` on the schema | Fixes the underscore population immediately — `the-torment`'s 67 segments resolve to `the_torment` via Tier B with no aliases recorded yet |
| 2 | merge-time alias recording + rewrite emission, RC2, RC3 | Stops new drift being generated |
| 3 | repair script, banner split, re-render list | Cleans up the 15 existing books |

## 7. Behaviour changes the user will notice

Called out because they are intended, not regressions:

- **Wave 1 changes rendering for books that currently look fine.** Any book
  where an underscore and a hyphen id coexist starts resolving lines that
  previously went to the narrator. `the_torment` is `voiceState=tuned` — it
  will begin speaking in the voice tuned for it, and affected chapters
  legitimately render differently from their last output.
- **Existing renders are not retroactively corrected.** Wave 1 fixes
  resolution; audio already on disk stays wrong until re-rendered. Wave 3
  enumerates what that would cost.

## 8. Docs to update

- `docs/features/` — the implementation plan for this spec.
- `CLAUDE.md` "Conventions worth preserving" — a line stating that `cast.json`
  is the identity of record and the analyzer id is an alias, so a future change
  does not reintroduce fresh-roster-wins.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — per-PR, per the
  before-shipping checklist.
- `docs/testing/onbox-acceptance-register.md` — a row for the wave-3 repair run
  against the real workspace, which cannot be proven in CI.

## 9. Risks

**Widening the name-fallback past `isVoicedOrReused` (§4.4) is the riskiest
change here.** It is necessary — it is RC1 — and the ambiguity guard still
applies, but it changes merge behaviour for every unvoiced character in every
book on every re-analysis. Two genuinely distinct characters that share a
normalised display name and appear one-per-run would now be welded. The
ambiguity guard is what prevents this, and it is guarded only by the
same-run candidate count, not by any cross-run history. This is the specific
thing the adversarial review pass should attack.

**Tier B could mask a real collision.** If a book legitimately contains two
characters whose ids differ only by separator, Tier B equates them. No such case
exists in the 20-book corpus, and the ambiguity guard catches it if one arises,
but it is a real narrowing of the id space.

**The repair pass writes to real user data.** Dry-run default plus per-book
backups are the mitigation; the unresolved cases are deliberately left for a
human rather than guessed.

## 10. Sequencing against the cast.json write lock

`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` is **in
flight right now** — not merged to `main`, but 8 commits deep on
`feat/server-1981-cast-lock` in the `C:\Claude\Projects\wt-1981-cast-lock`
worktree (29 files, +2454/-860), where it has already added
`server/src/workspace/cast-lock.ts` exporting `withCastLock`, `withCastLocks`
and `withLibraryVoiceLock`. It converts 35 `cast.json` read..write sites.

**The actual file overlap with this design is exactly one file**: the lock
branch touches `cast-create.ts` (and `cast-create.test.ts`), which §4.5 also
touches. Everything else this design lands in —
`merge-analysis-cast.ts`, `synthesise-chapter.ts`, `analysis.ts`,
`schemas.ts`, `segments-io.ts`, `revisions.ts`, `chapter-qa-repair.ts`,
`render-integrity/aggregate.ts` — is untouched by the lock branch. Verified by
`git diff --name-only main...HEAD` on that branch.

Consequences:

- §4.5 is a one-line change (swap the private `slugify` for `safeId`) in the
  one contended file. Whichever lands second rebases; the conflict is trivial.
- **The lock branch should merge first** regardless, because §4.4's caller
  sites in `analysis.ts` are lock sites in that design's Class 5, and building
  against the pre-lock shape means re-verifying afterwards.
- The repair script (§4.8) writes `cast.json` from **outside the server
  process**, which no in-process mutex covers. It must be run with the server
  stopped; that is a stated precondition of the script and it should refuse to
  `--apply` if it can reach a live server on the configured port.

## 11. Open questions

None. The two decisions that needed the repo owner — matcher aggressiveness
(§4.2) and whether to repair existing books (§4.8) — were taken before this
spec was written.
