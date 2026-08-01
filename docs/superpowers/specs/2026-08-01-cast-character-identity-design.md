# Cast-authoritative character identity — design

**Status:** draft
**Closes:** #2040
**Upstream of:** #2023 (which recorded and surfaced the symptom, deliberately
leaving this root cause alone — see that issue's "Piece 3 — FILE ONLY" note)
**Related prior art:** #1972 (segments.json vs analysis-cache divergence on the
re-record path), plan 122 (the 2026-05-27 one-off id repair whose residue is
§1.4), the cast.json write-lock design (§10)

**Review:** one adversarial pass (Premium tier). It broke three load-bearing
claims of the first draft — the rewrite-emission mechanism was inert, the RC3
diagnosis was a no-op, and the read-site conversion opened a clone-validation
hole. All three are corrected below and the corpus figures were re-measured.
Two of its findings were themselves wrong and are recorded in §12 so they are
not re-litigated.

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
and each chapter's frozen `<slug>.segments.json`. When any one of the three
moves without the others, the join breaks and `synthesise-chapter.ts`'s
`resolveGroup` silently substitutes the narrator.

`merge-analysis-cast.ts:136-140` already documents the non-determinism, naming
the exact incident this issue was filed about:

> The analyzer is non-deterministic about a character's id across runs (it
> relabelled the dragon `coalfall` → `coalfall-dragon` between two analyses of
> the same book).

### 1.1 Evidence

Scanning all 20 books in `C:\AudiobookWorkspace\books`, comparing each book's
`cast.json` against its analysis cache and its rendered segments:

| measure | value |
|---|---|
| books scanned | 20 |
| books with drift somewhere (cache or rendered) | **18** |
| books with **wrong-voice audio on disk** | **5** |
| distinct orphaned ids in rendered segments | **11** |
| orphaned segments (wrong-voice audio) | **188** |

The 188 figure reproduces #2040's own table exactly (74 + 34 + 53 + 21 + 6).

The id↔name mapping **flips direction between books**, which no deterministic
function of the name can do:

| display name | `cast.json` id | analysis-cache id |
|---|---|---|
| `Мэйрин` | `mairin` | `mayrin` |
| `Коалфолл` | `coalfall-dragon` | `coalfall` |
| `Brann Weir` (fr) | `brann-weir` | `brann` |
| `Brann` (es) | `brann` | `brann-weir` |
| `Alden` | `aldan` | `alden` |
| `Dame Alina` | `dame-alina` | `lady-alina` |

### 1.2 Three mechanisms

**RC1 — the analyzer's id is unstable across runs.** Two observed shapes: a
*rename* (`coalfall` ↔ `coalfall-dragon`) and a *collision onto a reserved
string* (§1.4: the model emitted `unknown-male` — a fold-bucket id — as the id
for a character it named "Timkin"). Downstream,
`mergeAnalysisResultWithExistingCast` (`merge-analysis-cast.ts:126-204`) takes
the *fresh* roster as its base and overlays only the nine
`PRESERVED_VOICE_FIELDS`, matched on id. Its same-name fallback is gated on
`isVoicedOrReused` (`:76-85`), so an **unvoiced** character whose id drifted
matches neither by id nor by name: `if (!old) return f` writes the fresh row
under the new id and the old id vanishes with no trace.

**RC2 — `cast-create.ts` mints ids with a different separator.** Its private
`slugify` (`server/src/routes/cast-create.ts:40-47`) uses
`.replace(/[^a-z0-9]+/g, '_')` — underscores — while every other minting path
uses `safeId`'s hyphens. _Playing with Fire_'s cast contains `the_torment`,
`pool_player`, `lightning_dave`, `desmond_edgley`; its analysis calls the same
characters `the-torment`, `pool-player-2`, `lightning-dave`. `the_torment` is
`voiceState=tuned, lines=0` — a voice was deliberately tuned for a character
that has never spoken a line, while 67 of its segments rendered in the
narrator's voice. Besides the separator, the private slugifier deletes every
non-Latin character, the exact failure `safe-id.ts`'s own header warns about.

