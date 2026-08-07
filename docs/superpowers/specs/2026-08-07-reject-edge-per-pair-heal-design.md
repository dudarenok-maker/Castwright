# Design decision — #2200 (reject-edge reconciliation under-heals per-`from`)

Read-only design pass. No code written, no commits.

**Verdict: FIX, but not the way the issue frames it.** The compound case is reachable in
production, so #2200 is not a phantom. But no state-based rule can both keep `[R7]`'s
current *add* expectation and heal `B` — the parent agent's impossibility claim is
correct, and idea 4 (`supersededBy` attribution) is provably refuted, not merely
unverified. The chosen rule is the parent's **option 3 — delete the relocation guard from
the add pass entirely** — and `[R7]`'s *add* assertion changes. Its *removal* assertion,
which is the half that guards against data loss, does not.

---

## 1. Is the compound case reachable in production?

Yes — by three distinct routes, two of them failure-free. Establishing this required
tracing the two *separate* name-match copies (they are not the same function), because
only one of them is accompanied by a `rejectedPairs` repoint.

### 1.1 There are TWO producers of a relocated edge, not one

Both the module doc (`reject-edge-reconcile.ts:46-48`) and the issue cite
"`merge-analysis-cast.ts` copies `old.notLinkedTo` onto a fresh row matched by name" as
*the* producer, citing `:473-480`. That citation lands inside
**`seedReuseGuardsFromPriorCast`** (`merge-analysis-cast.ts:442-484`), which is only one
of the two:

**Producer A — `seedReuseGuardsFromPriorCast`** (`merge-analysis-cast.ts:470-483`):

```ts
for (const f of fresh) {
  let old = byId.get(f.id);
  if (!old) {
    const key = nameOf(f as { name?: unknown } & Record<string, unknown>);
    if (key && !ambiguousExistingNames.has(key) && freshNameCounts.get(key) === 1) {
      old = existingByName.get(key);          // ← name match, ANY prior row
    }
  }
  if (!old) continue;
  if (f.notLinkedTo === undefined && old.notLinkedTo !== undefined)
    f.notLinkedTo = old.notLinkedTo as T['notLinkedTo'];
```

Called at `analysis.ts:4091` (main run) and `analysis.ts:6355` (subset run). It records
**no retirement** — it returns `void` and has no `Retirement` channel at all. Its
candidate pool is `existingByName`, built from **every** prior row (`:461-468`), live or
dropped.

**Producer B — `mergeCore`'s id-drift name fallback** (`merge-analysis-cast.ts:298-316`),
reached through `mergeAnalysisResultWithExistingCast` at `analysis.ts:5199`. It relocates
`notLinkedTo` too — `'notLinkedTo'` is in `PRESERVED_VOICE_FIELDS`
(`merge-analysis-cast.ts:44`), copied at `:320-322` — but it **does** record a retirement:

```ts
old = cand;
claimedByName.add(cand.id);
retirements.push({ from: cand.id, to: f.id });   // :312-314
```

and its candidate pool is restricted to *dropped* prior rows:
`if (freshIds.has(old.id) || NARRATOR_CHARACTER_IDS.includes(old.id)) continue;` (`:257`).

### 1.2 Producer B self-heals; Producer A does not

`retireCharacterId` repoints `rejectedPairs` **inside the same locked write** that records
`supersededBy` — `repointRejectedPairs(history, from, resolvedTo)` at
`cast-id-history.ts:387` (and `:360` on the reversal branch), both between the
`supersededBy` mutation and the `writeJsonAtomic` at `:390`/`:361`, all inside
`withKeyLock` (`:336`). The repoint is exactly `const to = pair.to === from ? newTarget :
pair.to;` (`cast-id-history.ts:289`).

