# Cast-authoritative character identity — design

**Status:** draft
**Closes:** #2040
**Upstream of:** #2023 (which recorded and surfaced the symptom, deliberately
leaving this root cause alone — see that issue's "Piece 3 — FILE ONLY" note)
**Related prior art:** #1972 (segments.json vs analysis-cache divergence on the
re-record path), plan 122 (the 2026-05-27 one-off id repair whose residue is
§1.4), the cast.json write-lock design (§10)

**Review:** three adversarial passes (Premium tier).

*Round 1* broke three load-bearing claims of the first draft — the
rewrite-emission mechanism was inert, the RC3 diagnosis was a no-op, and the
read-site conversion opened a clone-validation hole.

*Round 2* found the round-1 fix had reproduced the same defect one level down:
the design wrote aliases into a field that `mergeAnalysisResultWithExistingCast`
erases on every re-analysis. It also found the collision path drops the very
case §4.4 claimed to fix, an eighth join site whose omission would have made
wave 2 a regression, and that an alias can be silently shadowed by a re-minted
live id.

*Round 3* found three MORE sites that destroy the same field — including one in
the very function next door to the one round 2 hardened. Five sites across three
rounds, each found only because someone named it. That is what forced the
design's current shape: **the id history moved off the `Character` record
entirely** (§4.1). The question that provoked it is worth keeping: *is the
invariant enforced by enumeration or by construction?* It was enumeration, over
an open set, and it was wrong three times running.

All findings are folded in below. Corpus figures were independently
re-measured and reproduced exactly in all three rounds. One round-1 finding was
wrong and is recorded in §12; a rebuttal this spec made to a second one was
itself wrong, and §12 now says so.

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

### 4.1 The id history is a side-table, not a field on `Character`

**This is the design's second shape, and the reason for the change matters more
than the shape itself.** The first shape put an `idAliases: string[]` field on
`Character`. Three adversarial rounds then found five separate places that
destroy it, each discovered only because someone named it:

| # | Site | How it destroys the field |
|---|---|---|
| 1 | `mergeAnalysisResultWithExistingCast:163-194` | rebuilds every row as `{ ...f }` from the fresh roster, overlaying a 9-field allow-list |
| 2 | `applyRewriteToPriorCast:224-275` | collision path keeps one row, discards the loser entirely |
| 3 | `dedupePriorCastByName:405-425` | same shape — unions display-name `aliases`, pushes the loser's **id** to a log array, `continue`s |
| 4 | `preserveDesignedVoicesOnCastWrite:44` | client `PUT` writes the roster verbatim except three fields plus `voiceUuid` |
| 5 | `book-state.ts:917-925` | reparse carryover rebuilds each row from `{id, name}` + `aliases` + `PRESERVED_VOICE_FIELDS`, then `rm`s `cast.json` nine lines later |

Every one is the same class: **a record rebuilt from an explicit field list
silently drops a field nobody remembered to add.** Patching them one at a time
is enumeration over an open set — it converged three times and was wrong three
times, and nothing about the fourth patch would have made a sixth site
impossible rather than merely un-found.

So the id history **stops being a field on a record that gets rebuilt**:

```
.audiobook/cast-id-history.json
{
  "schema": 1,
  "supersededBy": {
    "mayrin":       "mairin",
    "unknown-male": "timkin",
    "the-torment":  "the_torment"
  }
}
```

A flat map from a **superseded id** to the **cast id that now owns it**.

**What this actually buys, stated precisely.** It does not make forgetting
impossible — a future code path that retires an id can still fail to record it.
What it changes is the *failure mode*. Under the field design, an unrelated
rebuild silently deleted history that was already working: a regression, in a
place with no connection to this feature. Under the side-table, the worst a
missed call site can do is fail to add a new entry — the id stays orphaned
exactly as it is today, which is visible in the §4.6 banner and fixable
additively. **Nothing can take working resolution away.** That is the property
three rounds of patching could not buy.

Consequences that fall out of it:

- `characterSchema`, `openapi.yaml` and `api-types.ts` are **untouched** by this
  design. No new `Character` field, so no allow-list anywhere needs updating,
  and site 4's client `PUT` and site 1's merge become non-issues by
  construction rather than by patch.