**RC3 — an id change migrates some surfaces and not others.** This is the
mechanism that actually strands rendered audio, and it is not model-related at
all. **Nothing in the codebase ever migrates a frozen `<slug>.segments.json`.**
`segments-io.ts` is write-only from the render pipeline; every other consumer
is a pure reader. Meanwhile several code paths *do* change a persisted id:

- `roster-dedup.ts:75-103` re-ids a Tier-1 survivor to `safeId(group[0].name)`
  and emits a rewrite. **Only `NARRATOR_ID` is exempt** (`:84`) — the
  `unknown-*` buckets are not, so a roster where the analyzer again emits
  `unknown-male` beside a real row collapses both.
- `applyRewriteToPriorCast` (`merge-analysis-cast.ts:224-275`) applies that
  rewrite table to the **already-persisted prior cast**, swapping the id on a
  live row (`:235`).
- `analysis.ts:735` migrates sentence attributions through the same table.
- Out-of-band repairs and restores do the same by hand (§1.3, §1.4).

Two of three surfaces move; the frozen render does not. Every stranding event
traced in §1.3 and §1.4 has this shape.

### 1.3 What happened to _Заказ Коалфолла_

The Jul-14 re-analysis produced new ids **and correctly updated `cast.json`** —
`cast.json.bak.prewipe-20260714` holds `mayrin`/`coalfall`/`brann`/`berrin`/
`lessom`. `cast.json` was then restored from `cast.json.bak.castfix` (Jul 13,
pre-re-analysis; the current file is id-for-id identical to it) **without
reverting the analysis cache**. Chapter 3, rendered Jul 7, matches `cast.json`;
chapter 2, rendered Jul 31, reads the cache and orphans.

So reconciling *at re-analysis time* would not have saved this book — the
re-analysis was the one step that got it right.

Chapter 3 is armed but has not fired: re-render it against today's cache and
five characters orphan at once.

### 1.4 What happened to _Exile_ and _Unlocked_ (69 of the 188 segments)

The analyzer emitted the reserved bucket id `unknown-male` as the id for real
named characters — Exile's cache binds it to Timkin (ch7), Brant (ch11), Dwarf
(ch24), Rex (ch33) and Lord Cassius (ch34), and `unknown-female` to Vika (ch7)
and Bex (ch33). These rows carry **`color: "unknown-male"`**, a value no server
code can produce (`assignPaletteColors`, `analysis.ts:279-287`, emits only
`'narrator'` or a `PALETTE_SLOTS` entry), proving they are raw model output
echoing the model's own id rather than anything server-side renaming a bucket.

The renders were therefore **correct when made**. `cast.json.bak.r2`
(2026-05-27) holds `unknown-male` = "Timkin" with 21 lines and `unknown-female`
= "Vika" with 14 — matching the 21 and 14 orphaned segments exactly. Plan 122's
one-off repair (shipped 2026-05-27, PR #295, its Ship notes describing
"breaking named characters out of fold-bucket ids") renamed them to
`timkin`/`vika`, rewriting `cast.json` **and** `manuscript-edits.json` but not
the frozen segments.

`foldMinorCast` is exonerated: it already synthesises a missing bucket row
(`fold-minor-cast.ts:294-303`) and `withCounts` (`:355-360`) forces a drifted
bucket's name back to generic, so it can never produce
`{id:'unknown-male', name:'Lord Cassius'}`.

## 2. Goals

- A `characterId` that drifted still resolves to the right cast member at
  render time, including from a frozen `segments.json`.