So when Producer B relocates A's edge onto R, the retirement `A → R` reaches
`recordRetirements` (`analysis.ts:5233-5234`, which runs **before**
`reconcileRejectEdgesOnDisk` at `:5299`), and the pair `{X→A}` is rewritten to `{X→R}`.
The edge is then sitting on its own pair's `to` — **not relocated at all** by the time
reconciliation reads it. Producer B is self-consistent.

Producer A has no such coupling. Three ways its copy survives without a matching repoint:

**Route (i) — divergent candidate pools, no failure required.** Producer A matches by name
against *all* prior rows; Producer B skips any prior row whose id is still in the fresh
roster (`:257`). So: prior row `A` (name *N*) carries the edge for `X`; the fresh roster
contains a row with id `A` under a **different** name, plus a new row `R` under name *N*.
Producer A name-matches `A → R` and copies the edge onto `R`; Producer B never considers
`A` (its id is live) and records nothing. Pair `{X→A}` stays put; `R` carries a relocated
edge, permanently.

**Route (ii) — Producer B's own `notLinkedTo` block, no failure required.** `:307-311`
refuses the fallback when `notLinkedToId(cand, f.id)` holds — i.e. when the prior row's
edge names the fresh row's id. That fires exactly when the analyzer re-mints the orphaned
id `X` as a live row, which `cast-id-history.ts:38-45` documents as *"the expected case,
not an edge case"*. Producer A has no such check and has already copied the edge. Result:
relocated edge, no retirement, no repoint.

**Route (iii) — non-atomic persist.** `cast.json` is written at `analysis.ts:5200-5203`;
the retirements are recorded ~30 lines later at `:5233`, inside a `try` whose `catch`
(`:5300`) only warns. An `EPERM`/`ENOSPC` on `cast-id-history.json` leaves the relocated
edge durably on `cast.json` and the pair un-repointed forever — the retirement is
recomputed only from that run's merge and is never retried.

### 1.3 The relocated edge is durable and un-undoable

- The cast PUT cannot remove it: `preserveNotLinkedToOnCastWrite`
  (`preserve-cast-voices.ts:89-103`) is id-keyed and server-owned.
- Undo cannot remove it: the DELETE handler removes edges only from the clicked row —
  `removeNotLinked(character, bookId, pair.from)` (`cast-reject-orphan.ts:514`) and
  `removeNotLinked(character, bookId, orphanedId)` (`:548`), both against the single
  `character` the request named. A copy on another row is untouched. This is the residual
  already recorded as plan 278 invariant 10 (`docs/features/278-cast-character-identity.md:223-231`).
- The only reaper is `reconcileRejectEdges` pass 1, which fires once the *last* pair for
  that `from` is gone (`reject-edge-reconcile.ts:105`).

### 1.4 …and the missing edge is the shape `[R8b]` already accepts as real

The second ingredient — one pair's edge genuinely absent — is the half-written reject this
whole module exists for, and plan 281 already argued it is real for the two-pair case
(`docs/features/archive/281-reject-edge-atomicity.md:70-84`). Two POSTs, the second
half-failing, is all it takes.

**Conclusion: the compound state `{X→A}, {X→B}, relocated edge on R, B live without an
edge}` is reachable without postulating any failure at all (routes i and ii), and trivially
with one (route iii). #2200 is a real defect. It should not be closed as not-a-bug.**

It is, however, exactly as low-severity as the issue itself says: the failure direction is
under-heal, never over-remove.

### 1.5 Idea 4 (`supersededBy` attribution) is refuted, not merely unavailable

`supersededBy[A] = R` and an un-repointed pair `{X→A}` **cannot be written together**, by
construction: `retireCharacterId` writes the alias and repoints the pairs in one locked
write (`cast-id-history.ts:336-392`). The only way to observe both is for the pair to be
created *after* the retirement — which requires `A` to be live again, and a live `A` makes
`dropSupersededIdsReclaimedByLiveCast` (`analysis.ts:5258`, `cast-id-history.ts:469-493`)
delete `supersededBy[A]` at that same persist.