- The file survives `rm cast.json` — so site 5, the reparse that destroys the
  cast and keeps `manuscript-edits.json`, keeps the history that reconciles the
  edits it preserved. It must be explicitly excluded from reparse and
  "Start fresh" cleanup; that exclusion is the one thing worth a guard test.
- Losing the file degrades to today's behaviour. It is a lookup side-table and
  is **never authoritative for identity** — `cast.json` remains that. It cannot
  corrupt a cast; at worst it stops helping.

**One writer.** Every retirement goes through a single choke point:

```ts
// server/src/store/cast-id-history.ts
/** Record that `from` is no longer a live cast id and `to` now owns its lines.
    Also repoints any existing entry that pointed at `from`, so resolution stays
    a single O(1) lookup instead of a transitive chase. Idempotent; a no-op when
    from === to. */
export async function retireCharacterId(
  bookDir: string, from: string, to: string,
): Promise<void>;
```

Its callers are the five id-retiring paths — sites 1, 2, 3 above, plus
§4.4's remap and `cast-merge`'s `performCastMerge`
(`cast-merge.ts:142-146`, which drops the source row outright and today orphans
every segment that row rendered).

### 4.2 The matcher: exact and encoding-equivalent only

Two mechanisms are easy to conflate; they are separate and this section
governs only the first.

- **The matcher** (this section) runs at **merge/repair time**, over *display
  names and ids*, and decides whether a fresh row is the same person as an
  existing cast row — i.e. whether a history entry is recorded at all.
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
/** `history` is the `supersededBy` map from cast-id-history.json (§4.1).
    Callers that cannot cheaply load it may pass `{}` — resolution then falls
    back to the two id-only tiers, which is what recovers the wave-1
    population. */