- No code path changes a persisted character id without recording the old one.
- The two discrete defects (RC2, and RC3's live dedup path) are fixed.
- The already-drifted books are repaired, and the chapters holding wrong-voice
  audio are enumerated for re-render.
- A drift that cannot be resolved safely is **surfaced as actionable**, not
  silently narrator-substituted.

## 3. Non-goals

- Replacing the id with a UUID primary key. Considered and rejected for this
  round: it touches every artifact that stores a `characterId` and needs a
  migration for all 20 books. Revisit if this design proves insufficient.
- **Retro-migrating ids inside frozen `segments.json` files.** The resolver
  reads through the drift instead. (Narrower than the first draft's wording:
  `chapter-qa-repair` legitimately rewrites a segments file as part of its
  normal repair job — see §4.3 — and that is not what this non-goal forbids.)
- Making the LLM's id deterministic. Out of our control, and the design must
  not depend on it.
- Auto-resolving name near-misses (`"Torment"` vs `"The Torment"`). See §4.2.

## 4. Design

### 4.1 `cast.json` is authoritative; the analyzer id becomes an alias

A `Character` gains one optional field:

```ts
/** Every analyzer-assigned or previously-persisted id seen for this
    character. The analyzer is non-deterministic about ids across runs, and
    several code paths rename a persisted id (#2040 §1.2 RC3); a frozen
    segments.json or a stale analysis cache may still reference any of them.
    Resolution reads through this set — see cast-resolve.ts. */
idAliases?: string[];
```

Added to `characterSchema` (`server/src/handoff/schemas.ts`) as
`z.array(z.string()).optional()`, mirroring the existing `aliases` field.
`openapi.yaml` carries `Character` (line 6451, `aliases` at 6462), so the field
is added there too and `src/lib/api-types.ts` is regenerated with
`npm run openapi:types`.

`aliases` (display-name spellings) and `idAliases` (ids) stay separate — they
are matched against different things, and conflating them would let a display
name resolve as an id.

**`idAliases` must survive a client cast write.**
`preserveDesignedVoicesOnCastWrite` (`server/src/workspace/preserve-cast-voices.ts:44`)
protects exactly three fields plus `voiceUuid`; a `PUT /:bookId/state` slice
`'cast'` writes the roster verbatim otherwise, so any client round-trip that
omits `idAliases` would erase it — destroying the only thing that makes frozen
segments resolve. `idAliases` joins that preserved set with **union**
semantics, not the fill-the-gap semantics the three design fields use: the set
accumulates and must never shrink through a round-trip. The frontend's
`hydrateFromAnalysis` overlay (`src/store/cast-slice.ts`) needs the same
treatment.

### 4.2 The matcher: exact and encoding-equivalent only

Two mechanisms are easy to conflate; they are separate and this section
governs only the first.

- **The matcher** (this section) runs at **merge/repair time**, over *display
  names and ids*, and decides whether a fresh row is the same person as an
  existing cast row — i.e. whether an `idAliases` entry is recorded at all.
- **The resolver** (§4.3) runs at **read time**, over *ids only*, and looks a
  `characterId` up against aliases already recorded. It never matches on names
  and never records anything.

Two matcher tiers auto-match. Nothing else does.

**Tier A — exact.** Byte-identical id, or byte-identical normalised display
name via the existing `normaliseForMatch` (`server/src/util/text-match.ts:18`).
Note the codebase has a second normaliser, `normaliseNameKey` (`safe-id.ts`),
used by `dedupePriorCastByName`; this design uses `normaliseForMatch`
throughout and §11 records the divergence as an open question.

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
separators.

**Everything else is surfaced, not guessed.** `"Torment"` vs `"The Torment"`,
and `unknown-male` carrying the name `"Lord Cassius"`, are reported for a human
decision. This follows #1972 directly: on that repro the *analysis* was the
damaged copy, so a matcher confident enough to auto-reconcile is also confident
enough to destroy correct data.

The existing ambiguity guard is retained: if more than one candidate on either
side shares a normalised key, no match is recorded.

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

Resolution order — four id-only lookups, first hit wins: exact id → exact
`idAliases` → `normaliseIdKey`'d id → `normaliseIdKey`'d `idAliases`. Display
names are not consulted.

**The normalised tiers return `undefined` on a tie.** If two cast rows share a
`normaliseIdKey`, or an alias duplicates another row's id, silently picking one
would render every line of one character in another's voice — strictly worse
than today's narrator substitution, which at least stamps
`renderedFallbackCharacterId` and shows in #2023's banner. No such collision
exists in the corpus today (verified: zero across all 20 books), but §4.5
leaves underscore ids in place and `cast-create.ts`'s collision suffix is
`_<hex>`, so `foo_ab12ef` and `foo-ab12ef` are reachable. A tie falls through
to the orphan path.

**Seven sites convert, not six.** The criterion is *provenance of the id*: an
id that came from manuscript attribution or a frozen render resolves through
aliases; an id supplied by an API caller does not.

| Site | Today | Note |
|---|---|---|
| `synthesise-chapter.ts:1519` `inChapterCharacterIds` | raw `groups.map(g => g.characterId)` | **Safety gate — see below** |
| `synthesise-chapter.ts:1526` `rendersNarrator` | `!castById.has(id)` | resolver miss |
| `synthesise-chapter.ts:2005` `chapterHasQwenGroups` | `castById.get(id)` | resolver |
| `synthesise-chapter.ts:2256` `resolveGroup` | `castById.get(id)` → narrator | resolver → narrator only on a true miss |
| `revisions.ts:155` drift detector | `continue` on miss | resolver, then `continue` |
| `audio/render-integrity/aggregate.ts:510` audition centroid | `undefined` hint | **writes** — see below |
| `routes/chapter-qa-repair.ts:408` | falls back to `{}` | **writes** — see below |

`:1519` is the one the first draft missed, and missing it would have shipped a
regression. The cloned-voice pre-pass validates exactly
`inChapterCharacterIds`, built from **raw** group ids, and adds the narrator
only when `rendersNarrator` is true. Convert `:1526` alone and a
now-resolvable orphan makes `rendersNarrator` go *false*, so the narrator is no
longer added — and the resolved character is not either, because its cast id is
not among the raw group ids. `the_torment` is `voiceState: tuned`. That is a
designed voice rendering with zero clone-readiness validation, exactly the hole
the `IMPORTANT-1` comment at `:1520-1526` exists to close. `:1519` must resolve
each group id through the resolver and add the *resolved* character's id.

**Two of the seven write, and that is intended but must be stated.**
`aggregate.ts` feeds `writeCentroids`, so resolving through an alias changes
which centroid bucket a render is scored against — a persisted QA decision.
`chapter-qa-repair.ts` feeds `buildSynthReplacements` (`:449`) and
`synthesiseChapter` (`:513`), so a previously narrator-substituted segment will
now be re-recorded in the resolved character's voice and the segments file
rewritten. Both are the correct outcome — the whole point is that these lines
belong to a real cast member — but they are behaviour changes on write paths
and belong in §7, not in a table of "read sites".

The request-driven CRUD routes (`cast-aliases`, `cast-design`, `cast-merge`,
`cast-series-patch`, `qwen-voice`, `single-design`, `voice-library`,
`voice-override-linked`, `voice-style`) are **not** converted: their id comes
from an API caller and they correctly 404. Resolving an alias there would let a
stale client mutate a character it did not name.

`resolveGroup`'s orphan path — the `console.warn`,
`renderedFallbackCharacterId` stamp, and the `UnresolvableClonedVoiceError`
gate added by #2023 — is unchanged, and still fires on a true miss.

### 4.4 Stopping the generation of new drift

**This is a new mechanism.** The first draft claimed it could ride the existing
rewrite plumbing; that was wrong. `mergeAnalysisResultWithExistingCast` runs at
`analysis.ts:4775`, but the rewrite table is composed and consumed at
`:4766-4767`, `manuscript-edits.json` is written at `:4729` and the analysis
cache at `:4360`. A rewrite emitted by the merge cannot enter a table consumed
before it, and both downstream targets are already on disk.

The remap must instead run as a **third rewrite producer**, early:

1. **Insertion point, main path: after `analysis.ts:4636`, before `:4643`.**
   At `:4633-4636` `characters` is the final fresh roster (post-dedup,
   post-fold, post-palette, post-`applyNarratorIdentity`) and `folded.sentences`
   already carries ids in that same space. At `:4643` `phase1ValidIds` is
   derived from it. Nothing has been persisted yet.
2. **Insertion point, subset path: after `:5770`, before `:5804`**, the same
   shape. Whether it runs before or after the reuse-link block at `:5776-5796`
   is an open question (§11).
3. **The remap rewrites the roster and the sentences together.** If only the
   roster moved, `reconcileSentenceCharacterIds` (`:1118-1140`) would find
   every renamed character's lines invalid and demote them to narrator, and
   `attributionDriftExceeded` (`:1205-1213`) could then refuse to write
   `cast.json` at all with a spurious `attribution_drift`. Because the remap
   precedes `:4643`, `phase1ValidIds` is correct for free — no recompute.
4. **`pruneSuggestionsToRoster` needs a pre-remap snapshot.** At `:4753` (and
   `:5907`) it filters `dd.suggestions`, whose `sourceId`/`targetId` are in the
   pre-remap fresh-id space, against the roster's ids. Post-remap those are
   prior ids, every suggestion fails both checks, and the merge-suggestion list
   silently empties.
5. **The interim cast writes (`:3559`, `:3764`, `:5423`) do not need it** —
   they persist raw or preview-folded rosters that the authoritative end-of-run
   write clobbers.

**The name-fallback in `mergeAnalysisResultWithExistingCast` is widened past
its `isVoicedOrReused` gate.** That gate is RC1. The ambiguity guard stays.
This is the riskiest single change in the design (§9).

**The invariant that generalises all of this:**

> Any code path that changes a character's persisted id records the old id in
> that character's `idAliases`.

Concretely that means `applyRewriteToPriorCast` (`merge-analysis-cast.ts:235`),
which today swaps a live row's id and discards the old one, appends it instead.
That single change fixes RC3's live path — the dedup collapse that would
otherwise re-orphan rendered audio on every re-analysis — at the exact point
where the old id is still in hand.

### 4.5 RC2 — `cast-create.ts` uses `safeId`

Replace the private `slugify` with `safeId` (`server/src/util/safe-id.ts`), the
canonical Unicode-preserving minter. Existing underscore ids are handled by
Tier B and by the repair pass; no forced migration.

### 4.6 Surfacing what could not be resolved

#2023's banner (`src/views/cast.tsx:939-968`) currently lists every orphaned id
in one undifferentiated block. It splits in two:

- **Auto-reconciled** — resolved through an alias or normalised key.
  Informational, collapsed by default.
- **Needs your decision** — a genuine miss. Actionable, showing the closest
  candidate by name so the user can confirm or reject rather than reading raw
  ids. **This is also the un-record path**: rejecting a reconciliation removes
  the `idAliases` entry, so a wrong auto-match made by §4.4's widened fallback
  is reversible rather than a one-way door.

`collectOrphanedCharacterFallbacks` (`server/src/audio/segments-io.ts:292-314`)
already carries the per-segment data; it gains the resolution outcome so the
frontend can split the list without a second pass.

### 4.7 The repair pass

`scripts/repair-cast-id-drift.mjs`, following existing repair-script
conventions (`chore(scripts)` commits, `.bak.<tag>` backups, pure helpers unit
tested):

- **Dry-run by default**; `--apply` to write. Refuses `--apply` if it can reach
  a live server on the configured port — it writes `cast.json` out-of-process,
  which no in-process mutex covers (§10).
- Walks `WORKSPACE_DIR`; for each book collects every analysis-cache and
  `segments.json` `characterId` with no cast resolution.
- **The two orphan populations need different treatment, and the first draft
  conflated them.** A cache orphan carries a display *name*, so Tier A applies.
  A frozen `segments.json` carries only a `characterId` — no name — so Tier A
  cannot apply and only Tier B can match. For segment-only orphans with no Tier
  B match (Exile's `unknown-male`, KOTLC's `alden`), the repair reconstructs a
  candidate name from `cast.json` backups where present (§1.4 shows this works:
  `cast.json.bak.r2` names them) and otherwise reports them for a human.
- Writes `cast.json.bak.id-drift-<date>` before any change.
- Emits the **re-render list**: book, chapter, orphaned id, segment count,
  approximate affected duration. Whether to spend GPU time on those re-renders
  is a separate call.

## 5. Testing

**The headline regression test must exercise §4.4, not presuppose its
outcome.** A test that starts from a cast already holding
`idAliases: ['mayrin']` tests only the resolver and would stay green if §4.4
did nothing — the placebo shape this repo has been bitten by before. So:

1. **Resolver test** — a chapter group carrying `mayrin`, against a cast
   holding `mairin` with `idAliases: ['mayrin']`, renders in Мэйрин's designed
   voice and stamps no `renderedFallbackCharacterId`. Fails before, passes
   after.
2. **Merge test, no alias pre-seeded** — run the merge with a prior cast
   holding `mairin` and a fresh roster holding `mayrin` for the same name;
   assert the written cast keeps `mairin`, that `mayrin` lands in `idAliases`,
   **and that this run's sentences were remapped to `mairin`**. This is the one
   that fails if the remap is inert.

| Layer | Coverage |
|---|---|
| unit | `normaliseIdKey`: separator collapse, case, trim, non-Latin preserved, never equates ids whose letters differ |
| unit | `buildCastResolver`: each of the four tiers hits; a true miss returns `undefined`; **a tie returns `undefined`** |
| server | an **unvoiced** drifted character keeps its prior id (locks RC1) |
| server | the ambiguity guard still refuses to match when two candidates share a name key |
| server | `applyRewriteToPriorCast` appends the old id to `idAliases` (locks RC3's live path) |
| server | `pruneSuggestionsToRoster` still returns a non-empty list after a remap (locks §4.4 step 4) |
| server | a client cast `PUT` omitting `idAliases` does not erase it (locks §4.1) |
| server | `:1519` — a resolvable orphan still puts the resolved character into the clone pre-pass |
| server | `cast-create` mints hyphen ids and preserves a Cyrillic name (RC2) |
| server | `resolveGroup` still records the #2023 orphan stamp on a genuine miss |
| scripts | repair-script pure helpers (candidate selection, re-render list shape) |
| e2e | cast view renders both banner states, and rejecting a reconciliation removes the alias |

The golden-audio tier is not involved — no audio-assembly behaviour changes.

## 6. Waves

| Wave | Ships | Standalone effect |
|---|---|---|
| 1 | `normaliseIdKey`, `buildCastResolver` (incl. tie handling), all seven sites, `idAliases` on the schema + preserved-on-write | Recovers **68 of 188** orphaned segments (36%) via Tier B alone, with no alias recorded — and closes the `:1519` gate it would otherwise open |
| 2 | §4.4's early remap pass, the `applyRewriteToPriorCast` invariant, RC2 | Stops new drift being generated, on both the model path and the dedup path |
| 3 | repair pass, banner split + un-record path, re-render list | Cleans up the existing books |

Measured, not estimated: Tier B resolves 2 of the 11 distinct orphaned ids, but
those two account for 68 of the 188 orphaned segments. By id count wave 1 looks
marginal; by wrong-voice audio it is the largest single recovery. _Заказ
Коалфолла_ gets nothing from wave 1 — its drift is letter-level and needs
wave 2 or 3.

## 7. Behaviour changes the user will notice

- **Wave 1 changes rendering for books that currently look fine.** Any book
  where an underscore and a hyphen id coexist starts resolving lines that
  previously went to the narrator. `the_torment` is `voiceState: tuned` — it
  will begin speaking in the voice tuned for it.
- **QA repair will re-record previously-orphaned segments** (§4.3), rewriting
  those chapters' segments files. Correct, but it means a QA repair run after
  wave 1 does more work than the same run did before.
- **Audition centroids re-bucket** (§4.3), changing which pool a render is
  scored against.
- **Existing renders are not retroactively corrected.** Wave 1 fixes
  resolution; audio already on disk stays wrong until re-rendered. Wave 3
  enumerates what that would cost.

## 8. Docs to update

- `docs/features/` — the implementation plan for this spec.
- `CLAUDE.md` "Conventions worth preserving" — the §4.4 invariant, so a future
  change does not reintroduce fresh-roster-wins or a silent id rename.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md`, per-PR.
- `docs/testing/onbox-acceptance-register.md` — a row for the wave-3 repair run
  against the real workspace, which cannot be proven in CI.

## 9. Risks

**Widening the name-fallback past `isVoicedOrReused` (§4.4).** It is necessary
— it is RC1 — and the ambiguity guard still applies, but it changes merge
behaviour for every unvoiced character on every re-analysis. Two specific
hazards:

- *Over-firing.* Widening puts every dropped prior row into the candidate set,
  so a prior cast holding an unvoiced `Alden` **and** a voiced `Alden` becomes
  ambiguous where today the voiced one matches cleanly — stranding the designed
  voice as a 0-line duplicate. `dedupePriorCastByName` mitigates but does not
  close this, and it keys on a *different* normaliser (§4.2, §11).
- *Durability.* A wrong match now writes a persisted `idAliases` entry rather
  than only mis-carrying voice fields. §4.6's un-record path is the mitigation
  and is not optional.

**Tier B could mask a real collision.** Mitigated by the tie rule (§4.3).

**The repair pass writes real user data.** Dry-run default, per-book backups,
server-reachability refusal, and unresolved cases left for a human.

## 10. Sequencing against the cast.json write lock

`docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` is in flight
on `feat/server-1981-cast-lock` (worktree `C:\Claude\Projects\wt-1981-cast-lock`,
8 commits, 29 files), which has added `server/src/workspace/cast-lock.ts`
exporting `withCastLock`/`withCastLocks`/`withLibraryVoiceLock`.

Its changed set is route modules plus the lock module. It does **not** touch
`analysis.ts`, `merge-analysis-cast.ts`, `synthesise-chapter.ts`,
`roster-dedup.ts` or `schemas.ts`. **The only overlap is `cast-create.ts`**,
which §4.5 changes by one line. Merge order does not matter; whichever lands
second resolves a trivial conflict.

The repair pass (§4.7) writes `cast.json` out-of-process, which no in-process
mutex covers whether or not the lock has landed — hence its refusal to
`--apply` against a live server.

## 11. Open questions

1. **Two normalisers.** `normaliseForMatch` (`text-match.ts:18`) and
   `normaliseNameKey` (`safe-id.ts`) are both used on this path for the same
   purpose, and `dedupePriorCastByName` uses the latter while §4.2's matcher
   uses the former. A pair that one normaliser separates and the other collapses
   behaves inconsistently. Decide which is canonical here before implementing
   §4.4.
2. **Subset-path ordering.** Whether §4.4's remap runs before or after the
   reuse-link block at `analysis.ts:5776-5796`. Running it before would let
   `seedReuseGuardsFromPriorCast`'s by-id lookup line up naturally; running it
   after preserves that block's current behaviour exactly.
3. **Stacking with the existing rewrite table.** After §4.4's remap, the
   roster's ids already equal the prior cast's for every matched character
   *before* `composeRewrites`/`applyRewriteToPriorCast` run. Those calls still
   serve their original within-run purpose, but whether the new remap must also
   update `dd`/`folded`'s rewrite keys to keep `cumulative` meaningful is
   unresolved.

## 12. Review findings that were themselves wrong

Recorded so they are not re-litigated. Both come from the adversarial pass.

- **"67 segments is an analysis-cache reference count; segments-only is 125."**
  False. The cache reference count for `the-torment` is **0**; the current
  segments files hold **67**, and 67 + 6 + 1 = 74, matching #2040's own table
  for _Playing with Fire_. The 125 figure double-counts the superseded
  `.previous.segments.json` render.
- **"On the subset re-analysis path the fresh roster is only the re-run
  chapters' roster."** False. `rebuildRoster` (`analysis.ts:3138`, `:5301`)
  iterates **all** `chapterHints` from the accumulated `chapterCast`, so the
  subset path's roster is whole-book, exactly like the main path. The
  escalation built on this — that the ambiguity guard degenerates on the subset
  path — does not follow.

The first draft's own corpus figure ("15 of 20 books") was also wrong; the
measured value is 18 of 20 with drift somewhere, 5 with wrong-voice audio.