And in all three reachable routes above there is *no* `supersededBy` entry at all:
route (i) and (ii) never record a retirement, route (iii)'s write failed. So the signal is
absent precisely where it would be needed. Worse, if it were ever present it would be
self-defeating: its presence would mean the pair *should already have been repointed*, so
the correct fix would be to repoint, not to attribute. **Idea 4 is dead.**

---

## 2. The chosen rule

**Delete the relocation guard from the add pass. Add strictly per-pair.**

Exact predicate — for each `p ∈ history.rejectedPairs`:

> Write `{ bookId, characterId: p.from }` onto the live row whose `id === p.to`
> **if and only if** that row exists in `characters` **and** it carries no entry with
> `bookId === bookId && characterId === p.from`.

Nothing else participates. Relocation is not consulted.

Concretely, in `server/src/store/reject-edge-reconcile.ts`:

- delete `targetsByFrom` (`:88-94`);
- delete the `relocated` set and its comment (`:112-128`);
- delete `if (relocated.has(p.from)) continue;` (`:133`);
- pass 2 otherwise unchanged — the `existing.some(...)` dedupe at `:138` stays and becomes
  the *only* anti-duplication mechanism, which is correct: it is the one that prevents a
  duplicate on the row that would actually receive the write;
- rewrite the module doc's ADDITION paragraph (`:50-56`). The MATCHING paragraph
  (`:45-49`, why *removal* is book-scoped) is untouched and stays load-bearing.

Pass 1 (removal) is not touched at all.

### Why an add on `p.to` is always safe

The edge written is **byte-identical to what that pair's own POST wrote**
(`cast-reject-orphan.ts:663-676`, `appendNotLinked`), on that pair's own `to` row. Every
consumer of a same-book `notLinkedTo` edge treats it as the reject's intended effect:

| Consumer | Effect of the edge on `p.to` | Correct? |
|---|---|---|
| `mergeCore` name fallback (`merge-analysis-cast.ts:307-311`) | refuses to weld `p.to` onto a fresh row with id `p.from` | yes — that is the reject |
| `groupHasNotLinkedEdge` (`:507-518`) | refuses to collapse `p.to` with a row named `p.from` | yes |
| `remap-fresh-to-prior.ts` | refuses to remap fresh id `p.from` onto `p.to` | yes |
| `cast-merge.ts` | refuses to merge the two | yes |
| DELETE / Undo (`cast-reject-orphan.ts:514`) | **removes it** | yes — the add is undoable |

The last row is the decisive one: an added edge lands on the row the Undo button targets,
so it never adds to the stranded-edge residual. The *relocated* edge stays stranded either
way — that is invariant 10's pre-existing residual, unchanged and not widened.

Conversely, the under-heal has a concrete cost. `rejectedPairs` gates `buildCastResolver`;
it does **not** gate the merge's §4.4 name fallback. The `notLinkedTo` edge is the *only*
thing stopping `mergeCore` from welding `p.to` onto a fresh row minted with id `p.from` —
`reject-edge-reconcile.ts:5-7` says so directly. Leaving `p.to` edgeless leaves the user's
decision durably unenforced on that path.

---

## 3. Why it beats every alternative