export function buildCastResolver(
  cast: readonly CastRecord[],
  history: Readonly<Record<string, string>> = {},
): {
  resolve(characterId: string): CastResolution | undefined;
};
```

Resolution order — four id-only lookups, first hit wins: exact id → `history`
hit whose target is a live cast id → `normaliseIdKey`'d id → `normaliseIdKey`'d
`history` key. Display names are never consulted.

**A history entry never beats a live id.** Tier 1 is exact-id, so when a
retired id is later re-minted as a real character — `foldMinorCast` remints
`unknown-male` routinely, and Exile's cache still carries it for five chapters
— the live row wins. That is correct, but it silently reroutes the 55 segments
that history was covering, so §4.4 requires the stale entry to be **dropped and
reported** at the moment the id is reclaimed, rather than left to lose quietly.

**The normalised tiers return `undefined` on a tie.** If two cast rows share a
`normaliseIdKey`, or a history key duplicates another row's id, silently picking one
would render every line of one character in another's voice — strictly worse
than today's narrator substitution, which at least stamps
`renderedFallbackCharacterId` and shows in #2023's banner. No such collision
exists in the corpus today (verified: zero across all 20 books), but §4.5
leaves underscore ids in place and `cast-create.ts`'s collision suffix is
`_<hex>`, so `foo_ab12ef` and `foo-ab12ef` are reachable. A tie falls through
to the orphan path.

**Eight sites convert.** The criterion is *provenance of the id*: an id that
came from manuscript attribution or a frozen render resolves through aliases;
an id supplied by an API caller does not. The first draft said six and the
second said seven; both undercounts came from enumerating by file rather than
by join.

| Site | Today | Note |
|---|---|---|
| `synthesise-chapter.ts:1519` `inChapterCharacterIds` | raw `groups.map(g => g.characterId)` | **Safety gate — see below** |
| `synthesise-chapter.ts:1526` `rendersNarrator` | `!castById.has(id)` | resolver miss |
| `synthesise-chapter.ts:2005` `chapterHasQwenGroups` | `castById.get(id)` | resolver |
| `synthesise-chapter.ts:2256` `resolveGroup` | `castById.get(id)` → narrator | resolver → narrator only on a true miss |
| `revisions.ts:155` drift detector | `continue` on miss | resolver, then `continue` |
| `audio/render-integrity/aggregate.ts:510` audition centroid | `undefined` hint | **writes** — see below |
| `routes/chapter-qa-repair.ts:408` | falls back to `{}` | **writes** — see below |
| `audio/build-synth-replacement.ts:200` `findDivergentSentences` | raw `current.characterId !== seg.characterId` | **blocks repair — see below** |

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

**`findDivergentSentences` is the eighth site, and without it wave 2 is a
regression.** It compares the current sentence store against the frozen segment
by raw string (`build-synth-replacement.ts:200`) — the exact cross-provenance
join this section exists for. Its hits are dropped into `stillSuspect` by
`chapter-qa-repair.ts:442-447`, and `chapter-splice.ts:355` **refuses the whole
splice** on any hit.

Today the corpus is safe here because the cache and the frozen segments
*agree* — measured: _Playing with Fire_ holds `the-torment` ×67 in both, and
1/1 and 6/6 for the other two ids. Only `cast.json` differs. But §4.4's remap
rewrites `reconciled.sentences` into `manuscript-edits.json` at
`analysis.ts:4729`, moving the sentence store into prior-id space while the
frozen segments stay in analyzer space. `findDivergentSentences` would then
read every one of those segments as "the user reassigned this line", QA repair
would skip them, and splice would refuse outright — locking the 188 segments
out of the two repair paths wave 1 exists to enable, and directly contradicting
§7's claim that QA repair re-records them. It must join through the resolver.

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

> Any code path that retires a character id calls
> `retireCharacterId(bookDir, from, to)` (§4.1). Nothing else needs to know the
> id history exists.

Because the history is not a field on `Character`, the five destroy-sites
tabulated in §4.1 stop being changes this design has to make. Sites 1, 4 and 5
(the merge's allow-list, the client `PUT` preserve set, the reparse carryover
whitelist) become non-issues outright — they rebuild `Character` records, and
the history no longer lives there. Sites 2 and 3 turn from *"must remember to
preserve a field"* into *"must call the choke point"*, and a missed call leaves
an id orphaned exactly as it is today rather than deleting resolution that was
already working.

The call sites are:

1. **`applyRewriteToPriorCast` (`merge-analysis-cast.ts:224-275`)** — both the
   plain rename (`:235`) and the collision path, which today keeps one row and
   discards the loser at `:274`.
2. **`dedupePriorCastByName` (`:405-425`)** — the fourth collapse, found in
   round 3. It unions the loser's display-name `aliases`, pushes the loser's
   **id** into a `dropped` log array, and `continue`s past the row. It runs
   *before* `applyRewriteToPriorCast` (`analysis.ts:2822`/`:5224` vs
   `:4767`/`:5920`), so it is the first chance to lose an id, not the last.
3. **`mergeAnalysisResultWithExistingCast`'s name-fallback branch** — when it
   matches `old` under a different id, that id is retired.
4. **§4.4's remap** — every entry in its `rewrites` map is a retirement.
5. **`performCastMerge` (`cast-merge.ts:142-146`)** — a user merging two
   characters drops the source row outright and rewrites
   `manuscript-edits.json` and the cache into target-id space, but never
   touches `segments.json`. Every segment that row already rendered is orphaned
   the instant the merge lands. §4.3 correctly excludes this route from the
   *resolver* (its id comes from an API caller), but that exclusion never
   applied to the write side — it retires an id and so it records one.

**A retired id must yield when it is re-minted, loudly.** Resolution is
exact-id-first (§4.3), so a returning real `unknown-male` row correctly beats
Timkin's history entry — but Timkin's 21 frozen segments then reroute to the
generic background bucket with no tie, no warning and no orphan stamp.
`foldMinorCast` remints that bucket routinely (`fold-minor-cast.ts:294-303`)
and Exile's cache still carries `unknown-male` for chapters 7/11/24/33/34,
which `rebuildRoster` folds into every roster build. **55 of the 188 segments
are exposed.** The rule: when a fresh roster introduces a live row whose id is a
key in the history, that entry is **dropped** and its segments are reported as
*needs your decision* (§4.6) rather than silently rerouted.

### 4.5 RC2 — `cast-create.ts` uses `safeId`

Replace the private `slugify` with `safeId` (`server/src/util/safe-id.ts`), the
canonical Unicode-preserving minter. Existing underscore ids are handled by
Tier B and by the repair pass; no forced migration.

### 4.6 Surfacing what could not be resolved

**The existing banner shows nothing today, and that must be fixed first.**
`collectOrphanedCharacterFallbacks` (`server/src/audio/segments-io.ts:299-301`)
skips any segment lacking `renderedFallbackCharacterId`, the stamp #2023
introduced. Measured across all 20 books: **188 orphaned segments, 0 carrying
the stamp** — every affected render predates #2023. So #2023's banner
(`src/views/cast.tsx:939-968`) is empty on all five affected books, and any
design that hangs new UI off that collector inherits an empty list.

Worse for the split below: an id that *resolves* through an alias never takes
`resolveGroup`'s orphan branch, so it never gets the stamp either — the
"auto-reconciled" list would be empty **by construction**. The collector's
`!s.renderedFallbackCharacterId` gate must therefore be widened to report any
segment whose `characterId` is not an exact live cast id, tagged with how it
resolved, rather than only those carrying the stamp.

With that fixed, the banner splits in two:

- **Auto-reconciled** — resolved through an alias or normalised key.
  Informational, collapsed by default.
- **Needs your decision** — a genuine miss, or an alias displaced by a
  re-minted live id (§4.4). Actionable, showing the closest candidate by name
  so the user can confirm or reject rather than reading raw ids.

**The un-record path must be durable.** Rejecting a reconciliation removes the
history entry — but §4.4's fallback matches on the *name*, which the
rejection does not change, so the next re-analysis would simply re-record it.
The repo already has the right primitive: `notLinkedTo`, honoured by
`dedupePriorCastByName` (`merge-analysis-cast.ts:391`, `groupHasNotLinkedEdge`)
and by `seedReuseGuardsFromPriorCast`. A rejection writes a `notLinkedTo` edge
between the two characters, and §4.4's matcher honours it. Without this the
un-record is a one-way door in the opposite direction from the one §9 fears.

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
  cannot apply and only Tier B can match.
- **A frozen segment is not nameless, though.** `characterSnapshots` in the
  segments file carries `tone`, `gender`, `ageRange`, `voiceEngine` and
  `attributes` for the orphaned id (verified on Exile's
  `07-chapter-five-five.segments.json`). No name, but a far stronger matching
  signal than "id only", and the repair should use it to rank candidates.
  Where a `cast.json.bak.*` names the id outright (§1.4:
  `cast.json.bak.r2` gives `unknown-male` = "Timkin"), that is stronger still.

**The whole rendered-orphan population, enumerated** — the spec previously gave
only a total, which hid a gap:

| book | id | segments | attributed to |
|---|---|---|---|
| Playing with Fire | `the-torment` | 67 | RC2 (Tier B recovers) |
| Playing with Fire | `pool-player-2` | 6 | RC2 variant — `-2` suffix defeats Tier B |
| Playing with Fire | `lightning-dave` | 1 | RC2 (Tier B recovers) |
| Заказ Коалфолла | `coalfall` | 13 | RC1 + §1.3 restore |
| Заказ Коалфолла | `mayrin` | 8 | RC1 + §1.3 restore |
| Exile | `unknown-male` | 21 | §1.4 |
| Exile | `unknown-female` | 14 | §1.4 |
| Unlocked | `unknown-male` | 34 | §1.4 |
| Exile | `silveny` | 17 | **unattributed** |
| Everblaze | `lady-alina` | 6 | **unattributed** |
| Exile | `sir-harding` | 1 | **unattributed** |

**24 of the 188 segments have no attributed mechanism.** They are consistent
with RC1 or with another incomplete repair, but that has not been traced. The
repair pass handles them the same way as any other unresolved orphan — reported
for a human — so this gap does not block wave 3, but it does mean §1.2 is not
yet a complete account and should not be read as one.

The pass also:

- **Writes `cast-id-history.json`, not `cast.json`.** This is a consequence of
  §4.1 worth stating plainly: the repair adds history entries and does not touch
  the cast at all, so it cannot strip a voice, reorder a roster, or corrupt an
  identity. It still takes a `cast.json.bak.id-drift-<date>` backup before any
  run that would touch the cast for an unrelated reason, and it still refuses
  `--apply` against a live server.
- Emits the **re-render list**: book, chapter, orphaned id, segment count,
  approximate affected duration. Whether to spend GPU time on those re-renders
  is a separate call.

## 5. Testing

**The headline regression test must exercise §4.4, not presuppose its
outcome.** A test that starts from a history already containing
`mayrin → mairin` tests only the resolver and would stay green if §4.4 did
nothing — the placebo shape this repo has been bitten by before. So:

1. **Resolver test** — a chapter group carrying `mayrin`, against a cast
   holding `mairin` and a history containing `mayrin → mairin`, renders in
   Мэйрин's designed voice and stamps no `renderedFallbackCharacterId`. Fails
   before, passes after.
2. **Merge test, nothing pre-seeded** — start with an EMPTY history, run the
   analysis with a prior cast holding `mairin` and a fresh roster holding
   `mayrin` for the same name; assert the written cast keeps `mairin`, that the
   history now contains `mayrin → mairin`, **and that this run's sentences were
   remapped to `mairin`**. This is the one that fails if the remap is inert.

| Layer | Coverage |
|---|---|
| unit | `normaliseIdKey`: separator collapse, case, trim, non-Latin preserved, never equates ids whose letters differ |
| unit | `buildCastResolver`: each of the four tiers hits; a true miss returns `undefined`; **a tie returns `undefined`** |
| server | an **unvoiced** drifted character keeps its prior id (locks RC1) |
| server | the ambiguity guard still refuses to match when two candidates share a name key |
| server | `retireCharacterId` is idempotent, no-ops when `from === to`, and **repoints** an existing entry whose target was `from` |
| server | each of the five call sites records a retirement — `applyRewriteToPriorCast` rename, its collision loser, `dedupePriorCastByName`'s loser, the merge's name-fallback, `performCastMerge`'s source |
| server | **the survival guard**: a reparse (`applyReparse`, which `rm`s `cast.json`) and a client cast `PUT` both leave `cast-id-history.json` intact. This is the test that pins §4.1's whole rationale — under the previous field-based design both of these destroyed the data |
| server | `findDivergentSentences` does not report divergence when the sentence store and the frozen segment differ only by a retired id (locks the eighth site; without it wave 2 blocks QA repair) |
| server | a fresh roster re-minting a live `unknown-male` row drops that history entry and reports the affected segments rather than rerouting them |
| server | a rejected reconciliation writes a `notLinkedTo` edge, and a subsequent re-analysis does not re-record the retirement |
| server | `pruneSuggestionsToRoster` still returns a non-empty list after a remap (locks §4.4 step 4) |
| server | `:1519` — a resolvable orphan still puts the resolved character into the clone pre-pass |
| server | `cast-create` mints hyphen ids and preserves a Cyrillic name (RC2) |
| server | `resolveGroup` still records the #2023 orphan stamp on a genuine miss |
| scripts | repair-script pure helpers (candidate selection, re-render list shape) |
| e2e | cast view renders both banner states, and rejecting a reconciliation removes the alias |

The golden-audio tier is not involved — no audio-assembly behaviour changes.

## 6. Waves

| Wave | Ships | Standalone effect |
|---|---|---|
| 1 | `normaliseIdKey`, `buildCastResolver` (incl. tie handling), all eight sites | Recovers **68 of 188** orphaned segments (36%) via the normalised tier alone, with an EMPTY history and no schema change at all — and closes the `:1519` gate it would otherwise open |
| 2 | §4.4's early remap pass, all three parts of the id invariant, the eighth site, RC2 | Stops new **cast.json** drift on both the model and dedup paths, and keeps the alias set alive across re-analysis |
| 3 | repair pass, banner split + un-record path, re-render list | Cleans up the existing books |

Measured, not estimated: Tier B resolves 2 of the 11 distinct orphaned ids, but
those two account for 68 of the 188 orphaned segments. By id count wave 1 looks
marginal; by wrong-voice audio it is the largest single recovery. _Заказ
Коалфолла_ gets nothing from wave 1 — its drift is letter-level and needs
wave 2 or 3.

**Wave 2 does not stop analysis-cache drift, and the wave table should not be
read as claiming it does.** Every `saveAnalysisCache` on the main path is at or
before `analysis.ts:4360`, and on the subset path at or before `:5648` — both
ahead of §4.4's insertion points. The cache therefore keeps its pre-remap ids,
and `rebuildCacheFromEdits` (`analysis-cache-rebuild.ts:53`) heals only
`chapters`, spreading `...prior`, so `chapterCast` stays in the drifted space
indefinitely and re-seeds the analyzer prompt's "reuse their `id` verbatim"
roster from stale ids on the next run. Cache drift is the larger population —
**89 distinct cache-orphan ids across 18 books**, against 11 segment ids across
5 — and this design *masks* it with aliases rather than stopping it. Moving the
cache write after the remap is possible but was not designed here; it is
recorded as §11 Q3.

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
- *Durability.* A wrong match now writes a persisted history entry rather
  than only mis-carrying voice fields. §4.6's un-record path is the mitigation
  and is not optional.

**Tier B could mask a real collision.** Mitigated by the tie rule (§4.3).

**Wave 1 may poison persisted audition centroids.** `aggregate.ts:510` feeds
`writeCentroids`. Post-wave-1 the 67 `the-torment` segments — which were
*rendered in the narrator's voice* — start bucketing under `the_torment`, so
known-bad audio enters a persisted QA reference. Whether the aggregation
actually degrades the centroid was not traced, so this is unconfirmed; the
plan should either verify it or exclude alias-resolved segments from centroid
aggregation until a re-render replaces them.

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
   purpose — `dedupePriorCastByName` uses the latter, `merge-analysis-cast`'s
   fallback and `seedReuseGuardsFromPriorCast` use the former. They differ
   materially: `normaliseNameKey` strips all non-alphanumerics ("Mr. Forkle" →
   `mrforkle`), `normaliseForMatch` keeps them (`mr. forkle`). A pair one
   separates and the other collapses behaves inconsistently. **This divergence
   is inherited, not introduced by this design** — but §4.4's widened fallback
   makes it matter more, so pick a canonical one before implementing.
2. **Ordering of §4.4's remap against `composeRewrites`.** More determinate
   than "unresolved", and the plan must specify it: `composeRewrites(dd.rewrites,
   folded.rewrites)` is keyed in **fresh**-id space. Once the roster is remapped
   into prior-id space, applying that table to the prior cast can rename a prior
   row back *out* of the space the remap just put it in — e.g. prior `mairin` →
   `mayrin` when this run's dedup collapsed `mairin`→`mayrin`. The remap must
   either compose into that table or run strictly after it is applied.
3. **Whether to move the analysis-cache write after the remap.** Today it
   precedes both insertion points (§6), so cache drift is masked rather than
   stopped, and `chapterCast` re-seeds the analyzer prompt from stale ids
   forever. Moving `saveAnalysisCache` after the remap would fix it but was not
   designed here; the per-chapter cache writes inside the `runChapter` loop are
   what make it non-trivial.

*(The subset-path ordering question from the previous draft is resolved: the
main path already runs `seedReuseGuardsFromPriorCast` and
`linkSeriesReuseAtAnalysis` at `analysis.ts:3702`/`:3710`, well before the
`:4636` insertion point, so putting the subset remap after the `:5776-5796`
block keeps the two paths symmetric. `seedReuseGuardsFromPriorCast` also
carries its own ambiguity-guarded name fallback at
`merge-analysis-cast.ts:289-318`, so the benefit of running it earlier was
already covered.)*

## 12. Review findings that were themselves wrong

Recorded so they are not re-litigated. Both come from the adversarial pass.

- **"segments-only is 125."** False, and only this half. The current segments
  files hold **67** `the-torment` entries; `.previous.segments.json` holds a
  further 58, and 67 + 58 = 125 — so the 125 figure double-counts a superseded
  render. 67 + 6 + 1 = 74 matches #2040's own table for _Playing with Fire_.
  The same review's other half — that 67 is *also* the analysis-cache
  reference count — is **correct**, and a first attempt to rebut it here was
  based on a faulty measurement. The cache holds exactly 67 `the-torment`
  references (74 across the three ids, under `cache.chapters`). Cache and
  segments **agree**; only `cast.json` differs. That agreement is load-bearing
  for §4.3's eighth site — see it.
- **"On the subset re-analysis path the fresh roster is only the re-run
  chapters' roster."** False. `rebuildRoster` (`analysis.ts:3138`, `:5301`)
  iterates **all** `chapterHints` from the accumulated `chapterCast`, so the
  subset path's roster is whole-book, exactly like the main path. The
  escalation built on this — that the ambiguity guard degenerates on the subset
  path — does not follow.

The first draft's own corpus figure ("15 of 20 books") was also wrong; the
measured value is 18 of 20 with drift somewhere, 5 with wrong-voice audio.