| # | Alternative | Verdict |
|---|---|---|
| 1 | **Count/deficit cap** — adds ≤ live-`to` pairs − direct edges − relocated edges, deterministic tie-break | **Fails the issue's substance, not just its letter.** With two edgeless pairs and one relocated edge the deficit is 1; the tie-break picks A; `B` still never heals, and the next run sees the same state and adds nothing. The under-heal is relocated, not removed. |
| 2 | **Suppress only when pairs == direct + relocated** | Green on `[R7]`, but in the compound case adds **both** A and B → three edges for two pairs, which is the very duplication the guard exists to prevent, and it *still* fails the variant where A already holds its own direct edge (counts balance → `B` never heals). Strictly worse than option 3: same duplication, less healing. |
| 3 | **Pure per-pair, ignore relocation** — CHOSEN | Heals every reachable case; can never duplicate onto a `to` (the `:138` dedupe); adds only undoable edges; **removes ~20 lines**. Costs `[R7]`'s add assertion. |
| 4 | **Attribute via `history.supersededBy`** | Refuted in §1.5 — the signal cannot co-exist with the state it would explain. |
| 5 | *(new)* **Attribute by comparing the relocated row's `name` to `p.to`'s name** | Requires widening `CastRow` past `{id, notLinkedTo?}`, and is vacuous in the dominant case: when the id drifted, the old row is *gone*, so there is no name to compare against. Dead. |
| 6 | *(new)* **Repoint the stale pair instead of healing** (`{X→A}` → `{X→R}` when R holds A's edge) | This is a *write to `cast-id-history.json`* from a module documented as pure and I/O-free (`:13-17`), and it guesses at identity from a name-match that Producer B explicitly declined to trust in routes (ii). It would move data loss into the over-write direction. Rejected. |
| 7 | *(new)* **Close #2200 as not-a-bug** | Rejected on §1 — reachable without any failure, twice over. |

Option 3 also satisfies the plan's own stated bar verbatim
(`docs/features/archive/281-reject-edge-atomicity.md:104-108`, *"Is the new rule ever worse
than the spec's?"*): removal untouched; every add lands on a live pair's own `to`; the
`:138` dedupe makes a duplicate-on-`to` unrepresentable. The only claim in that paragraph
that this change contradicts is the *precaution* itself, and plan 281 never named a harm
for it — it named a harm only for row-scoped **removal**, which is not being changed.

---

## 4. Test matrix

`BOOK = 'book-hollow-tide'`; `history(over)` / `row(id, notLinkedTo?)` helpers as they
already exist at `reject-edge-reconcile.test.ts:12-18`. `E(id) = { bookId: BOOK, characterId: id }`.

### 4.1 `[R7]` — CHANGES. Justification below the table.

| | value |
|---|---|
| `characters` | `[row('mairin_renamed', [E('mairin_2')]), row('mairin')]` |
| `history` | `{ rejectedPairs: [{ from: 'mairin_2', to: 'mairin' }] }` |
| `removes` | `[]` — **unchanged** |
| `adds` | `[{ characterId: 'mairin', orphanedId: 'mairin_2' }]` — **was `[]`** |
| `next[0].notLinkedTo` | `[E('mairin_2')]` — **unchanged** (the relocated edge is left alone) |
| `next[1].notLinkedTo` | `[E('mairin_2')]` — **was `undefined`** |

**Why changing a shipped test is justified here.** `[R7]` asserts two independent things
under one name. The first — *the relocated edge is not deleted* (`removes === []`,
`next[0]` intact) — is the data-loss guard, tied to a named harm (row-scoped removal would
destroy a real user decision) and is **kept verbatim**. The second — *no add onto `p.to`* —
is a precaution for which plan 281 never named a harm
(`281-reject-edge-atomicity.md:96-98` states the rule as *"fail-safe: never duplicate"*
with no consequence attached), and §1 shows it is unsatisfiable jointly with #2200's
acceptance. Rename the case to `[R7] leaves a relocated edge alone and still heals p.to`
and split the comment so the surviving half's rationale is not diluted. The two other
suites that drive this code — `analysis-reject-edge-reconcile.test.ts` and
`book-state-preserve-voices.test.ts` `[P9]` — contain **no** relocation fixture (verified
by grep), so `[R7]` is the only assertion in the repo that moves.

### 4.2 `[R8]` — unchanged, must stay green

| | value |
|---|---|
| `characters` | `[row('mairin'), row('mara')]` |
| `history` | `{ rejectedPairs: [{from:'mairin_2',to:'mairin'}, {from:'mairin_2',to:'mara'}] }` |
| `adds` | `[{mairin, mairin_2}, {mara, mairin_2}]` |
| `removes` | `[]` |
| `next[0]/next[1].notLinkedTo` | `[E('mairin_2')]` each |

### 4.3 `[R8b]` — unchanged, must stay green

| | value |
|---|---|
| `characters` | `[row('mairin', [E('mairin_2')]), row('mara')]` |
| `history` | same two pairs as `[R8]` |
| `adds` | `[{mara, mairin_2}]` |
| `removes` | `[]` |
| `next[0]/next[1].notLinkedTo` | `[E('mairin_2')]` each |

### 4.4 `[R13]` — NEW. The issue's literal acceptance (both pairs edgeless)

| | value |
|---|---|
| `characters` | `[row('mairin_renamed', [E('mairin_2')]), row('mairin'), row('mara')]` |
| `history` | `{ rejectedPairs: [{from:'mairin_2',to:'mairin'}, {from:'mairin_2',to:'mara'}] }` |
| `adds` | `[{mairin, mairin_2}, {mara, mairin_2}]` |
| `removes` | `[]` |
| `next[0].notLinkedTo` | `[E('mairin_2')]` (relocated copy untouched) |
| `next[1].notLinkedTo` | `[E('mairin_2')]` |
| `next[2].notLinkedTo` | `[E('mairin_2')]` |

Note the deliberate departure from the issue's wording: `mairin` is healed too. The issue
says only *"heals B"* and is silent on A; healing A as well is required for symmetry —
nothing in the state distinguishes the two edgeless pairs, so healing one and not the other
would be an arbitrary choice (this is precisely what sinks option 1). Say this explicitly
in the issue's closing comment.

### 4.5 `[R13b]` — NEW. **The discriminating case.** Production shape from §1.2 route (i)/(ii)

| | value |
|---|---|
| `characters` | `[row('mairin_renamed', [E('mairin_2')]), row('mairin', [E('mairin_2')]), row('mara')]` |
| `history` | `{ rejectedPairs: [{from:'mairin_2',to:'mairin'}, {from:'mairin_2',to:'mara'}] }` |
| `adds` | `[{mara, mairin_2}]` — **only** |
| `removes` | `[]` |
| `next[0].notLinkedTo` | `[E('mairin_2')]` (relocated, untouched) |
| `next[1].notLinkedTo` | `[E('mairin_2')]` (already present, not duplicated) |
| `next[2].notLinkedTo` | `[E('mairin_2')]` |

This is the shape route (i) actually produces (Producer A copies A's edge onto R *and*
leaves A's own copy in place via the `byId` branch), and it is the only new case that is
red under the relocation guard **and** red under a broken `:138` dedupe, for different
reasons. It is the mutation target.

### 4.6 `[R14]` — NEW. Convergence / idempotence

Feed `[R13]`'s `next` back in with the same `history`. Expect `adds === []`,
`removes === []`, and `next` structurally equal to the input — proving the change does not
cause a write on every subsequent persist (the caller writes only when `adds`/`removes` are
non-empty, `analysis.ts:416`).

---

## 5. Mutation plan — one mechanism per assertion

Each mutation is applied alone, against the post-fix tree, and must redden the named cases
and only those.

| # | Single mechanism neutralised | Must go RED | Must stay GREEN | Proves |
|---|---|---|---|---|
| **M1** | Reinstate the deleted guard: re-add `targetsByFrom` + `relocated` + `if (relocated.has(p.from)) continue;` in pass 2 | `[R7]` (adds), `[R13]`, `[R13b]` | `[R8]`, `[R8b]`, `[R9]`, `[R14]`, `[R1]`–`[R6]`, `[R10]`–`[R12]` | the new assertions fail *because* of the relocation guard and nothing else — i.e. they are not vacuously green |
| **M2** | Delete only the `existing.some((e) => e.bookId === bookId && e.characterId === p.from) continue;` dedupe (`:138`) | `[R8b]`, `[R9]`, `[R13b]`, `[R14]` (duplicate `adds` and a doubled `notLinkedTo`) | `[R7]`, `[R8]`, `[R13]` | the *surviving* anti-duplication mechanism is still under test after the guard is gone — without this control, "we removed the duplicate protection" would be an untested claim |
| **M3** | Change pass 1's backing test from `backedFroms.has(e.characterId)` to a row-scoped `pairs.some(p => p.from === e.characterId && p.to === c.id)` | `[R7]`, `[R13]`, `[R13b]` on **`removes`** (the relocated edge is deleted) | `[R1]`–`[R6]`, `[R8]`, `[R8b]` | `[R7]`'s load-bearing half — the one being *kept* — is still doing its job after the rewrite |
| **M4** | Change `byId.get(p.to)` to `byId.get(p.from)` | `[R4]`, `[R5]`, `[R8]`, `[R13]` | — | the add still targets `p.to`, not `p.from` (guards against a sloppy rewrite of pass 2) |

M1 is the required proof for #2200's fix. M2 and M3 are the two controls that stop the fix
from being a silent removal of protection. All four are pure-function mutations on a
144-line module with no I/O — cheap to run.

---

## 6. Blast radius

**Callers.** `reconcileRejectEdges` has exactly one production caller:
`reconcileRejectEdgesOnDisk` (`analysis.ts:415`), itself called at exactly two sites —
`analysis.ts:5299` (main run) and `analysis.ts:6608` (subset run), both after the
authoritative `cast.json` write. Both are pinned by
`analysis-reject-edge-reconcile.test.ts:256-266`. Test callers:
`analysis-reject-edge-reconcile.test.ts` and `book-state-preserve-voices.test.ts:554-559`
(`[P9]`) — neither has a relocation fixture, so neither moves.

**Can it over-remove?** **No, structurally.** The diff touches pass 2 only. `removes` is
produced solely by pass 1's `filter` (`:103-108`), which is not modified; `next` is only
ever *extended* with a `notLinkedTo` entry (`:139`), never shortened. Over-removal is
unreachable by construction, not by test. This satisfies the stated constraint that
under-heal is the acceptable failure direction and over-remove is not.

**Can it over-add?** Only onto a row that is (a) live and (b) named as `to` by a real,
durable `rejectedPairs` entry, and only when that row lacks the edge. The worst case is an
edge on a live row whose id string matches a pair's `to` but whose *person* has changed
(the re-minted-id case). That is not new damage: `buildCastResolver` already blocks `X→A`
on the id string via the same pair, so the edge merely mirrors a block that is already in
force.

**Write amplification.** A book currently in the relocated-plus-missing state performs one
extra `cast.json` write on the next authoritative persist and then converges
(`[R14]`); `analysis.ts:416` skips the write when both lists are empty.

**Residual explicitly NOT closed.** The relocated edge itself stays on its row and stays
un-undoable via the UI (`cast-reject-orphan.ts:514`/`:548` only touch the clicked row). It
is still reaped by pass 1 once the last pair for that `from` is undone. This is plan 278's
invariant 10 residual and is unchanged — the fix does not widen it, because every edge it
adds sits on a row the Undo button can reach.

**Docs owed with the fix.** `reject-edge-reconcile.ts`'s module doc (`:50-56`), plan 281's
"Deviation from the spec" (`docs/features/archive/281-reject-edge-atomicity.md:91-108`, add
a superseded-by-#2200 note rather than rewriting an archived plan), and plan 278's
invariant 10 note. Plus the standard release-notes pair — though this is operator-invisible
healing, so the `RELEASE_NOTES.md` line may legitimately be skipped with a stated reason.

**Suggested follow-up, to file separately (not fix-now — it needs a UI decision):** a
relocated edge with *no* surviving pair for its `from` is reaped, but one with a surviving
pair is invisible and un-undoable indefinitely. That is invariant 10's residual and #2198's
neighbourhood; it needs an affordance, not a predicate.
