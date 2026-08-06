---
status: active
shipped: null
owner: null
---

# Cast-identity follow-ups — #2110, #2129, #2133, #2128

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

> Status: active — #2110, #2129, #2133 shipped 2026-08-06 (PR #2163), each **except
> #2133** via a mechanism this plan's own tasks do not specify; #2128 (Tasks 2-9,
> most of this document) was never started and remains open. See "What actually
> shipped" immediately below for the full reconciliation.
> Design of record: [`docs/superpowers/specs/2026-08-06-cast-identity-followups-design.md`](../superpowers/specs/2026-08-06-cast-identity-followups-design.md)
> Parent plan: [`278-cast-character-identity.md`](278-cast-character-identity.md)
> Key files: `server/src/store/cast-id-history.ts`, `server/src/store/cast-resolve.ts`,
> `server/src/store/cast-audio-currency.ts` (new), `server/src/audio/segments-io.ts`,
> `server/src/audio/finalize-chapter-write.ts`, `scripts/repair-cast-id-drift.mjs`,
> `src/views/cast.tsx`
> URL surface: `#/books/<id>/cast` (the orphaned-character banner)
> OpenAPI ops: `GET /api/books/{bookId}/state` (`orphanedCharacterFallbacks`)

**Goal:** Make the Cast banner and the repair pass agree on one question — "is this
orphaned id's rendered audio still current?" — answered by one shared predicate, and
close the three surrounding identity defects that let persisted state corrupt silently.

**Architecture:** A per-book monotonic counter (`seq`) on `cast-id-history.json` plus a
per-key marker (`recordedAtSeq`) records *when each alias's current target was
established*. Every full chapter render stamps the counter it resolved against
(`castHistorySeq`) into its `<slug>.segments.json`. One pure predicate,
`isAudioCurrent(resolution, segmentsFile, history)`, compares the two and returns
`true | false | 'unknown'`; the Cast banner and `repair-cast-id-drift.mjs` both call it
rather than each deciding for themselves. Anything other than `true` is damage.

## What actually shipped (2026-08-06)

Reconciled after the fact. This document was the design thread for #2110, #2129,
#2133, #2128, but implementation ran on a separate branch
(`fix/server-cast-identity-followups`, **PR #2163**, merge commit
`7add81c0ce4fde75657ca2e64f5bd0131eb87d16`) whose commits **do not follow the task
breakdown below** for three of the four issues. Recorded here rather than by
silently rewriting the tasks to match — CLAUDE.md's "Surgical changes" section is
explicit that a plan quietly edited to agree with the code loses the record of
what was decided and why. Tasks 1-9 below are left exactly as originally written,
as the historical design record — do not treat their checkboxes as a to-do list
without reading this section first.

**#2110 shipped, but not via Task 1.** Task 1 specifies reserving `supersededBy`
*values* directly in `cast-create.ts`'s taken set. The linked spec (§7) explicitly
considered and **rejected** pruning dangling entries ("a dangling entry is inert
only while its target is dead, and resumes protecting its segments if a later
re-analysis re-mints that target"). **The shipped fix does exactly the pruning the
spec rejected**: a new primitive, `dropSupersededTargetsNoLongerLive`
(`server/src/store/cast-id-history.ts`), prunes a `supersededBy` entry whose target
has stopped being live — but only at the two authoritative end-of-run writes, never
an interim one (pinned by
`server/src/routes/analysis.interim-prune-prohibition.e2e.test.ts`, closing the
exact #2086 hazard Task 1's own background section warns pruning would reopen).
The pruned entry moves into `displaced` (a pre-existing field), and
`cast-create.ts`'s taken set was widened during PR #2163's own fix rounds to
`existingIds ∪ historyKeys ∪ displacedKeys ∪ rejectedPairs[].from` — the last two
buckets (`displacedKeys`, then `rejectedPairFromKeys`) were found missing by
review findings C1 and F1 *during* that PR, not planned here. Task 1's literal diff
(reserving `Object.values(history.supersededBy)`) was never written.

**#2129 shipped, but not via `isAudioCurrent`/`castHistorySeq`.** Tasks 2-9 build a
per-book monotonic `seq` counter, `recordedAtSeq` markers, `matchedHistoryKeys` on
the resolver, and a pure `isAudioCurrent` predicate meant to be consumed by both
the banner and the repair script. **None of this exists in the shipped code** — no
`server/src/store/cast-audio-currency.ts`, no `seq`/`recordedAtSeq`/`recordedAtIso`
on `CastIdHistory`, no `castHistorySeq` on any segments file, no
`matchedHistoryKeys` on `CastResolution`. `src/views/cast.tsx` instead gates the
"audio needs a re-render" note on a static allowlist,
`STALE_AUDIO_RESOLUTIONS: ReadonlySet<OrphanedCharacterFallback['resolution']> =
new Set(['alias', 'normalised'])` (per #2107's ruling that only `'exact'` means the
rendered bytes are fine) — a resolution-*type*-only gate with no notion of "has
this alias's target changed since this segment rendered." `repair-cast-id-drift.mjs`
was not touched to consult any predicate, so it still lists every non-`'exact'` id
as damage regardless of whether a re-render has since made it current — the exact
divergence #2129 was filed to close between the two surfaces stays partially open:
the banner's language softened, but neither surface can yet say "this one's audio
is current."

**#2133 shipped as Task 10 specifies.** Reconciled from the sibling branch
(commits `8c0925a2`, `03dd0fc6`, both present in the merged history) exactly as
planned: both `analysis.ts`'s `recordRetirements` and `cast-merge.ts`'s
`performCastMerge` now act on `droppedSelfLoopRejections`, the DELETE route clears
the `notLinkedTo` edge unconditionally, and `docs/features/278-cast-character-identity.md`
gained invariant 10. One thing Task 10 did not anticipate: PR #2163's review filed
a residual, **#2166** ("an abandoned half-written reject leaves an invisible
`notLinkedTo` edge with no UI path to remove it"), recorded in plan 278's
invariant 10 rather than here.

**#2128 (Tasks 2-9 in full) did not ship and remains open.** The open issue's text
(filed 2026-08-05, unedited since) still describes the *timestamp*-based approach
("per-entry `recordedAt` on `cast-id-history.json` compared against
`SegmentsFile.synthesizedAt`") that the linked spec explicitly considered and moved
away from, in favour of a `seq` counter, one day later (see the spec's "Why a
counter and not a timestamp" section) — a design decision the issue itself has
never been updated to reflect. A future implementer picking up #2128 needs to know
this spec exists and represents a considered, reviewed (three adversarial passes)
alternative to the issue's own framing, not simply re-derive a timestamp scheme
from the stale issue text.

**Also shipped in PR #2163, outside this plan's scope entirely** (declared in the
PR body as incidental fixes, not silently folded in): a per-run `cast.json`
merge-base compare-and-set primitive serialising `analysis.ts`'s five merge-base
writes (a pre-existing race, unrelated to any of #2110/#2129/#2133/#2128); a
`Promise.all`-of-dynamic-imports race fix in both new e2e test files (the same
pattern #2083 had already swept from ten siblings); and a
`record.bookId ?? bookIdFromTitle(...)` fail-open fallback fix, four sites rather
than the two originally reported.

**Net position:** 3 of 4 issues closed, only #2133 via the mechanism this plan
specifies for it. #2128 — the reason the `seq`/predicate architecture (the bulk of
this document, Tasks 2-9) exists at all — is untouched.

**Tech Stack:** TypeScript (Node 20 + Express server, Vite/React 18/RTK frontend),
Vitest (server + frontend), Playwright (e2e), plain-JS `.mjs` for the repair script.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include this section.

1. **`schema` stays `1`.** Every new field is additive-optional, matching the module's
   existing optional fields, each of whose doc comments promises "never bumps `schema`".
   No migration, no re-validation rework, no read-site sweep.
2. **Thread the whole `CastIdHistory`, never a subset** (spine rule 2). No new
   `Pick<CastIdHistory, …>` parameter, and no object literal passed to
   `buildCastResolver(` or `isAudioCurrent(`. Enforced by the guard in Task 5.
3. **One comparator, two callers** (spine rule 1). The banner and the repair pass must
   not each answer "is this id fine?" with independently written logic. Labels change as
   a *consequence* of the predicate existing, not instead of it.
4. **`'unknown'` is listed as damage.** A missing `castHistorySeq`, a missing
   `recordedAtSeq` field, a file counter below a render's stamp, and a non-finite marker
   each read `'unknown'`. Only an affirmative comparison clears a row. **Inverting this
   is the most dangerous mistake available in this lane — it silently re-opens #2107.**
5. **`0` is a valid `castHistorySeq`,** not an absent one. An `if (!castHistorySeq)`
   check routes every legacy case to `'unknown'` and ships #2128 dead. Test
   `Number.isFinite`, never truthiness.
6. **The uniform stamp rule, no exceptions.** Every write to `cast-id-history.json`
   increments `seq`. Every write to `supersededBy[k]` stamps `recordedAtSeq[k]` and
   `recordedAtIso[k]`. Every delete of `supersededBy[k]` deletes both. After any write,
   `keys(recordedAtSeq) === keys(supersededBy)` — bidirectionally.
7. **`recordedAtIso` is display only.** The predicate reads `recordedAtSeq` and nothing
   else. Never compare an ISO string.
8. **Only the full-render path writes `castHistorySeq`.** `chapter-qa-repair.ts` and
   `chapter-splice.ts` carry the prior file's value forward verbatim, or omit it when the
   prior file had none. Refreshing it there launders a stale row through a partial
   rewrite.
9. **`resolution`'s three values (`'alias' | 'normalised' | 'unresolved'`) are
   untouched,** as are the reject/undo chips and their tests. `audioCurrent` is a new,
   separate axis.
10. **Every assertion is mutated on its own line during implementation** to prove it can
    fail before it is trusted. A test that passes against a deliberately broken
    implementation is not coverage.

---

## Situation on the ground (read this before Task 1)

**#2133 is already implemented on a sibling branch.** A concurrent session shipped it
while this spec was being finalised:

| | |
|---|---|
| Worktree | `C:\Claude\Projects\wt-cast-identity-followups` |
| Branch | `fix/server-cast-identity-followups` (local only — **not pushed**, no PR) |
| Commits | `8c0925a2` (server, closes #2133) · `03dd0fc6` (frontend, chip hidden for a dead target) |

**Task 10** reconciles that branch rather than re-implementing #2133. **Do not write #2133
code in this lane.** Read Task 10 first if you are sequencing the work — it may want to
merge early, since it touches `cast-id-history.ts`, which Task 2 rewrites.

### Spec corrections found while writing this plan

Recorded here rather than silently fixed — this plan is what a later reader trusts.

1. **§2 says "Three declarations carry the field", naming a third local copy in
   `generation.ts`.** There is no such declaration. `finalize-chapter-write.ts:49-50`'s
   doc comment claims "Mirrors generation.ts's local copy", but `generation.ts` declares
   no segments-file interface and imports only `finalizeChapterAudioWrite` (`:65`). **Two
   declarations carry the field**, not three (Task 6). The stale doc comment is corrected
   in the same task.
2. **§1 guard 3 names two live object-literal sites; there are three.** The third is
   `repair-cast-id-drift.mjs:742`'s `idOnlyResolver`, deliberately built with
   `{ supersededBy: {}, rejected: [] }` for tier-B id-shape matching. Legitimate, and
   allowlisted with its reason (Task 5).

---

## File structure

**New files**

| File | Responsibility |
|---|---|
| `server/src/store/cast-audio-currency.ts` | The predicate. Pure, I/O-free, no imports beyond two `type` imports. The single answer to "is this resolution's rendered audio current?" for both consumers. |
| `server/src/store/cast-audio-currency.test.ts` | Full truth table, every `'unknown'` source, cross-chapter aggregation. |
| `server/src/store/cast-history-threading.guard.test.ts` | Guard 3 — fails the build on an object literal passed to `buildCastResolver(` / `isAudioCurrent(`. |
| `server/src/store/cast-id-history.stamp.guard.test.ts` | Guard 5 — every `supersededBy[k] =` assignment site is paired with a stamp. |

**Modified files**

| File | Change |
|---|---|
| `server/src/store/cast-id-history.ts` | `seq` / `recordedAtSeq` / `recordedAtIso`; one internal `bumpSeqAndStamp`; `seq` repair on load; `stampRecordedAtSeqIfAbsent` export. |
| `server/src/store/cast-resolve.ts` | `matchedHistoryKeys` on `CastResolution`; a parallel norm-key→raw-keys map. |
| `server/src/audio/finalize-chapter-write.ts` | `castHistorySeq` on `ChapterSegmentsFile` + `FinalizeChapterAudioInput`; written through. |
| `server/src/audio/segments-io.ts` | `castHistorySeq` on `SegmentsFile`; `audioCurrent` on `OrphanedCharacterFallback`; collector takes the whole `CastIdHistory`. |
| `server/src/routes/generation.ts` | Passes `castHistorySeq: castIdHistory.seq ?? 0`. |
| `server/src/routes/chapter-qa-repair.ts`, `chapter-splice.ts` | Carry the prior stamp forward. |
| `server/src/routes/cast-create.ts` | #2110 — `supersededBy` **values** join the taken set; third report branch. |
| `openapi.yaml`, `src/lib/api-types.ts` (generated), `src/lib/types.ts`, `src/store/cast-slice.ts` | `audioCurrent` on the wire and its two hand-written frontend mirrors. |
| `src/views/cast.tsx` | The auto-reconciled disclosure splits in two. |
| `scripts/repair-cast-id-drift.mjs` | `buildOrphansFromSegments` consults the predicate; `planBookRepairs`'s zero-segment branch; `--apply` one-shot stamp. |
| `server/src/store/cast-resolve.repair-pass-contract.test.ts` | Updated for the new signature (it calls the script's function from the server suite). |

---

### Task 1: #2110 — reserve `supersededBy` values, not just its keys

> **Not how #2110 shipped.** The real fix (PR #2163, 2026-08-06) prunes dangling
> entries instead — the opposite of what this task and the linked spec's §7
> recommend. See "What actually shipped" above before implementing anything below;
> #2110 is already closed.

Self-contained, no dependency on anything else in this lane. Ship it first so the lane
opens with a green branch.

**Files:**
- Modify: `server/src/routes/cast-create.ts:125-128` (the taken set) and `:170-186` (the report)
- Test: `server/src/routes/cast-create.test.ts`

**Interfaces:**
- Consumes: nothing from this lane.
- Produces: nothing later tasks rely on.

**Background.** `cast-create` already treats history **keys** as taken (#2085), so a
retired id can't be re-minted. It does not treat history **values** as taken. Merge
`anton` → `антон`, delete `антон`'s row, re-create "Антон": the mint produces `антон`,
which is the *target* of a live `supersededBy` entry. Every segment carrying `anton` now
resolves through history straight onto a brand-new, empty character.

`cast-create` does not *refuse* a taken id — it suffixes (`антон` → `антон-2`) and creates
the character with the requested **name** intact. The issue's "can never be reused by
name, forever" overstates it.

- [ ] **Step 1: Write the failing test**

Add to the **existing** `describe('POST /api/books/:bookId/cast/create — history-protected
ids (srv-86 / #2085)', …)` block at `server/src/routes/cast-create.test.ts:188`. That block
already has the `historyPath()` / `bookDir()` locals and — importantly — a `beforeEach`
that `rmSync`es the history file, because the module-level `beforeEach` never touches it
and a file one test writes otherwise survives into the next (review round 1 caught a test
passing for the wrong reason on exactly that). Use its helpers: `writeBookOnDisk(…)`,
`callCreate(bookId, body)`, `readCastJson(bookDir())`. Do not add a second fixture helper.

```ts
  it('does not re-mint an id that is a live supersededBy TARGET (#2110)', async () => {
    /* The merge-then-DELETE repro: merge leaves `{anton: 'антон'}`, the target
       row is then deleted, and a re-create of "Антон" mints the target id. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
    ]);
    writeFileSync(historyPath(), JSON.stringify({ schema: 1, supersededBy: { anton: 'антон' } }));

    const res = await callCreate(bookId, { name: 'Антон' });

    expect(res.status).toBe(200);
    // The naive mint IS "антон" — the exact target `anton` redirects onto.
    expect(res.body.character.id).not.toBe('антон');
    expect(res.body.character.id).toBe('антон-2');
    expect(res.body.character.name).toBe('Антон'); // the NAME is never mangled
  });

  it('reports a values-collision avoidance rather than suffixing silently (#2110)', async () => {
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
    ]);
    writeFileSync(historyPath(), JSON.stringify({ schema: 1, supersededBy: { anton: 'антон' } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await callCreate(bookId, { name: 'Антон' });

    expect(log.mock.calls.flat().join('\n')).toMatch(
      /avoided re-minting "антон" — it is the live target of history entry "anton"/,
    );
    log.mockRestore();
  });

  it('still covers a NORMALISED collision with a supersededBy target (#2110)', async () => {
    /* The TARGET is the drifted spelling `the_torment`; the mint for "The
       Torment" is `the-torment`, which normalises to the same key.

       Round 1 (I9): the first draft used `{ the_torment: 'the-torment' }`,
       where the history KEY already normalises to the mint — so `takenNorm`
       blocked it on `main` and the test stayed green with `...historyTargets`
       removed, i.e. it could not fail. Verified against
       `server/src/util/character-id.ts:7-12`: `normaliseIdKey` lowercases and
       maps `[-_\s]+` to `-`, and does NOT transliterate. Putting the drifted
       spelling on the VALUE side is what isolates the new branch. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
    ]);
    writeFileSync(historyPath(), JSON.stringify({ schema: 1, supersededBy: { mayrin: 'the_torment' } }));

    const res = await callCreate(bookId, { name: 'The Torment' });

    expect(res.body.character.id).not.toBe('the-torment');
  });

  it('still names the KEY, not the target, when both would match (#2110 vs #2085)', async () => {
    /* A self-pointing-ish shape where the naive mint collides with a history
       KEY as well: the key branch is the more specific statement and must keep
       firing, so the third branch cannot cannibalise #2085's report. */
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_WITH_CAST, bookId, [
      { id: 'мairin', name: 'Mairin', role: 'character', color: 'unset' },
    ]);
    writeFileSync(historyPath(), JSON.stringify({ schema: 1, supersededBy: { anton: 'мairin' } }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await callCreate(bookId, { name: 'Anton' });

    expect(log.mock.calls.flat().join('\n')).toMatch(/history-protected "anton"/);
    log.mockRestore();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/cast-create.test.ts -t "#2110"`
Expected: FAIL — the first asserts `антон-2`, the route currently returns `антон`.

- [ ] **Step 3: Widen the taken set**

In `server/src/routes/cast-create.ts`, replace lines **125-128** — `:129` is
`const isTaken = …`, which `:138` and `:140` call, so replacing 126-129 both duplicates
`const history` and deletes `isTaken` (round 1, I4):

```ts
    const history = await loadCastIdHistory(located.bookDir);
    const historyKeys = new Set(Object.keys(history.supersededBy));
    const takenIds = new Set([...existingIds, ...historyKeys]);
    const takenNorm = new Set([...takenIds].map(normaliseIdKey));
```

with:

```ts
    const history = await loadCastIdHistory(located.bookDir);
    const historyKeys = new Set(Object.keys(history.supersededBy));
    /* #2110 — a `supersededBy` VALUE is taken for exactly the same reason its
       KEY is, one step further along the redirect. A key protects the segments
       that still carry the retired spelling; a value is what those segments
       currently resolve ONTO. Re-minting a value hands a brand-new, empty
       character every segment that redirects there — the same hijack #2085
       closed for keys, arriving by the other end of the arrow. It survives the
       target row's deletion: `buildCastResolver` drops an entry whose target
       isn't live (cast-resolve.ts:102-103), so the entry sits inert until a
       mint resurrects the id, at which point it starts redirecting again.
       Pruning dangling entries instead was considered and rejected for that
       exact reason — inert is not dead. */
    const historyTargets = new Set(Object.values(history.supersededBy));
    const takenIds = new Set([...existingIds, ...historyKeys, ...historyTargets]);
    const takenNorm = new Set([...takenIds].map(normaliseIdKey));
```

- [ ] **Step 4: Add the third report branch**

Plan 278's invariant 8 states the report fires whenever the avoidance fires. Without this
branch a values-collision suffixes **silently** — the gap #2085's review round 2 (M4)
closed once for the live-id case.

After the existing `collidingLiveId` computation (`cast-create.ts:166-168`), add:

```ts
    const collidingHistoryTarget = [...historyTargets].find(
      (t) => normaliseIdKey(t) === unprotectedNorm,
    );
```

and add a third branch to the report chain, **after** `collidingHistoryKey` and
`collidingLiveId` (a key match is the more specific statement — report that when both
apply):

```ts
    } else if (unprotectedId !== newId && collidingHistoryTarget) {
      /* #2110 — describe the recorded entry, not an active redirect: like the
         key branch above, `supersededBy` records what WAS retired, and the
         entry may be inert today (dangling target). */
      const viaKeys = Object.entries(history.supersededBy)
        .filter(([, t]) => t === collidingHistoryTarget)
        .map(([k]) => k);
      console.log(
        `[cast-create] ${bookId} avoided re-minting "${unprotectedId}" — it is the live target of history ` +
          `${viaKeys.length === 1 ? 'entry' : 'entries'} ${viaKeys.map((k) => `"${k}"`).join(', ')}; ` +
          `minted "${newId}" instead.`,
      );
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/routes/cast-create.test.ts`
Expected: PASS, including every pre-existing #2085 case (the key-collision report must
still name the key, not the target).

- [ ] **Step 6: Mutate each new assertion to prove it can fail**

For each of the **four** new tests, break the implementation on that assertion's own line
(e.g. drop `...historyTargets` from `takenIds`; change the log string) and confirm the
test goes red. Restore. This is Global Constraint 10 — and note that dropping
`...historyTargets` must redden **three** of the four; if it reddens fewer, one of the
fixtures is not isolating the new branch (round 1, I9).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/cast-create.ts server/src/routes/cast-create.test.ts
git commit -m "fix(server): reserve supersededBy targets against a cast-create re-mint (#2110)"
```

---

### Task 2: The persisted schema, `seq`, and the uniform stamp rule

> **Tasks 2-9 (through "#2128 — the repair pass clears") are unimplemented.** None
> of the `seq`/`recordedAtSeq`/`isAudioCurrent`/`matchedHistoryKeys` architecture
> below exists in the shipped code. #2129 shipped a narrower fix that does not need
> it (see "What actually shipped" above); #2128, which this architecture exists
> for, is still open. This remains the live design for #2128 unless a future
> implementer decides otherwise — but check the open issue's own text first, which
> still describes a different (rejected) timestamp-based approach.

The foundation. Everything after this reads what this task writes.

**Files:**
- Modify: `server/src/store/cast-id-history.ts`
- Test: `server/src/store/cast-id-history.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CastIdHistory` gains `seq?: number`, `recordedAtSeq?: Record<string, number>`,
    `recordedAtIso?: Record<string, string>`.
  - `export async function stampRecordedAtSeqIfAbsent(bookDir: string): Promise<boolean>`
    — the one-shot stamp, for `--apply` (Task 9). Returns whether it wrote.
  - `loadCastIdHistory` now always returns a numeric `seq` (>= 0).

- [ ] **Step 1: Write the failing tests**

Add to `server/src/store/cast-id-history.test.ts`. **Use that file's existing harness —
round 1 (I11) caught the first draft inventing one:**

| The file actually provides | Not |
|---|---|
| a module-level `let dir: string`, reassigned by its own `beforeEach` to a fresh `mkdtempSync` | a `tmpBook()` helper (does not exist) |
| `writeTestHistoryFile(content: string)`, which `mkdirSync`s `.audiobook` first | a bare `fs.writeFile` — `castIdHistoryPath` is `<dir>/.audiobook/…`, so a direct write ENOENTs |
| `readFileSync` / `existsSync` from `node:fs` | `node:fs/promises` — the file imports **sync only** |

Its import list must gain `restoreSupersededId` and `stampRecordedAtSeqIfAbsent`; the
other primitives used below are already imported.

```ts
describe('#2128 — seq and recordedAt markers', () => {
  it('stamps a marker for every supersededBy key it writes, and bumps seq', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');
    const h = await loadCastIdHistory(dir);
    expect(h.seq).toBe(1);
    expect(h.recordedAtSeq).toEqual({ mayrin: 1 });
    expect(typeof h.recordedAtIso?.mayrin).toBe('string');
  });

  it('restamps a repointed entry — the merge-repoint regression', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');      // seq 1, mayrin@1
    await retireCharacterId(dir, 'mairin', 'dame-alina');  // repoints mayrin -> dame-alina
    const h = await loadCastIdHistory(dir);
    expect(h.supersededBy).toEqual({ mayrin: 'dame-alina', mairin: 'dame-alina' });
    // BOTH keys were established at seq 2 — `mayrin` now points at a DIFFERENT
    // cast row than it did at seq 1, so a render made at seq 1 is stale.
    expect(h.recordedAtSeq).toEqual({ mayrin: 2, mairin: 2 });
  });

  it('restamps on the direct-reversal branch too', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'антон', 'anton');
    await retireCharacterId(dir, 'anton', 'антон'); // reversal
    const h = await loadCastIdHistory(dir);
    expect(h.supersededBy).toEqual({ anton: 'антон' });
    expect(h.recordedAtSeq).toEqual({ anton: 2 });
  });

  it('deletes both markers when forgetSupersededId removes a key', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');
    await forgetSupersededId(dir, 'mayrin');
    const h = await loadCastIdHistory(dir);
    expect(h.supersededBy).toEqual({});
    expect(h.recordedAtSeq).toEqual({});
    expect(h.recordedAtIso).toEqual({});
  });

  it('deletes both markers when dropSupersededIdsReclaimedByLiveCast drops a key', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');
    await dropSupersededIdsReclaimedByLiveCast(dir, ['mayrin', 'mairin']);
    const h = await loadCastIdHistory(dir);
    expect(h.recordedAtSeq).toEqual({});
  });

  // Amended 2026-08-06 — the mirror of the test above, for the ninth write site.
  // The two drop primitives are mirror images (one prunes an entry whose KEY was
  // reclaimed, the other one whose TARGET died), so a marker-cleanup test for
  // only one of them leaves the other's deletion path unproven.
  it('deletes both markers when dropSupersededTargetsNoLongerLive drops a key', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');   // seq 1, supersededBy {mayrin: mairin}
    const before = (await loadCastIdHistory(dir)).seq!;
    await dropSupersededTargetsNoLongerLive(dir, []);   // 'mairin' not live — entry drops
    const h = await loadCastIdHistory(dir);
    expect(h.supersededBy).toEqual({});
    expect(h.recordedAtSeq).toEqual({});
    expect(h.recordedAtIso).toEqual({});
    expect(h.seq!).toBeGreaterThan(before);             // the write bumps seq like any other
  });

  it('restoreSupersededId stamps the CURRENT seq, never a replayed one', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');  // seq 1
    await forgetSupersededId(dir, 'mayrin');           // seq 2
    await rejectOrphanedPair(dir, 'mayrin', 'mairin'); // seq 3
    await restoreSupersededId(dir, 'mayrin', 'mairin');
    const h = await loadCastIdHistory(dir);
    expect(h.seq).toBe(4);
    expect(h.recordedAtSeq).toEqual({ mayrin: 4 }); // NOT 1 — see the forget->render->restore hazard
  });

  it("restoreSupersededId's early returns leave markers untouched", async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');
    const before = await loadCastIdHistory(dir);
    await restoreSupersededId(dir, 'mayrin', 'mairin'); // already equal — idempotent, no write
    await restoreSupersededId(dir, 'mayrin', 'someone-else'); // occupied — refuses, no write
    const after = await loadCastIdHistory(dir);
    expect(after.seq).toBe(before.seq);
    expect(after.recordedAtSeq).toEqual(before.recordedAtSeq);
    expect(after.recordedAtIso).toEqual(before.recordedAtIso);
  });

  it('bumps seq on the five writes that touch no supersededBy key', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await rejectOrphanedId(dir, 'a');                     // 1
    await rejectOrphanedPair(dir, 'b', 'c');              // 2
    await unrejectOrphanedPair(dir, 'b', 'c');            // 3
    await dropSupersededIdsReclaimedByLiveCast(dir, []);  // 4 — writes unconditionally
    await dropSupersededTargetsNoLongerLive(dir, []);     // 5 — likewise (amended 2026-08-06)
    expect((await loadCastIdHistory(dir)).seq).toBe(5);
  });

  it('holds keys(recordedAtSeq) === keys(supersededBy) bidirectionally', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    const script: Array<() => Promise<unknown>> = [
      () => retireCharacterId(dir, 'a', 'b'),
      () => retireCharacterId(dir, 'b', 'c'),
      () => rejectOrphanedPair(dir, 'x', 'c'),
      () => forgetSupersededId(dir, 'a'),
      () => restoreSupersededId(dir, 'a', 'c'),
      () => dropSupersededIdsReclaimedByLiveCast(dir, ['b']),
      () => retireCharacterId(dir, 'd', 'c'),
      // Amended 2026-08-06 — the ninth write site. Both arms, because they fail
      // differently: the first writes while dropping NOTHING (proving seq bumps
      // on an empty drop, the shape that makes "strictly increasing" testable),
      // the second drops every surviving entry (proving the markers go with the
      // keys rather than being left for the next write to self-heal).
      () => dropSupersededTargetsNoLongerLive(dir, ['c']), // 'c' live — drops nothing, still writes
      () => dropSupersededTargetsNoLongerLive(dir, []),    // 'c' dead — drops a and d
    ];
    let seq = 0;
    for (const step of script) {
      await step();
      const h = await loadCastIdHistory(dir);
      expect(Object.keys(h.recordedAtSeq ?? {}).sort()).toEqual(Object.keys(h.supersededBy).sort());
      expect(Object.keys(h.recordedAtIso ?? {}).sort()).toEqual(Object.keys(h.supersededBy).sort());
      expect(h.seq).toBeGreaterThan(seq); // strictly increasing across EVERY write
      seq = h.seq!;
      for (const v of Object.values(h.recordedAtSeq ?? {})) expect(v).toBeLessThanOrEqual(h.seq!);
    }
  });

  it('repairs a seq lost while recordedAtSeq survived', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'a', 'b');
    await retireCharacterId(dir, 'c', 'b'); // seq 2
    const raw = JSON.parse(readFileSync(castIdHistoryPath(dir), 'utf8'));
    delete raw.seq;
    writeTestHistoryFile(JSON.stringify(raw));
    // Without the repair this loads as 0, every later write starts at 1, and
    // every existing marker stays above it — the book can never clear again.
    expect((await loadCastIdHistory(dir)).seq).toBe(2);
  });

  it('collapses the whole file when a new field is malformed (fail-closed)', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'a', 'b');
    const raw = JSON.parse(readFileSync(castIdHistoryPath(dir), 'utf8'));
    raw.recordedAtSeq = ['not', 'a', 'map'];
    writeTestHistoryFile(JSON.stringify(raw));
    const h = await loadCastIdHistory(dir);
    expect(h.supersededBy).toEqual({}); // no aliases -> every affected id is a genuine miss and IS listed
  });
});

describe('#2128 — the one-shot stamp', () => {
  it('creates the field on a pre-lane file, stamping every existing key', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    writeTestHistoryFile(
      JSON.stringify({ schema: 1, supersededBy: { mayrin: 'mairin', anton: 'антон' } }),
    );
    expect(await stampRecordedAtSeqIfAbsent(dir)).toBe(true);
    const h = await loadCastIdHistory(dir);
    expect(h.seq).toBe(1);
    expect(h.recordedAtSeq).toEqual({ mayrin: 1, anton: 1 });
  });

  it('is a no-op once the field exists', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'a', 'b');
    const before = await loadCastIdHistory(dir);
    expect(await stampRecordedAtSeqIfAbsent(dir)).toBe(false);
    expect((await loadCastIdHistory(dir)).seq).toBe(before.seq);
  });

  it('never writes when there is no file', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    expect(await stampRecordedAtSeqIfAbsent(dir)).toBe(false);
    expect(existsSync(castIdHistoryPath(dir))).toBe(false);
  });

  it('refuses to overwrite a malformed file', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    writeTestHistoryFile('{ "schema": 2, "supersededBy": {} }');
    expect(await stampRecordedAtSeqIfAbsent(dir)).toBe(false);
    // The operator's broken file is still there to fix, not silently replaced
    // with an empty history that discards whatever supersededBy it held.
    expect(JSON.parse(readFileSync(castIdHistoryPath(dir), 'utf8')).schema).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/store/cast-id-history.test.ts -t "#2128"`
Expected: FAIL — `seq` and `recordedAtSeq` are `undefined`;
`stampRecordedAtSeqIfAbsent` is not exported.

- [ ] **Step 3: Add the three fields**

In `server/src/store/cast-id-history.ts`, append to `interface CastIdHistory` (after
`rejectedPairs`, before the closing brace):

```ts
  /** #2128 — monotonic per-book counter, incremented on EVERY write to this
   *  file, whether or not a `supersededBy` key changed. The broader rule makes
   *  "seq strictly increases across every write" a testable invariant rather
   *  than an ambiguous one. Additive and backwards-compatible: optional, never
   *  bumps `schema`. `loadCastIdHistory` repairs it upward from
   *  `recordedAtSeq` (see its own doc comment) — without that repair, a file
   *  that loses `seq` while keeping its markers can never clear a row again. */
  seq?: number;
  /** #2128 — the `seq` at which each key's CURRENT target was established.
   *  NOT "when the alias was first recorded": `retireCharacterId`'s repoint
   *  loop can move an alias onto a different cast row, whose voice is whichever
   *  row won the merge, so a render made against the old target is stale even
   *  though the KEY never changed. Restamping on repoint is what closes that.
   *
   *  The authoritative value `isAudioCurrent` compares. FIELD ABSENT means
   *  "this file has never been through the lane" and reads `'unknown'`; a KEY
   *  missing from a PRESENT field means "predates the one-shot stamp" and
   *  contributes 0. The two are not the same, and conflating them is fail-open
   *  on the one axis this codebase actually fails. */
  recordedAtSeq?: Record<string, number>;
  /** #2128 — human-readable companion for operator diagnostics (an operator
   *  hand-inspecting this file mid-repair-run can tell WHEN, not merely in what
   *  order). NEVER compared: the predicate reads `recordedAtSeq` only. The
   *  names carry the rule — `…Seq` is authoritative, `…Iso` is display. */
  recordedAtIso?: Record<string, string>;
```

- [ ] **Step 4: Extract the shape check, add the new conjuncts and the `seq` repair**

Replace the body of `loadCastIdHistory` (`:137-170`) with a version that delegates its
conjunction to a named predicate — `stampRecordedAtSeqIfAbsent` needs the identical
check, and two copies of it is exactly the shape this lane exists to stop:

```ts
/** The whole-file shape check, extracted so `stampRecordedAtSeqIfAbsent` can
 *  ask the identical question before it writes (a second, hand-rolled copy is
 *  the duplicate-logic shape this lane exists to stop). All-or-nothing BY
 *  DESIGN: a malformed field degrades the whole file to the empty default, so
 *  no id gets alias protection and every affected id is listed as a genuine
 *  miss. Fail-closed, and required by #2128's acceptance. */
function isWellFormedHistory(raw: unknown): raw is CastIdHistory {
  const h = raw as CastIdHistory;
  return (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    h.schema === 1 &&
    typeof h.supersededBy === 'object' &&
    !Array.isArray(h.supersededBy) &&
    h.supersededBy !== null &&
    (h.displaced === undefined ||
      (typeof h.displaced === 'object' && !Array.isArray(h.displaced) && h.displaced !== null)) &&
    (h.rejected === undefined || Array.isArray(h.rejected)) &&
    (h.rejectedPairs === undefined || Array.isArray(h.rejectedPairs)) &&
    /* #2128 — validated the same way, and deliberately inside the same
       all-or-nothing conjunction as everything above it. */
    (h.seq === undefined || (typeof h.seq === 'number' && Number.isFinite(h.seq))) &&
    (h.recordedAtSeq === undefined ||
      (typeof h.recordedAtSeq === 'object' &&
        !Array.isArray(h.recordedAtSeq) &&
        h.recordedAtSeq !== null)) &&
    (h.recordedAtIso === undefined ||
      (typeof h.recordedAtIso === 'object' &&
        !Array.isArray(h.recordedAtIso) &&
        h.recordedAtIso !== null))
  );
}

/** #2128 — `seq` repaired upward from the markers on load. A file that loses
 *  `seq` (hand-edit, merge conflict, truncated write) while keeping
 *  `recordedAtSeq` would otherwise load as 0, every subsequent write would
 *  start again from 1, every existing stamp would stay above it, and the
 *  book's rows could NEVER clear again. Reading the true floor off the markers
 *  themselves costs nothing and makes that unreachable. */
function repairSeq(h: CastIdHistory): number {
  const marks = Object.values(h.recordedAtSeq ?? {}).filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v),
  );
  return Math.max(typeof h.seq === 'number' && Number.isFinite(h.seq) ? h.seq : 0, ...marks, 0);
}
```

and rewrite `loadCastIdHistory`'s middle:

```ts
    if (isWellFormedHistory(raw)) {
      return { ...raw, seq: repairSeq(raw) };
    }
```

leaving the two `console.warn`s and the empty default untouched.

- [ ] **Step 5: Add the single stamp mutator, and call it from every writer**

Add above `retireCharacterId`:

```ts
/** #2128 — the ONE place `seq` advances and markers move. Every writer in this
 *  module calls this immediately BEFORE its `writeJsonAtomic`, whether or not
 *  it touched a `supersededBy` key.
 *
 *  `stampedKeys` are the keys whose TARGET this write established or changed.
 *  Beyond those, the reconcile loops below hold Global Constraint 6's
 *  bidirectional invariant unconditionally: a marker whose key is gone is
 *  destroyed, and a key with no marker (a pre-lane file, a hand-edit that
 *  dropped the field, a merge conflict) is stamped at the new `seq`. That
 *  second loop IS the one-shot back-fill: a legacy alias becomes current only
 *  once a chapter is re-rendered ABOVE this stamp, which is the fail-closed
 *  direction. */
function bumpSeqAndStamp(history: CastIdHistory, stampedKeys: readonly string[]): void {
  const next = (history.seq ?? 0) + 1;
  const iso = new Date().toISOString();
  const seqMap: Record<string, number> = { ...(history.recordedAtSeq ?? {}) };
  const isoMap: Record<string, string> = { ...(history.recordedAtIso ?? {}) };

  for (const k of stampedKeys) {
    seqMap[k] = next;
    isoMap[k] = iso;
  }
  for (const k of Object.keys(seqMap)) {
    if (!(k in history.supersededBy)) {
      delete seqMap[k];
      delete isoMap[k];
    }
  }
  for (const k of Object.keys(history.supersededBy)) {
    if (!(k in seqMap)) {
      seqMap[k] = next;
      isoMap[k] = iso;
    }
  }

  history.seq = next;
  history.recordedAtSeq = seqMap;
  history.recordedAtIso = isoMap;
}
```

Then wire all **nine** write sites. The keys each one establishes:

| Site | `stampedKeys` |
|---|---|
| `retireCharacterId` direct-reversal | `[from, ...repointed]` |
| `retireCharacterId` normal | `[from, ...repointed]` |
| `dropSupersededIdsReclaimedByLiveCast` | `[]` — deletions only |
| `dropSupersededTargetsNoLongerLive` | `[]` — deletions only |
| `forgetSupersededId` | `[]` — deletion only |
| `restoreSupersededId` | `[id]` |
| `rejectOrphanedId` | `[]` |
| `rejectOrphanedPair` | `[]` |
| `unrejectOrphanedPair` | `[]` |

> **Amended 2026-08-06 — the ninth site, and why the line citations are gone.**
>
> This table said "all eight write sites" and omitted
> **`dropSupersededTargetsNoLongerLive`**. That primitive did not exist when this
> plan was written: #2110 introduced it in PR #2163, the same PR the "What actually
> shipped" section above reconciles after the fact — and that reconciliation did not
> revisit this table. It deletes `supersededBy[k]` and writes the file, so under
> Global Constraint 6 it is a write site like any other.
>
> **What goes wrong if it stays unwired.** Not stale-marker inheritance — the
> `stampAndBump` helper above already self-heals that, pruning keys absent from
> `supersededBy` (and back-filling missing ones at the *current* seq, which is the
> conservative direction). The actual hole is upstream of the markers: an unwired
> write changes the history state **without incrementing `seq`**, so two different
> history states share one counter value. `castHistorySeq` exists to record *the
> state a render resolved against*; once two states share a value it cannot.
>
> > `supersededBy['anton'] = 'антон'` at `seq=3`. Chapter X renders and stamps
> > `castHistorySeq=3`, resolving through the alias to Антон — correct.
> > `'антон'` then stops being live, so `dropSupersededTargetsNoLongerLive` removes
> > the entry — leaving `seq=3`. Chapter Y renders and also stamps
> > `castHistorySeq=3`, but `'anton'` no longer resolves through history at all.
> > Two renders, two different resolutions, one indistinguishable stamp.
>
> It also breaks the plan's own two testable invariants directly: "seq strictly
> increases across every write", and `keys(recordedAtSeq) === keys(supersededBy)`
> at rest between the drop and the next write.
>
> **Line citations removed from this table deliberately.** Every `(before :NNN)`
> here was stale — #2110/#2133 shifted `cast-id-history.ts` by ~50-100 lines in
> PR #2163, so `:427`, `:492`, `:541` and the rest no longer point at the writes
> they name. Cite by symbol, as the linked spec already resolved to do for the same
> reason (its F2 note: "a line citation here was stale the moment it was written
> twice already").

Both repoint loops must now collect what they touched. The direct-reversal branch becomes:

```ts
    if (history.supersededBy[to] === from) {
      delete history.supersededBy[to];
      const repointed: string[] = [];
      for (const [key, value] of Object.entries(history.supersededBy)) {
        if (value === from) {
          history.supersededBy[key] = to;
          repointed.push(key);
        }
      }
      history.supersededBy[from] = to;
      const droppedSelfLoopRejections = repointRejectedPairs(history, from, to);
      bumpSeqAndStamp(history, [from, ...repointed]);
      await writeJsonAtomic(castIdHistoryPath(bookDir), history);
      return { droppedSelfLoopRejections };
    }
```

and the normal path the same way, using `resolvedTo` in place of `to`:

```ts
    const repointed: string[] = [];
    for (const [key, value] of Object.entries(history.supersededBy)) {
      if (value === from) {
        history.supersededBy[key] = resolvedTo;
        repointed.push(key);
      }
    }
    history.supersededBy[from] = resolvedTo;
    const droppedSelfLoopRejections = repointRejectedPairs(history, from, resolvedTo);
    bumpSeqAndStamp(history, [from, ...repointed]);
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return { droppedSelfLoopRejections };
```

**`restoreSupersededId`'s two early returns (`:534-539`) get no call** — they write
nothing, so they must stamp nothing. A mutant that stamps on the idempotent path is what
the "early returns leave markers untouched" test exists to catch.

**Add an idempotence guard to `retireCharacterId`.** Review round 1 (I12) found that the
function's only early returns are `from === to` (`:269`) and `from === resolvedTo`
(`:312`) — there is **no** "already equals the recorded target" guard, so recording the
same retirement twice writes twice. Harmless before this lane; under the uniform stamp
rule the second, semantically-no-op call bumps `seq` and restamps `from`, invalidating
every render made in between. `analysis.ts` reaches `recordRetirements` from **eight**
sites per run (`:2896, 4914, 4915, 4925, 5438, 6176, 6177, 6187`), so a re-analysis that
re-derives an already-recorded retirement would re-list the whole book — a far larger
operator-visible consequence than known limits 1 and 2, arriving silently.

Add immediately after the `resolvedTo` dereference (`:307`) and the existing self-entry
guard (`:312`):

```ts
    /* #2128 — a retirement that changes nothing must not write. This mirrors
       the idempotent-write discipline every other primitive in this module
       already applies (`rejectOrphanedId`, `rejectOrphanedPair`,
       `unrejectOrphanedPair`, `restoreSupersededId`); `retireCharacterId` was
       the one that didn't, which was invisible until `seq` made a redundant
       write observable. Without it, an analysis re-deriving an
       already-recorded retirement restamps `from` and invalidates every render
       made since the original — re-listing a book the operator just cleared.

       The repoint loop below is included in "changes nothing": if no other
       entry's value is `from`, and `supersededBy[from]` already equals
       `resolvedTo`, the write is a byte-for-byte no-op. */
    const alreadyRecorded =
      history.supersededBy[from] === resolvedTo &&
      !Object.values(history.supersededBy).includes(from);
    if (alreadyRecorded && !history.rejectedPairs?.some((p) => p.to === from)) {
      return { droppedSelfLoopRejections: [] };
    }
```

with its own test:

```ts
  it('a repeat retirement writes nothing and restamps nothing (#2128)', async () => {
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');
    const before = await loadCastIdHistory(dir);
    await retireCharacterId(dir, 'mayrin', 'mairin');
    const after = await loadCastIdHistory(dir);
    expect(after.seq).toBe(before.seq);
    expect(after.recordedAtSeq).toEqual(before.recordedAtSeq);
  });

  it('still repoints when a repeat call DOES have work to do', async () => {
    // Guard the guard: `alreadyRecorded` must not swallow a real repoint.
    await retireCharacterId(dir, 'a', 'b');
    await retireCharacterId(dir, 'c', 'b');
    await retireCharacterId(dir, 'b', 'd'); // repoints a and c onto d
    const h = await loadCastIdHistory(dir);
    expect(h.supersededBy).toEqual({ a: 'd', c: 'd', b: 'd' });
  });
```

- [ ] **Step 6: Export the one-shot stamp**

Append to the module:

```ts
/** #2128 — perform the one-shot back-fill stamp on a book whose history file
 *  has never been through this lane. Called by `repair-cast-id-drift.mjs
 *  --apply` for EVERY book it scans, not only ones with an alias to record:
 *  the books carrying pre-lane aliases are exactly the ones the A33 repair
 *  workflow already visits, and absence of the field reads `'unknown'` until
 *  it lands.
 *
 *  Returns whether it wrote. Three no-write cases, all deliberate: no file
 *  (nothing to stamp), the field already exists (idempotent), and — the one
 *  that matters — a file that fails the shape check. Loading a malformed file
 *  returns the EMPTY default, so stamping that would persist an empty history
 *  over whatever `supersededBy` the operator still has on disk to repair. */
export async function stampRecordedAtSeqIfAbsent(bookDir: string): Promise<boolean> {
  return withKeyLock(`cast-id-history:${bookDir}`, async () => {
    const raw = await readJson<CastIdHistory>(castIdHistoryPath(bookDir)).catch(() => undefined);
    if (raw === null || raw === undefined) return false;
    if (!isWellFormedHistory(raw)) {
      console.warn(
        `[cast-id-history] ${castIdHistoryPath(bookDir)} has an unexpected shape — skipping the #2128 ` +
          `one-shot stamp rather than overwriting it with an empty history.`,
      );
      return false;
    }
    if (raw.recordedAtSeq !== undefined) return false;
    const history: CastIdHistory = { ...raw, seq: repairSeq(raw) };
    bumpSeqAndStamp(history, []);
    /* Written as `writeJsonAtomic(castIdHistoryPath(bookDir), …)`, NOT via a
       `const path` local. Review round 1 (C2): guard 5 counts write sites by
       matching that literal text, so hoisting the path into a variable makes
       the one new write site this lane adds invisible to the guard that exists
       to see write sites. */
    await writeJsonAtomic(castIdHistoryPath(bookDir), history);
    return true;
  });
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/store/cast-id-history.test.ts src/store/cast-id-history.survival.test.ts`
Expected: PASS, including every pre-existing case in both files.

- [ ] **Step 8: Mutate each new assertion**

Highest-value mutants, each of which must redden exactly one test:
- drop `bumpSeqAndStamp` from the repoint path → the merge-repoint test
- stamp on `restoreSupersededId`'s idempotent early return → the early-returns test
- change `repairSeq` to return `h.seq ?? 0` → the seq-repair test
- drop the "key with no marker" loop → the one-shot-stamp test
- let `stampRecordedAtSeqIfAbsent` skip `isWellFormedHistory` → the malformed-file test

- [ ] **Step 9: Commit**

```bash
git add server/src/store/cast-id-history.ts server/src/store/cast-id-history.test.ts
git commit -m "feat(server): stamp a monotonic seq and per-key markers on cast-id-history (#2128)"
```

---

### Task 3: `matchedHistoryKeys` on the resolver

**Files:**
- Modify: `server/src/store/cast-resolve.ts:13-29` (the `CastResolution` interface),
  `:99-106` (the history maps), `:166-193` (the three non-exact branches)
- Test: `server/src/store/cast-resolve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CastResolution.matchedHistoryKeys?: string[]` — every RAW `supersededBy` key
  that matched. Present on `'history'` (exactly one) and `'normalised-history'` (one or
  more). Absent on `'exact'` and `'normalised-id'`. Task 4's predicate reads it.

**Why not `viaAlias`.** `:173/185/192` all set `viaAlias` to the **queried** id; for a
`'normalised-history'` hit the matched key is a different spelling. And `byNormHistory` is
built as `put(byNormHistory, normaliseIdKey(from), target)` (`:105`) — it stores the
target only, discarding the raw `from`.

**Deviation from the spec, recorded.** §4 describes changing `byNormHistory`'s value type
and the `put` collision helper. `put` is shared with `byNormId`, so that change has blast
radius the requirement doesn't need. A **parallel** `Map<string, string[]>` collected in
the same loop delivers the specified interface (`matchedHistoryKeys: string[]`) without
touching `put` at all. Behaviour is identical; the policy still lives in the predicate.

- [ ] **Step 1: Write the failing test**

Add to `server/src/store/cast-resolve.test.ts`:

```ts
describe('matchedHistoryKeys (#2128)', () => {
  const cast = [{ id: 'the-torment' }, { id: 'mairin' }];

  it('reports the raw key on a tier-2 history hit', () => {
    const r = buildCastResolver(cast, { supersededBy: { mayrin: 'mairin' } }).resolve('mayrin');
    expect(r?.via).toBe('history');
    expect(r?.matchedHistoryKeys).toEqual(['mayrin']);
  });

  it('reports EVERY colliding raw key on a tier-4 normalised-history hit', () => {
    // Two raw spellings normalise the same onto the SAME live target, so
    // `byNormHistory`'s `put` collapses them into one entry backed by two markers.
    const r = buildCastResolver(cast, {
      supersededBy: { The_Torment: 'the-torment', 'the.torment': 'the-torment' },
    }).resolve('The-Torment');
    expect(r?.via).toBe('normalised-history');
    expect([...(r?.matchedHistoryKeys ?? [])].sort()).toEqual(['The_Torment', 'the.torment']);
    // NOT the queried id — that is what `viaAlias` is, and it has no marker.
    expect(r?.matchedHistoryKeys).not.toContain('The-Torment');
  });

  it('omits keys whose target is not a live cast id', () => {
    const r = buildCastResolver(cast, {
      supersededBy: { The_Torment: 'the-torment', 'the-torment-x': 'deleted-row' },
    }).resolve('The.Torment');
    expect(r?.matchedHistoryKeys).toEqual(['The_Torment']);
  });

  it('is absent on the two tiers that have no history entry', () => {
    expect(buildCastResolver(cast, { supersededBy: {} }).resolve('the-torment')?.matchedHistoryKeys)
      .toBeUndefined();
    expect(buildCastResolver(cast, { supersededBy: {} }).resolve('The_Torment')?.matchedHistoryKeys)
      .toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/store/cast-resolve.test.ts -t matchedHistoryKeys`
Expected: FAIL — `matchedHistoryKeys` is `undefined` on every tier.

- [ ] **Step 3: Add the field to `CastResolution`**

After the `via` field, which is `cast-resolve.ts:28` — the interface closes at `:29`.
(Round 1, I6: `:57` is prose inside `buildCastResolver`'s JSDoc, so inserting there puts
the new field in a comment.)

```ts
  /** #2128 — every RAW `supersededBy` key that matched, for the two history
      tiers. `viaAlias` is deliberately NOT this: it carries the QUERIED id in
      all three non-exact branches, which for a `'normalised-history'` hit is a
      different spelling from the key that actually matched, and it is the key
      that carries the `recordedAtSeq` marker.

      Tier 2 matches exactly one raw key (the queried id itself). Tier 4 can
      match SEVERAL: `byNormHistory` collapses every raw spelling that
      normalises the same onto the same live target into one entry (`put` only
      nulls a slot on DIFFERING targets), so the entry is backed by two or more
      markers with no basis in the map for choosing between them. The resolver
      reports every one of them as fact and `cast-audio-currency.ts` applies the
      fail-closed policy (`max`) — keeping the marker out of the resolver
      entirely, which is why this module needs no widening to read
      `recordedAtSeq`. Absent for `'exact'` and `'normalised-id'`, which have no
      history entry at all. */
  matchedHistoryKeys?: string[];
```

- [ ] **Step 4: Collect the raw keys, and report them**

Extend the history-map loop (`:99-106`):

```ts
  const byHistory = new Map<string, T>();
  const byNormHistory = new Map<string, T | null>();
  /* #2128 — the raw `from` keys behind each normalised history slot, which
     `byNormHistory` itself discards. Collected here (inside the liveness
     `continue` above) so a key whose target is dead never contributes a
     marker, matching exactly what the tier itself will resolve. */
  const normHistoryKeys = new Map<string, string[]>();
  for (const [from, to] of Object.entries(history.supersededBy)) {
    const target = byId.get(to);
    if (!target) continue;
    if (!byHistory.has(from)) byHistory.set(from, target);
    put(byNormHistory, normaliseIdKey(from), target);
    const normKey = normaliseIdKey(from);
    const existing = normHistoryKeys.get(normKey);
    if (existing) existing.push(from);
    else normHistoryKeys.set(normKey, [from]);
  }
```

Then in the two history branches:

```ts
        return { character: hist, viaAlias: characterId, via: 'history', matchedHistoryKeys: [characterId] };
```

```ts
        return {
          character: normHist,
          viaAlias: characterId,
          via: 'normalised-history',
          matchedHistoryKeys: normHistoryKeys.get(key) ?? [],
        };
```

Leave the `'exact'` and `'normalised-id'` returns untouched.

- [ ] **Step 5: Run to verify they pass**

Run: `cd server && npx vitest run src/store/cast-resolve.test.ts`
Expected: PASS — including the pre-existing "tier 3 beats tier 4" regression, which must
be unaffected.

- [ ] **Step 6: Mutate**

Return `[characterId]` from the tier-4 branch → the "EVERY colliding raw key" test must
redden. Move the `normHistoryKeys` write above the `if (!target) continue` → the
dead-target test must redden.

- [ ] **Step 7: Commit**

```bash
git add server/src/store/cast-resolve.ts server/src/store/cast-resolve.test.ts
git commit -m "feat(server): report every matched raw history key off the resolver (#2128)"
```

---

### Task 4: The predicate — `cast-audio-currency.ts`

**Files:**
- Create: `server/src/store/cast-audio-currency.ts`
- Test: `server/src/store/cast-audio-currency.test.ts`

**Interfaces:**
- Consumes: `CastIdHistory` (Task 2's `seq` / `recordedAtSeq`), `CastResolution`
  (Task 3's `matchedHistoryKeys`).
- Produces:
  - `export type AudioCurrency = true | false | 'unknown'`
  - `export function isAudioCurrent(resolution: CastResolution<{ id: string }> | undefined,
    segmentsFile: { castHistorySeq?: number } | undefined, history: CastIdHistory): AudioCurrency`
  - `export function aggregateAudioCurrency(values: readonly AudioCurrency[]): AudioCurrency`

- [ ] **Step 1: Write the failing test**

Create `server/src/store/cast-audio-currency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { aggregateAudioCurrency, isAudioCurrent } from './cast-audio-currency.js';
import type { CastIdHistory } from './cast-id-history.js';
import type { CastResolution } from './cast-resolve.js';

const CHAR = { id: 'mairin' };
const res = (
  via: CastResolution['via'],
  matchedHistoryKeys?: string[],
): CastResolution<{ id: string }> => ({ character: CHAR, via, matchedHistoryKeys });

const history = (over: Partial<CastIdHistory> = {}): CastIdHistory => ({
  schema: 1,
  supersededBy: { mayrin: 'mairin' },
  seq: 5,
  recordedAtSeq: { mayrin: 3 },
  recordedAtIso: { mayrin: '2026-08-06T00:00:00.000Z' },
  ...over,
});

describe('isAudioCurrent (#2128 / #2129)', () => {
  it('exact is always current, stamp or no stamp', () => {
    expect(isAudioCurrent(res('exact'), { castHistorySeq: 0 }, history())).toBe(true);
    expect(isAudioCurrent(res('exact'), {}, history())).toBe(true);
    expect(isAudioCurrent(res('exact'), undefined, history())).toBe(true);
  });

  it('a genuine miss is damage', () => {
    expect(isAudioCurrent(undefined, { castHistorySeq: 9 }, history())).toBe(false);
  });

  describe("normalised-id — the tier with no history entry", () => {
    it('is current once the render proves the resolver existed', () => {
      expect(isAudioCurrent(res('normalised-id'), { castHistorySeq: 0 }, history())).toBe(true);
    });
    it('is UNKNOWN on a render that predates the stamp', () => {
      expect(isAudioCurrent(res('normalised-id'), {}, history())).toBe('unknown');
    });
  });

  describe('the alias tiers', () => {
    it('is current when the render is at or above the marker', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 3 }, history())).toBe(true);
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 4 }, history())).toBe(true);
    });
    it('is STALE when the render predates the marker', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 2 }, history())).toBe(false);
    });
    it('takes the MAX over every matched key (fail-closed)', () => {
      /* `seq: 9` is NOT decoration — the helper defaults to 5, and a
         `castHistorySeq` of 7 against a file seq of 5 trips the counter-reset
         guard and returns 'unknown' before the max is ever computed. Review
         round 1 (I7) caught the second assertion passing for that reason. */
      const h = history({
        seq: 9,
        recordedAtSeq: { a: 2, b: 7 },
        supersededBy: { a: 'mairin', b: 'mairin' },
      });
      expect(isAudioCurrent(res('normalised-history', ['a', 'b']), { castHistorySeq: 4 }, h)).toBe(false);
      expect(isAudioCurrent(res('normalised-history', ['a', 'b']), { castHistorySeq: 7 }, h)).toBe(true);
    });
    it('treats a key absent from a PRESENT field as 0', () => {
      const h = history({ recordedAtSeq: {} });
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 0 }, h)).toBe(true);
    });
  });

  describe('every unknown source LISTS — getting this backwards re-opens #2107', () => {
    it('no castHistorySeq', () => {
      expect(isAudioCurrent(res('history', ['mayrin']), {}, history())).toBe('unknown');
      expect(isAudioCurrent(res('history', ['mayrin']), undefined, history())).toBe('unknown');
    });
    it('no recordedAtSeq FIELD — never been through the lane', () => {
      expect(
        isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 4 }, history({ recordedAtSeq: undefined })),
      ).toBe('unknown');
    });
    it('counter reset — the file counter is below a render stamp', () => {
      // helper default seq is 5; the render claims 9, which it cannot have read.
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 9 }, history())).toBe('unknown');
    });
    it('NO seq at all — the conjunctive form of the guard fails open (round 1, C1)', () => {
      /* `recordedAtSeq` present, `seq` dropped in transit. Under
         `finite(history.seq) && …` this returned `true` and cleared the row. */
      const h = history({ seq: undefined, recordedAtSeq: { mayrin: 3 } });
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 9 }, h)).toBe('unknown');
    });
    it('a non-finite marker', () => {
      /* `castHistorySeq: 4` (not 9) so this reaches the marker loop instead of
         being short-circuited by the counter-reset guard — round 1 (I8) caught
         it passing for the wrong reason, which made its Step 5 mutant inert. */
      const h = history({ recordedAtSeq: { mayrin: Number.NaN } });
      expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 4 }, h)).toBe('unknown');
    });
    it('a non-finite castHistorySeq', () => {
      expect(
        isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: Number.NaN }, history()),
      ).toBe('unknown');
    });
  });

  it('treats castHistorySeq === 0 as PRESENT, never as absent', () => {
    // An `if (!castHistorySeq)` check ships #2128 dead: every legacy case
    // routes to 'unknown' and no row ever clears.
    const h = history({ recordedAtSeq: { mayrin: 0 } });
    expect(isAudioCurrent(res('history', ['mayrin']), { castHistorySeq: 0 }, h)).toBe(true);
  });
});

/* The two regressions revisions 2 and 3 of the spec were written to close. They
   are stated as END-TO-END scenarios, not unit cases, because both are about a
   SEQUENCE of writes producing a marker the predicate then reads — a unit test
   of either half alone passes while the pair is broken. */
describe('#2128 — the two hazard scenarios', () => {
  it('forget -> re-render -> restore: the Undo must NOT clear a narrator render', async () => {
    /* Revision 3's Critical. seq 3: supersededBy['mayrin']='mairin'. The
       operator rejects the pairing, so `forgetSupersededId` removes it (seq 4).
       The chapter is re-rendered with NO alias, so those segments render as the
       NARRATOR, stamped castHistorySeq 4. The operator clicks Undo.

       Revision 3 had `restoreSupersededId` REPLAY the stashed marker (3),
       making 4 >= 3 true and clearing a row whose audio is the narrator's. It
       stamps the CURRENT seq instead, so the row correctly stays listed. */
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');   // seq 1, mayrin@1
    await forgetSupersededId(dir, 'mayrin');            // seq 2
    const renderedWithNoAlias = { castHistorySeq: 2 };  // narrator bytes
    await restoreSupersededId(dir, 'mayrin', 'mairin'); // seq 3, mayrin@3
    const h = await loadCastIdHistory(dir);

    expect(
      isAudioCurrent(res('history', ['mayrin']), renderedWithNoAlias, h),
    ).toBe(false);
  });

  it('merge-repoint: an alias moved onto a different cast row re-lists', async () => {
    /* `routes/cast-merge.ts:230` retires `sourceId` into `targetId` after
       merging, and the repoint loop rewrites every entry whose VALUE was
       `sourceId`. Same person, different cast ROW — `targetId`'s voice is
       whichever row won. A render made while the alias pointed at `sourceId`
       used `sourceId`'s voice, so its bytes are stale even though the KEY never
       changed. This is what "recordedAtSeq tracks the CURRENT target" buys. */
    // `dir` is the file's own module-level temp dir, fresh per beforeEach.
    await retireCharacterId(dir, 'mayrin', 'mairin');       // seq 1, mayrin@1
    const renderedAgainstMairin = { castHistorySeq: 1 };
    await retireCharacterId(dir, 'mairin', 'dame-alina');   // seq 2, mayrin repointed@2
    const h = await loadCastIdHistory(dir);

    expect(isAudioCurrent(res('history', ['mayrin']), renderedAgainstMairin, h)).toBe(false);
  });
});

describe('aggregateAudioCurrency — one verdict per orphaned id across chapters', () => {
  it('any false wins', () => {
    expect(aggregateAudioCurrency([true, 'unknown', false])).toBe(false);
  });
  it('else any unknown wins', () => {
    expect(aggregateAudioCurrency([true, 'unknown', true])).toBe('unknown');
  });
  it('all true is true', () => {
    expect(aggregateAudioCurrency([true, true])).toBe(true);
  });
  it('an id current in ch2 and stale in ch5 is NOT current', () => {
    // The "any-current => true" direction re-opens #2107 on the banner side.
    expect(aggregateAudioCurrency([true, false])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/store/cast-audio-currency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the predicate**

Create `server/src/store/cast-audio-currency.ts`:

```ts
/* #2128 / #2129 — "is this orphaned id's rendered audio still current?",
   answered ONCE for both consumers.

   Plan 278's invariant 7 established that the banner and the repair pass must
   not each rank candidates with independently written logic ("two independent
   rankers is the exact duplicate-matching-logic defect class [plan 278] Task
   16's CRITICAL finding came from"). This module extends that to CURRENCY: the
   Cast banner (`segments-io.ts`'s collector) and `repair-cast-id-drift.mjs`
   both call `isAudioCurrent`, and neither decides for itself. The divergence
   #2129 reported — "auto-reconciled, nothing to do" on the banner while the
   repair pass listed 67 segments of the same id — is what two answers look
   like.

   Pure and I/O-free by construction: two `type` imports and nothing else, so
   the repair script can import it from `server/dist` exactly as `main()`
   already imports `buildCastResolver`.

   THE RULE THAT MATTERS: damage is anything other than `true`. A missing
   render stamp, a missing `recordedAtSeq` field, a file counter below a render
   stamp, and a non-finite marker each read `'unknown'`, and `'unknown'` is
   listed. Only an affirmative comparison clears a row. Inverting this is the
   most dangerous mistake available here — it silently re-opens #2107, whose
   whole point was that only the `'exact'` tier means "these bytes are fine". */

import type { CastIdHistory } from './cast-id-history.js';
import type { CastResolution } from './cast-resolve.js';

export type AudioCurrency = true | false | 'unknown';

/** The only thing this module needs off a `<slug>.segments.json`. Structural,
 *  so both the strict write view (`ChapterSegmentsFile`) and the loose read
 *  view (`SegmentsFile`) satisfy it without either importing the other. */
export interface AudioCurrencyStamp {
  castHistorySeq?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function isAudioCurrent(
  resolution: CastResolution<{ id: string }> | undefined,
  segmentsFile: AudioCurrencyStamp | undefined,
  history: CastIdHistory,
): AudioCurrency {
  /* A genuine miss never resolved to anything, so there is nothing to be
     current WITH — it is the original #2040 damage, reported as 'unresolved'
     and always listed. */
  if (!resolution) return false;

  /* Unchanged from #2107: the id IS the live cast id today, so the frozen
     bytes were rendered against the same row they resolve to now. The only
     tier that means "fine". */
  if (resolution.via === 'exact') return true;

  const stamp = segmentsFile?.castHistorySeq;
  /* `0` is a VALID stamp, not an absent one — a truthiness check here routes
     every legacy render to 'unknown' and ships #2128 dead. */
  if (!finite(stamp)) return 'unknown';

  /* `'normalised-id'` has no history entry, so there is no marker to compare
     against. Its hazard is different in kind: the render may predate the
     four-tier resolver EXISTING (pre-Wave-1 `resolveGroup` did a bare
     `castById.get()` and substituted the narrator). Per register row A32 that
     is `the-torment` (67 segments) and `lightning-dave` (1) — 68 of the 188
     known damaged segments. The presence of `castHistorySeq` is itself the
     proof the resolver ran, which is the only distinction this tier needs. */
  if (resolution.via === 'normalised-id') return true;

  // 'history' | 'normalised-history'
  const markers = history.recordedAtSeq;
  /* The FIELD being absent means this file has never been through the lane's
     one-shot stamp — or the object was narrowed in transit, which is the shape
     this codebase has produced three times and documents each time. Either way
     there is nothing to compare, and absence must not read as current. */
  if (markers === undefined) return 'unknown';

  /* Counter-reset guard. A render cannot have read a FUTURE state of the file,
     so a file counter below a render's stamp means the file was rebuilt from
     nothing. With `repairSeq` on load this fires only on that path, and only
     transiently — once writes accumulate past the old stamps it stops firing,
     which is correct, because by then the rebuilt file's own markers govern.

     `!finite`, NOT `finite(...) && ...`. Review round 1 (Critical): the
     conjunctive form fails OPEN — `seq?: number` is optional, so an object
     that has `recordedAtSeq` but no `seq` (a hand-narrowed subset, a
     merge conflict, a hand-edit) skips the guard entirely and falls through to
     `stamp >= highest`, which can return `true`. That is spine rule 2's exact
     shape on the one axis this codebase actually fails, and guard 3 is
     call-graph-blind so it cannot see a subset built into a variable.
     `loadCastIdHistory` always supplies a numeric `seq`, so this costs a
     correctly-threaded object nothing. */
  if (!finite(history.seq) || history.seq < stamp) return 'unknown';

  let highest = 0;
  for (const key of resolution.matchedHistoryKeys ?? []) {
    const marker = markers[key];
    /* A key absent from a PRESENT field predates the one-shot stamp and
       contributes 0 — distinct from the field itself being absent, above. */
    if (marker === undefined) continue;
    if (!finite(marker)) return 'unknown';
    if (marker > highest) highest = marker;
  }
  /* `max`, not `min`: two raw spellings can collapse onto one `byNormHistory`
     slot with no basis for choosing between their markers, so the render must
     clear the LATEST of them. */
  return stamp >= highest;
}

/** `isAudioCurrent` is per-segments-file, but the banner and the repair pass
 *  both key by orphaned id ACROSS every rendered chapter — an id current in ch2
 *  and stale in ch5 needs one verdict. `false` if any chapter is `false`; else
 *  `'unknown'` if any is `'unknown'`; else `true`. Getting this wrong in the
 *  "any-current => true" direction re-opens #2107 on the banner side.
 *
 *  An empty list returns `true` vacuously; every caller aggregates over at
 *  least one segment, so that case does not arise in production. */
export function aggregateAudioCurrency(values: readonly AudioCurrency[]): AudioCurrency {
  if (values.some((v) => v === false)) return false;
  if (values.some((v) => v === 'unknown')) return 'unknown';
  return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npx vitest run src/store/cast-audio-currency.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutate every unknown-source assertion**

For each of the five `'unknown'` sources, change the code to return `true` instead and
confirm exactly that test reddens. **This is the single most important mutation set in the
lane** — it is what proves the fail-closed direction is actually implemented and not
merely described. Also flip `stamp >= highest` to `>` and to `<=`; flip `max` to `min`.

- [ ] **Step 6: Commit**

```bash
git add server/src/store/cast-audio-currency.ts server/src/store/cast-audio-currency.test.ts
git commit -m "feat(server): add the shared audio-currency predicate (#2128, #2129)"
```

---

### Task 5: The two structural guards

Spine rule 2 and the stamp pairing, enforced at build time. Task 4 is the *logic*; this
task is what stops the next change from quietly defeating it.

**Files:**
- Create: `server/src/store/cast-history-threading.guard.test.ts` (guard 3)
- Create: `server/src/store/cast-id-history.stamp.guard.test.ts` (guard 5)
- Modify: `scripts/repair-cast-id-drift.mjs:830-834` (`planBookRepairs`'s `historyResolver`)

**Interfaces:**
- Consumes: Task 2 (`bumpSeqAndStamp`), Task 4 (`isAudioCurrent`).
- Produces: nothing consumed by later tasks.

**Why this shape.** Revision 4 of the spec proposed a guard defending against *mutation
outside the module* — a defect class this codebase has never produced — and was blind to
the one it has produced three times and documents in-tree:
`cast-resolve.ts:43-47`, `repair-cast-id-drift.mjs:2156-2170`, and
`repair-cast-id-drift.mjs:819-828`. Every field this lane adds is optional, so every
hand-narrowing site keeps compiling while silently dropping it.

- [ ] **Step 1: Write guard 3 with its neutralisation proof**

Create `server/src/store/cast-history-threading.guard.test.ts`:

```ts
/* Guard 3 (#2128, spine rule 2) — the loaded `CastIdHistory` object is threaded
   WHOLE into `buildCastResolver` / `isAudioCurrent`, never a hand-built object
   literal.

   This is the axis this codebase actually fails on, three times, each recorded
   in-tree:
     - cast-resolve.ts:43-47 — "five of this function's six call sites pass
       `supersededBy` alone and silently default `rejected` to `[]`"
     - repair-cast-id-drift.mjs (collectSegmentOrphans) — a hand-built
       `{supersededBy, rejected}` subset "silently dropping `rejectedPairs`"
     - repair-cast-id-drift.mjs (planBookRepairs) — "`rejectedPairs` was missing
       from this defended object — correct on `main` ... and wrong the moment
       #2092/#2089 merged"

   Every field #2128 adds is OPTIONAL, so a narrowing site keeps compiling while
   dropping `recordedAtSeq` — and an absent `recordedAtSeq` reads `'unknown'`,
   which lists. Fail-closed, but it lists the whole book forever and looks like
   the feature not working.

   BLIND SPOTS, stated rather than implied:
   - Call-graph blind. A variable built as a literal three lines up and passed
     by name is not caught. Only a literal AT the call site is.
   - Scans `server/src/**/*.ts` (excluding `*.test.ts`) and
     `scripts/repair-cast-id-drift.mjs`. Any other `.mjs` caller is invisible.
   - Comment/string text is stripped before matching, so a call quoted inside a
     doc comment neither fires nor masks a real one. `blankOutOpaque` does NOT
     understand regex literals, so a `/'/` in scanned source would blank forward
     to the next quote. Mitigated, not closed, by the allowlist's `count` check
     firing in BOTH directions on the two files that do contain literals — those
     act as a live-fire canary: if the scanner started blanking real code, their
     counts would drop and the suite would redden. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { globSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, '..');
const REPO = join(SERVER_SRC, '..', '..');

const CALLS = ['buildCastResolver(', 'isAudioCurrent('];

/** Replace every line comment, block comment and string literal with spaces of
 *  the same length, so indices stay stable and quoted code never matches. */
export function blankOutOpaque(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') { const end = src.indexOf('\n', i); const stop = end < 0 ? src.length : end; blank(i, stop); i = stop; continue; }
    if (two === '/*') { const end = src.indexOf('*/', i + 2); const stop = end < 0 ? src.length : end + 2; blank(i, stop); i = stop; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < src.length && src[k] !== c) { if (src[k] === '\\') k += 1; k += 1; }
      blank(i, Math.min(k + 1, src.length));
      i = k + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** True when the call starting at `callIndex` passes an object LITERAL as its
 *  history argument (the second top-level argument for `buildCastResolver`, the
 *  third for `isAudioCurrent`). Walks paren/brace/bracket depth rather than
 *  regexing, so a nested call in an earlier argument cannot fool it. */
export function historyArgIsLiteral(src: string, callIndex: number, argIndex: number): boolean {
  let i = src.indexOf('(', callIndex);
  if (i < 0) return false;
  i += 1;
  let depth = 0;
  let arg = 0;
  let start = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      if (c === ')' && depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) {
      if (arg === argIndex) break;
      arg += 1;
      start = i + 1;
    }
  }
  if (arg !== argIndex) return false;
  return /^\s*\{/.test(src.slice(start, i));
}

export function findLiteralHistoryCalls(src: string): Array<{ call: string; index: number }> {
  const clean = blankOutOpaque(src);
  const hits: Array<{ call: string; index: number }> = [];
  for (const call of CALLS) {
    const argIndex = call === 'isAudioCurrent(' ? 2 : 1;
    let from = 0;
    for (;;) {
      const at = clean.indexOf(call, from);
      if (at < 0) break;
      from = at + call.length;
      // Skip a definition (`function buildCastResolver(`) or an import line.
      const before = clean.slice(Math.max(0, at - 30), at);
      if (/\bfunction\s+$|\bexport\s+function\s+$/.test(before)) continue;
      if (historyArgIsLiteral(clean, at, argIndex)) hits.push({ call, index: at });
    }
  }
  return hits;
}

/* Keyed on file AND count, never on file alone, and checked in BOTH directions
   — a fix that removes a literal must shrink or delete its entry, exactly as a
   regression that adds one must fail. Each entry records WHY it is legitimate;
   an entry without a reason is an entry added by reflex. */
const ALLOWLIST: Array<{ file: string; count: number; reason: string }> = [
  {
    file: 'server/src/store/cast-resolve.ts',
    count: 1,
    reason:
      "rejectedPairsGoverning deliberately builds a rejects-BLIND resolver — passing a rejects-honouring one " +
      'is the bug it exists to prevent. It never calls isAudioCurrent, so no marker can be dropped here.',
  },
  {
    file: 'scripts/repair-cast-id-drift.mjs',
    count: 1,
    reason:
      "planBookRepairs's `idOnlyResolver` (:742, passed to resolveTierBId) is id-shape-only BY DESIGN — " +
      'empty history on purpose, built once per book, see resolveTierBId\'s doc comment. It never calls ' +
      'isAudioCurrent. planBookRepairs\'s historyResolver was the OTHER literal here and now takes the whole object.',
  },
];

describe('guard 3 — the loaded CastIdHistory is threaded whole (#2128)', () => {
  const files = [
    ...globSync('**/*.ts', { cwd: SERVER_SRC })
      .filter((f) => !f.endsWith('.test.ts'))
      .map((f) => join(SERVER_SRC, f)),
    join(REPO, 'scripts', 'repair-cast-id-drift.mjs'),
  ];

  it('flags no object-literal history argument outside the allowlist', () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const rel = relative(REPO, abs).replace(/\\/g, '/');
      const hits = findLiteralHistoryCalls(readFileSync(abs, 'utf8'));
      const allowed = ALLOWLIST.find((a) => a.file === rel);
      if (!hits.length && !allowed) continue;
      if (!allowed) { offenders.push(`${rel}: ${hits.length} literal history arg(s)`); continue; }
      if (hits.length !== allowed.count) {
        offenders.push(`${rel}: expected ${allowed.count} allowlisted literal(s), found ${hits.length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /* Neutralisation proof — without this, a scanner that silently matched
     NOTHING (a broken path, a renamed call, a regex that never fires) would
     pass this suite green forever while defending nothing. */
  it('actually detects a violation', () => {
    const violating = `
      const r = buildCastResolver(cast, { supersededBy: history.supersededBy });
    `;
    expect(findLiteralHistoryCalls(violating)).toHaveLength(1);
  });

  it('does not fire on the correct shape', () => {
    expect(findLiteralHistoryCalls('const r = buildCastResolver(cast, castIdHistory);')).toEqual([]);
    expect(findLiteralHistoryCalls('isAudioCurrent(resolution, seg, castIdHistory);')).toEqual([]);
  });

  it('is not fooled by a nested call or an object in an EARLIER argument', () => {
    expect(findLiteralHistoryCalls('buildCastResolver(pick({ id: 1 }), castIdHistory);')).toEqual([]);
    expect(findLiteralHistoryCalls('isAudioCurrent(resolve(id), { castHistorySeq: 3 }, history);')).toEqual([]);
  });

  it('ignores a call quoted in a comment or a string', () => {
    expect(findLiteralHistoryCalls('// buildCastResolver(cast, { supersededBy: {} })')).toEqual([]);
    expect(findLiteralHistoryCalls('/* buildCastResolver(cast, { supersededBy: {} }) */')).toEqual([]);
    expect(findLiteralHistoryCalls('const s = "buildCastResolver(cast, { supersededBy: {} })";')).toEqual([]);
  });
});
```

**`globSync` is not available on Node 20** (`fs.globSync` landed in 22) — round 1 (M17).
Do not write it. `server/src/workspace/cast-lock.guard.test.ts` already walks `server/src`
recursively; **copy that walker** rather than adding a dependency or a second import from
`node:fs` (a duplicate `import … from 'node:fs'` also trips `no-duplicate-imports`).

- [ ] **Step 2: Run guard 3 and watch it fail on the real tree**

Run: `cd server && npx vitest run src/store/cast-history-threading.guard.test.ts`
Expected: FAIL on `scripts/repair-cast-id-drift.mjs` — **2** literals found, 1 allowlisted.

- [ ] **Step 3: Fix `planBookRepairs`'s `historyResolver` rather than allowlisting it**

`main()` already loads the whole object (`repair-cast-id-drift.mjs:2335`) and
`collectSegmentOrphans` already threads it whole (`:2170`), so the correct object is in
scope. Replace **`:829-835`** — `:829` is `const historyResolver =` and `:835` is the
closing `});`, so the spec's `:830-834` leaves a dangling assignment and an orphan `});`
(round 1, I5; the spec §1 carries the same error):

```js
  const historyResolver =
    input.historyResolver ?? buildCastResolver(liveCast, history);
```

and replace the round-4 MUST-2 comment above it with:

```js
  // #2128, guard 3 (spine rule 2): the WHOLE loaded `CastIdHistory` goes in,
  // never a hand-built subset. Round 4's defended `{supersededBy, rejected,
  // rejectedPairs}` object was correct on the day it was written and would have
  // gone stale again the moment a new optional field landed — which is exactly
  // what #2128's `recordedAtSeq` is. A subset that silently drops it makes
  // every alias in the book read 'unknown' forever.
```

- [ ] **Step 4: Run guard 3 to verify it passes**

Run: `cd server && npx vitest run src/store/cast-history-threading.guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Write guard 5 — the stamp pairing**

Create `server/src/store/cast-id-history.stamp.guard.test.ts`:

```ts
/* Guard 5 (#2128) — every write to `cast-id-history.json` goes through
   `bumpSeqAndStamp`, so `seq` and the markers can never drift from
   `supersededBy`.

   MATCHES INDEXED ASSIGNMENT ONLY. A naive `supersededBy\[[^\]]+\]\s*=` also
   matches `historyBeforeReject.supersededBy[orphanedId] === characterId`
   (cast-reject-orphan.ts) — a COMPARISON, correct code, which a guard reddening
   on it would send an implementer to "fix". The `=` must not be followed by
   another `=`.

   BLIND SPOT: call-graph blind and single-file. It asserts that
   cast-id-history.ts's own writes are paired; a future writer in another module
   that imports `writeJsonAtomic` and `castIdHistoryPath` directly is not seen. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'cast-id-history.ts'), 'utf8');

/** Indexed assignment, never comparison. */
export const ASSIGN_RE = /supersededBy\[[^\]]+\]\s*=(?!=)/g;
const WRITE_RE = /await writeJsonAtomic\(castIdHistoryPath/g;
const STAMP_RE = /bumpSeqAndStamp\(/g;

/** Split the module at top-level `function`/`export ... function` boundaries,
 *  so "this write is paired with a stamp" is asked PER FUNCTION rather than
 *  over the whole file — a file-wide count is satisfied by nine stamps in one
 *  writer and none in the other eight. */
export function topLevelFunctions(src: string): Array<{ name: string; body: string }> {
  const starts: Array<{ name: string; at: number }> = [];
  const re = /^(?:export )?(?:async )?function (\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) starts.push({ name: m[1], at: m.index });
  return starts.map((s, i) => ({
    name: s.name,
    body: src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length),
  }));
}

describe('guard 5 — the stamp pairing (#2128)', () => {
  const fns = topLevelFunctions(SRC);

  /* Round 1 (C2): the first version of this guard applied ASSIGN_RE only to
     synthetic strings and asserted two file-wide integers, so it checked
     nothing it claimed and was red as written. These three assertions run
     against the real module. */

  it('finds the write sites at all — a scan matching nothing must not pass green', () => {
    expect(SRC.match(WRITE_RE)?.length ?? 0).toBeGreaterThanOrEqual(9);
    expect(SRC.match(ASSIGN_RE)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('pairs every writing function with a bumpSeqAndStamp before its write', () => {
    const unpaired = fns
      .filter((f) => new RegExp(WRITE_RE.source).test(f.body))
      .filter((f) => {
        const writeAt = f.body.search(new RegExp(WRITE_RE.source));
        const stampAt = f.body.search(new RegExp(STAMP_RE.source));
        return stampAt < 0 || stampAt > writeAt;
      })
      .map((f) => f.name);
    expect(unpaired).toEqual([]);
  });

  it('leaves no supersededBy ASSIGNMENT in a function that never stamps', () => {
    const unstamped = fns
      .filter((f) => new RegExp(ASSIGN_RE.source).test(f.body))
      .filter((f) => !new RegExp(STAMP_RE.source).test(f.body))
      .map((f) => f.name);
    // `bumpSeqAndStamp` itself assigns into its own maps, not `supersededBy`.
    expect(unstamped).toEqual([]);
  });

  it('matches an indexed ASSIGNMENT', () => {
    expect('history.supersededBy[from] = to;'.match(ASSIGN_RE)).toHaveLength(1);
    expect('h.supersededBy[key] = resolvedTo;'.match(ASSIGN_RE)).toHaveLength(1);
  });

  it('does NOT fire on a comparison — cast-reject-orphan.ts:357 is correct code', () => {
    expect('historyBeforeReject.supersededBy[orphanedId] === characterId'.match(ASSIGN_RE)).toBeNull();
    expect('if (history.supersededBy[to] === from) {'.match(ASSIGN_RE)).toBeNull();
  });
});
```

**Neutralisation proof, run by hand and recorded in the commit body:** delete the
`bumpSeqAndStamp(...)` call from `forgetSupersededId` and confirm the pairing test names
`forgetSupersededId`; move a `bumpSeqAndStamp` call to *after* its `writeJsonAtomic` and
confirm the same test still catches it. If either mutation stays green, the guard is
inert and must be fixed before the task closes.

**Note the blind spot this shape keeps:** `restoreSupersededId` has an assignment AND a
stamp, but its two early returns write nothing — the function-level pairing cannot tell a
stamped early return from an unstamped one. That case is covered by Task 2's
"restoreSupersededId's early returns leave markers untouched" behavioural test, not here.

- [ ] **Step 6: Run both guards and the full store suite**

Run: `cd server && npx vitest run src/store/`
Expected: PASS.

- [ ] **Step 7: Wire both guards into the verify battery**

A guard test is not wired until it runs where it must. Check `scripts/verify.mjs`'s
`extraFiles` / step-input hashes and `.github/workflows/verify.yml`'s scope regex — both
new files live under `server/src/store/`, which the existing `test:server` leg already
covers, so **confirm** that is true rather than assuming it. If `server/src/store/**` is
already in the server leg's input globs, no change is needed; say so explicitly in the
commit body.

- [ ] **Step 8: Commit**

```bash
git add server/src/store/cast-history-threading.guard.test.ts \
        server/src/store/cast-id-history.stamp.guard.test.ts \
        scripts/repair-cast-id-drift.mjs
git commit -m "test(server): guard whole-history threading and the stamp pairing (#2128)"
```

---

### Task 6: The render-side stamp — `castHistorySeq`

**Files:**
- Modify: `server/src/audio/finalize-chapter-write.ts:49-61` (`ChapterSegmentsFile`),
  `:63+` (`FinalizeChapterAudioInput`), `:324-335` (the built object)
- Modify: `server/src/audio/segments-io.ts` — `SegmentsFile` is `:51-96`; insert after
  `synthesizedAt` at `:54`
- Modify: `server/src/routes/generation.ts:1873`
- Modify: `server/src/routes/chapter-qa-repair.ts:689`, `server/src/routes/chapter-splice.ts:483`
- Test: `server/src/audio/finalize-chapter-write.test.ts`,
  `server/src/routes/chapter-splice.test.ts`, `server/src/routes/chapter-qa-repair.test.ts`

**Interfaces:**
- Consumes: Task 2's `history.seq`.
- Produces: `castHistorySeq?: number` on both segments-file declarations, and
  `castHistorySeq?: number` on `FinalizeChapterAudioInput`. Tasks 7 and 9 read it.

**Why not `synthesizedAt`.** Two independent reasons, both fatal:

1. **It does not mean what it looks like.** `finalizeChapterAudioWrite` is the sole
   non-test writer of `<slug>.segments.json` and unconditionally refreshes `synthesizedAt`
   (`:331`), but it has **three** callers and only one is a full chapter render. A
   one-sentence QA repair or a splice rewrites the whole file and refreshes the stamp
   while leaving every other segment byte-identical.
2. **It cannot speak to `'normalised-id'` at all.** That tier has no history entry; its
   hazard is "the render predates the resolver existing".

**Spec correction (see "Situation on the ground").** Only **two** declarations carry the
field. `generation.ts` has no local segments-file interface — the doc comment at
`finalize-chapter-write.ts:49-50` claiming it mirrors one is stale and gets corrected here.

- [ ] **Step 1: Write the failing tests**

In `server/src/audio/finalize-chapter-write.test.ts`:

```ts
it('writes the castHistorySeq the caller resolved against (#2128)', async () => {
  await finalizeChapterAudioWrite({ ...baseInput, castHistorySeq: 7 });
  const written = JSON.parse(readFileSync(segPath, 'utf8'));
  expect(written.castHistorySeq).toBe(7);
});

it('writes castHistorySeq 0 as a real value, not an omission (#2128)', async () => {
  await finalizeChapterAudioWrite({ ...baseInput, castHistorySeq: 0 });
  const written = JSON.parse(readFileSync(segPath, 'utf8'));
  expect(written).toHaveProperty('castHistorySeq', 0);
});

it('omits castHistorySeq entirely when the caller supplies none', async () => {
  await finalizeChapterAudioWrite(baseInput);
  const written = JSON.parse(readFileSync(segPath, 'utf8'));
  expect(written).not.toHaveProperty('castHistorySeq');
});
```

In `server/src/routes/chapter-splice.test.ts` and
`server/src/routes/chapter-qa-repair.test.ts` — **the tests that protect the false
negative the whole redesign exists to prevent**:

```ts
it('carries the prior castHistorySeq forward and never refreshes it (#2128)', async () => {
  await writeSegmentsFile({ ...priorSegments, castHistorySeq: 3 });
  await runTheSplice();               // (or runTheRepair())
  const after = JSON.parse(readFileSync(segPath, 'utf8'));
  // A partial rewrite must NOT launder a stale row into looking current.
  expect(after.castHistorySeq).toBe(3);
  // `synthesizedAt` still refreshes — that is its existing, unchanged meaning.
  expect(after.synthesizedAt).not.toBe(priorSegments.synthesizedAt);
});

it('omits castHistorySeq when the prior file had none (#2128)', async () => {
  await writeSegmentsFile({ ...priorSegments, castHistorySeq: undefined });
  await runTheSplice();
  expect(JSON.parse(readFileSync(segPath, 'utf8'))).not.toHaveProperty('castHistorySeq');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/audio/finalize-chapter-write.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts -t "#2128"`
Expected: FAIL — the field does not exist.

- [ ] **Step 3: Add the field to both declarations**

`finalize-chapter-write.ts` — correct the stale doc comment and add the field:

```ts
/** Strict on-disk shape of `<slug>.segments.json` (the write view; the loose
    read view lives in segments-io.ts). */
export interface ChapterSegmentsFile {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  durationSec: number;
  sampleRate: number;
  modelKey: TtsModelKey;
  synthesizedAt: string;
  /** #2128 — the `seq` of the `cast-id-history.json` state THIS render
      resolved against. Written ONLY by the full-render path
      (`generation.ts`); `chapter-qa-repair.ts` and `chapter-splice.ts` carry
      the prior file's value forward verbatim, because they rewrite the whole
      file while leaving most segments byte-identical, and refreshing this
      would launder a stale row into looking current.

      `0` is a VALID value, not an absent one. Absent means the render predates
      this stamp, which `isAudioCurrent` reads as 'unknown' — and 'unknown'
      lists. Deliberately NOT `synthesizedAt`, which the two partial writers
      DO refresh and which cannot speak to the `'normalised-id'` tier at all
      (that tier has no history entry; its hazard is a render predating the
      resolver, which this field's mere presence proves). */
  castHistorySeq?: number;
  segments: ChapterSegment[];
  characterSnapshots?: Record<string, CharacterSnapshot>;
  qa?: ChapterQaVerdict;
}
```

Add to `FinalizeChapterAudioInput` (near `expectedSec`):

```ts
  /** #2128 — see `ChapterSegmentsFile.castHistorySeq`. Supplied by the
      full-render path from the history it actually built its resolver from;
      carried forward verbatim by the two partial writers. */
  castHistorySeq?: number;
```

And in the built object (`:324-335`), after `synthesizedAt`:

```ts
    ...(input.castHistorySeq === undefined ? {} : { castHistorySeq: input.castHistorySeq }),
```

The spread form (rather than `castHistorySeq: input.castHistorySeq`) is what keeps the
key **absent** rather than `undefined` when there is none — `JSON.stringify` drops an
`undefined` value anyway, but the spread makes the intent explicit and survives a future
change of serialiser.

`segments-io.ts` — add to `SegmentsFile` after `synthesizedAt`:

```ts
  /** #2128 — the `cast-id-history.json` `seq` this render resolved against.
      Mirrors `finalize-chapter-write.ts`'s `ChapterSegmentsFile` (the write
      view). Absent on every render that predates the stamp; `0` is valid. */
  castHistorySeq?: number;
```

- [ ] **Step 4: Wire the full-render path**

`generation.ts:1873` — `castIdHistory` is already in scope at `:1630`, loaded once per
chapter render, and `synthesiseChapter` builds the file's only `buildCastResolver` from it
(`synthesise-chapter.ts:1510`), so the resolver is never rebuilt mid-chapter. Add to the
`finalizeChapterAudioWrite({...})` argument object:

```ts
        /* #2128 — the seq this chapter actually RESOLVED against: the same
           `castIdHistory` object loaded at the top of this render and threaded
           into `synthesiseChapter`, whose `buildCastResolver` call is the only
           one in that file. Stamping the state the render read (rather than
           re-reading the file here) is what closes the mid-render window: a
           long chapter whose alias is recorded while it renders still records
           the state its own bytes were produced from. */
        castHistorySeq: castIdHistory.seq ?? 0,
```

- [ ] **Step 5: Wire the two partial writers**

`chapter-qa-repair.ts:689` and `chapter-splice.ts:483` — both already read the prior file
into `segFile` (`chapter-qa-repair.ts:128`, `chapter-splice.ts:155`). Add to each
`finalizeChapterAudioWrite({...})` call:

```ts
        /* #2128 — carried forward verbatim, never refreshed. This path
           re-synthesises SOME sentences against the current resolver, correctly,
           but leaves every other segment byte-identical; refreshing the stamp
           would clear the whole chapter's row on the strength of a one-sentence
           repair. Fail-closed and deliberate — see plan 280's known limit 1. */
        castHistorySeq: segFile.castHistorySeq,
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd server && npx vitest run src/audio/finalize-chapter-write.test.ts src/routes/chapter-splice.test.ts src/routes/chapter-qa-repair.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutate**

Change the two partial writers to `castHistorySeq: (await loadCastIdHistory(bookDir)).seq`
and confirm both carry-forward tests redden. This is the false negative the whole §2
redesign exists to prevent — if the test does not redden, the test is wrong, not the
mutant.

- [ ] **Step 8: Commit**

```bash
git add server/src/audio/finalize-chapter-write.ts server/src/audio/segments-io.ts \
        server/src/routes/generation.ts server/src/routes/chapter-qa-repair.ts \
        server/src/routes/chapter-splice.ts server/src/audio/finalize-chapter-write.test.ts \
        server/src/routes/chapter-splice.test.ts server/src/routes/chapter-qa-repair.test.ts
git commit -m "feat(server): stamp the resolved cast-history seq on a full chapter render (#2128)"
```

---

### Task 7: #2129 server side — `audioCurrent` on the banner payload

**Files:**
- Modify: `server/src/audio/segments-io.ts:103-139` (`OrphanedCharacterFallback`),
  `:338-343` (the signature), `:366-427` (the collector loop)
- Modify: `openapi.yaml:7548-7586`; regenerate `src/lib/api-types.ts`
- Modify: `src/lib/types.ts:457-468`, `src/store/cast-slice.ts:61-73`
- Test: `server/src/audio/segments-io.test.ts`

**Interfaces:**
- Consumes: `isAudioCurrent` / `aggregateAudioCurrency` (Task 4), `SegmentsFile.castHistorySeq` (Task 6).
- Produces: `OrphanedCharacterFallback.audioCurrent: true | false | 'unknown'` on the wire,
  mirrored into `src/store/cast-slice.ts`'s `OrphanedCharacterFallback`. Task 8 renders it.

**The divergence being closed.** `segments-io.ts:388-392` tags `'history'` and
`'normalised-history'` as `'alias'`; `cast.tsx:304-307` files anything `!== 'unresolved'`
into a collapsed "N character ids auto-reconciled" disclosure. `buildOrphansFromSegments`
exempts **only** `'exact'`, so the same ids are listed as damage. An operator sees
"auto-reconciled, nothing to do" for `the-torment` while the repair pass lists 67 of its
segments.

`resolution` and its three values are **untouched** — the reject/undo chips and their
tests are unaffected. `audioCurrent` is a new axis alongside it.

- [ ] **Step 1: Write the failing test**

Add to `server/src/audio/segments-io.test.ts`:

```ts
describe('collectOrphanedCharacterFallbacks — audioCurrent (#2129)', () => {
  it('reports an alias-resolved id whose render predates its marker as NOT current', async () => {
    const dir = await bookWithSegments([
      { chapterId: 1, castHistorySeq: 1, segments: [{ characterId: 'mayrin' }] },
    ]);
    const out = await collectOrphanedCharacterFallbacks(dir, chapters, [{ id: 'mairin' }], {
      schema: 1,
      supersededBy: { mayrin: 'mairin' },
      seq: 4,
      recordedAtSeq: { mayrin: 3 },
    });
    expect(out.mayrin.resolution).toBe('alias');   // unchanged axis
    expect(out.mayrin.audioCurrent).toBe(false);   // new axis
  });

  it('reports an alias-resolved id re-rendered above its marker as current', async () => {
    const dir = await bookWithSegments([
      { chapterId: 1, castHistorySeq: 5, segments: [{ characterId: 'mayrin' }] },
    ]);
    const out = await collectOrphanedCharacterFallbacks(dir, chapters, [{ id: 'mairin' }], {
      schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 },
    });
    expect(out.mayrin.audioCurrent).toBe(true);
  });

  it('reports unknown for a render with no stamp at all', async () => {
    const dir = await bookWithSegments([{ chapterId: 1, segments: [{ characterId: 'mayrin' }] }]);
    const out = await collectOrphanedCharacterFallbacks(dir, chapters, [{ id: 'mairin' }], {
      schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 4, recordedAtSeq: { mayrin: 3 },
    });
    expect(out.mayrin.audioCurrent).toBe('unknown');
  });

  it('aggregates across chapters — stale in ANY chapter is not current', async () => {
    const dir = await bookWithSegments([
      { chapterId: 1, castHistorySeq: 5, segments: [{ characterId: 'mayrin' }] },
      { chapterId: 2, castHistorySeq: 1, segments: [{ characterId: 'mayrin' }] },
    ]);
    const out = await collectOrphanedCharacterFallbacks(dir, chapters2, [{ id: 'mairin' }], {
      schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 },
    });
    expect(out.mayrin.segments).toBe(2);
    expect(out.mayrin.audioCurrent).toBe(false);
  });

  it('leaves resolution and rejectedAgainst untouched', async () => {
    // Pin the #2092/#2089 axis so the split cannot regress the chips.
    const dir = await bookWithSegments([{ chapterId: 1, segments: [{ characterId: 'mayrin' }] }]);
    const out = await collectOrphanedCharacterFallbacks(dir, chapters, [{ id: 'mairin' }], {
      schema: 1, supersededBy: {}, rejectedPairs: [{ from: 'mayrin', to: 'mairin' }],
    });
    expect(out.mayrin.resolution).toBe('unresolved');
    expect(out.mayrin.rejectedAgainst).toEqual(['mairin']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/audio/segments-io.test.ts -t "#2129"`
Expected: FAIL — `audioCurrent` is `undefined`.

- [ ] **Step 3: Add the field and widen the parameter**

In `segments-io.ts`, add to `OrphanedCharacterFallback` after `segments`:

```ts
  /** #2129 / #2128 — whether this orphaned id's RENDERED AUDIO is still
      current, as opposed to whether the id currently RESOLVES (`resolution`,
      above). The two are different questions and #2129 is what it looks like
      when they are answered by two different pieces of code: the banner said
      "auto-reconciled, nothing to do" for `the-torment` while the repair pass
      listed 67 of its segments as damage.

      Computed by `isAudioCurrent` (store/cast-audio-currency.ts) — the SAME
      function `repair-cast-id-drift.mjs` calls, per plan 278's invariant 7 —
      and aggregated across every rendered chapter by `aggregateAudioCurrency`:
      `false` if any chapter is `false`, else `'unknown'` if any is
      `'unknown'`, else `true`.

      `'unknown'` means the comparison could not be made (the render predates
      the stamp, or the history file predates the one-shot stamp) and is
      presented as needing a re-render, not as fine. Only `true` clears a row. */
  audioCurrent: AudioCurrency;
```

with `import type { AudioCurrency } from '../store/cast-audio-currency.js';` at the top
(and the value import of `isAudioCurrent` / `aggregateAudioCurrency`).

Widen the collector's parameter — Global Constraint 2. `book-state.ts:480` already loads
and passes the whole `CastIdHistory`, so **no caller changes**:

```ts
export async function collectOrphanedCharacterFallbacks(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
  cast: ReadonlyArray<{ id: string }>,
  /* #2128 — the WHOLE loaded object, not a `Pick`. `isAudioCurrent` reads
     `recordedAtSeq`/`seq`, and every field this lane added is optional, so a
     narrowed parameter type would keep compiling while dropping the markers
     and reading every alias as 'unknown' forever. Guard 3
     (store/cast-history-threading.guard.test.ts) enforces the call-site half. */
  castIdHistory: CastIdHistory,
): Promise<Record<string, OrphanedCharacterFallback>> {
```

- [ ] **Step 4: Compute and aggregate in the loop**

Inside the segment loop, after `resolutionTag` is computed:

```ts
      const currency = isAudioCurrent(resolution, seg, castIdHistory);
```

and in the `out[s.characterId] = { … }` object, after `segments`:

```ts
        /* Folded pairwise rather than collected into an array first — the
           aggregation rule is associative, and an id can span every chapter in
           a 60-chapter book. `aggregateAudioCurrency` is still the ONE place
           the rule lives. */
        audioCurrent: existing
          ? aggregateAudioCurrency([existing.audioCurrent, currency])
          : currency,
```

- [ ] **Step 5: Add it to the OpenAPI contract**

`openapi.yaml` — inside `orphanedCharacterFallbacks.additionalProperties.properties`,
after `segments` (and add `audioCurrent` to the `required` list alongside
`resolution, segments`):

```yaml
              audioCurrent:
                type: string
                enum: ['true', 'false', 'unknown']
                description: |
                  #2129/#2128 — whether this orphaned id's RENDERED AUDIO is
                  still current, as opposed to whether the id currently
                  RESOLVES (`resolution`). `true` only when every rendered
                  chapter carrying this id was rendered against the
                  cast-id-history state that established its current target;
                  `unknown` when the comparison cannot be made (a render
                  predating the stamp, or a history file predating the
                  one-shot back-fill). `unknown` is presented as needing a
                  re-render, not as fine — only `true` clears a row.
```

**Decision, pinned:** the wire type is a **string enum**, not `boolean | string`. OpenAPI
cannot express `true | false | 'unknown'` as one scalar without a `oneOf`, which
`openapi-typescript` renders as an awkward union and which every consumer would have to
narrow.

**The frontend does NOT parse it back.** It stays `'true' | 'false' | 'unknown'` all the
way through `src/lib/types.ts`, `src/store/cast-slice.ts` and `src/views/cast.tsx`, whose
filters compare against the string `'true'`. Round 1 (I14): the first draft said the
frontend "parses it back at the slice boundary" while declaring the mirrors as strings —
an implementer who followed the prose would have inverted both of Task 8's buckets, since
`false === 'true'` is always false. **Server side is `AudioCurrency`; wire and frontend are
strings; the boundary is `book-state.ts` and nowhere else.**

Convert at the route boundary, not in the collector — the collector's own type stays
`AudioCurrency` for the repair-pass consumer, which imports it directly:

```ts
    /* The `.catch(() => ({}))` must be INSIDE the awaited call and typed, or
       the result widens to `Record<…> | {}` and `v` will not narrow (round 1,
       M19). Annotating the local is the smallest fix. */
    const rawFallbacks: Record<string, OrphanedCharacterFallback> =
      await collectOrphanedCharacterFallbacks(
        bookDir,
        state.chapters,
        (cast?.characters ?? []) as Array<{ id: string }>,
        orphanedCharacterFallbackHistoryFile,
      ).catch(() => ({}));
    const orphanedCharacterFallbacks = Object.fromEntries(
      Object.entries(rawFallbacks).map(([id, v]) => [
        id,
        { ...v, audioCurrent: String(v.audioCurrent) },
      ]),
    );
```

- [ ] **Step 6: Regenerate the types and update both hand-written mirrors**

Run: `npm run openapi:types`

Then update `src/lib/types.ts:457-468` and `src/store/cast-slice.ts:61-73`, adding to each:

```ts
  /** #2129 — whether this orphaned id's rendered AUDIO is still current, as
      opposed to whether the id resolves (`resolution`). `'unknown'` means the
      comparison could not be made and is presented as needing a re-render. */
  audioCurrent: 'true' | 'false' | 'unknown';
```

**Do not hand-edit `src/lib/api-types.ts`** — it is generated. If the regeneration
produces no diff, the `openapi.yaml` edit did not land in a schema position; fix the YAML
rather than the output.

- [ ] **Step 6b: Update the two optimistic reject/undo reducers**

Round 1 (I13). `src/store/cast-slice.ts`'s `applyOrphanRejection` (`:642-660`) and
`undoOrphanRejection` (`:671-689`) rewrite `entry.resolution` and
`entry.resolvedCharacterId` from the server's response but never touch `audioCurrent`.
That reproduces **the exact divergence #2129 is**, one layer up: per known limit 2,
`restoreSupersededId` stamps the current `seq`, so after an Undo the server's next
`audioCurrent` is `'false'` — yet the row re-enters the auto-reconciled bucket carrying its
stale pre-reject value and is filed under "audio is current" until the next hydrate.

The reducers cannot compute currency (they have no history and no segments files), and
guessing would be a second answer. **Set it to `'unknown'`** in both, which the bucketing
already treats as needs-a-re-render — fail-closed, and correct on the next hydrate:

```ts
      /* #2129 — a reject/undo changes what this id RESOLVES to, which can also
         change whether its rendered audio is current; this reducer cannot know
         which (no history, no segments files here). `'unknown'` is the honest
         value and buckets as needs-a-re-render, so the optimistic update can
         never claim "audio is current" on the strength of a stale field. The
         next book-state hydrate replaces it with the server's real verdict. */
      entry.audioCurrent = 'unknown';
```

with a slice test per reducer asserting the field moves to `'unknown'` and a
`cast.test.tsx` case asserting the row lands in the needs-a-re-render section after an
Undo.

- [ ] **Step 7: Run the server and frontend suites**

Run: `cd server && npx vitest run src/audio/segments-io.test.ts src/routes/book-state.test.ts`
then `npm run typecheck && npm test`
Expected: PASS. `audioCurrent` is **required**, so every frontend fixture that builds an
`OrphanedCharacterFallback` needs the field — expect compile errors and fix each fixture
rather than making the field optional.

- [ ] **Step 8: Mutate**

Flip the aggregation to "any true ⇒ true" and confirm the cross-chapter test reddens.
Change `'unknown'` to `true` at the collector and confirm the no-stamp test reddens.

- [ ] **Step 9: Commit**

```bash
git add server/src/audio/segments-io.ts server/src/routes/book-state.ts openapi.yaml \
        src/lib/api-types.ts src/lib/types.ts src/store/cast-slice.ts \
        server/src/audio/segments-io.test.ts
git commit -m "feat(server): report per-orphan audio currency on the book-state payload (#2129)"
```

---

### Task 8: #2129 frontend — the auto-reconciled disclosure splits

**Files:**
- Modify: `src/views/cast.tsx:304-312` (the two `useMemo` buckets) and the disclosure JSX below it
- Test: `src/views/cast.test.tsx`, `e2e/orphaned-character-fallback-banner.spec.ts`

**Interfaces:**
- Consumes: `OrphanedCharacterFallback.audioCurrent` (Task 7).
- Produces: nothing.

**Requirement (spec §6).** The single auto-reconciled disclosure becomes two, both
collapsed, each showing its count in its own header — so the actionable count is legible
**without expanding anything**. Three sections total, counting needs-decision.

**Bucketing decision, pinned:** `audioCurrent === 'true'` → "audio is current";
`'false'` and `'unknown'` → "audio needs a re-render". Two buckets, not three:
`'unknown'` is *actionable in the same way* (re-render the chapter), and a third section
for it would put a distinction the operator cannot act on differently into the primary
navigation. The per-row detail still says which it is.

- [ ] **Step 1: Write the failing test**

Add to `src/views/cast.test.tsx`:

```tsx
const orphan = (over: Partial<OrphanedCharacterFallback>): OrphanedCharacterFallback => ({
  resolution: 'alias',
  resolvedCharacterId: 'mairin',
  segments: 3,
  audioCurrent: 'true',
  ...over,
});

it('splits the auto-reconciled disclosure by audio currency (#2129)', async () => {
  renderCast({
    orphanedCharacterFallbacks: {
      fine: orphan({ audioCurrent: 'true' }),
      stale: orphan({ audioCurrent: 'false', segments: 67 }),
      dunno: orphan({ audioCurrent: 'unknown', segments: 1 }),
      missing: orphan({ resolution: 'unresolved', resolvedCharacterId: undefined, audioCurrent: 'false' }),
    },
  });

  // Both auto-reconciled sections are COLLAPSED and both counts are readable.
  expect(screen.getByText(/1 character id auto-reconciled — audio is current/i)).toBeInTheDocument();
  expect(screen.getByText(/2 character ids auto-reconciled — audio needs a re-render/i)).toBeInTheDocument();
  // The needs-decision section is untouched by this change.
  expect(screen.getByText(/1 character id needs your decision/i)).toBeInTheDocument();
});

it('keeps the actionable count visible without expanding anything (#2129)', () => {
  renderCast({
    orphanedCharacterFallbacks: { stale: orphan({ audioCurrent: 'false', segments: 67 }) },
  });
  // No click. The number an operator acts on must be in the collapsed header.
  expect(screen.getByText(/1 character id auto-reconciled — audio needs a re-render/i)).toBeInTheDocument();
  expect(screen.queryByText(/67 segments/i)).not.toBeInTheDocument(); // detail stays inside
});

it('buckets unknown with needs-a-re-render, never with current (#2129)', () => {
  renderCast({ orphanedCharacterFallbacks: { dunno: orphan({ audioCurrent: 'unknown' }) } });
  expect(screen.queryByText(/audio is current/i)).not.toBeInTheDocument();
  expect(screen.getByText(/audio needs a re-render/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/views/cast.test.tsx -t "#2129"`
Expected: FAIL — one combined disclosure renders.

- [ ] **Step 3: Split the bucket**

In `src/views/cast.tsx`, replace the `autoReconciledOrphans` memo (`:304-307`):

```tsx
  /* #2129 — the auto-reconciled bucket splits by AUDIO CURRENCY, a different
     question from `resolution`. Before this split, an id that resolves through
     the id-history side-table was filed as "auto-reconciled, nothing to do"
     while `repair-cast-id-drift.mjs` listed every one of its rendered segments
     as damage — two surfaces, two answers, same id. Both now read
     `audioCurrent`, which the server computes with the SAME predicate the
     repair pass calls (plan 278 invariant 7, extended from ranking to
     currency).

     `'unknown'` buckets with `'false'`: the operator's action is identical
     (re-render the chapter), so a third top-level section would encode a
     distinction they cannot act on differently. The per-row detail still says
     which it is. */
  const autoReconciledCurrent = useMemo(
    () => orphanedEntries.filter(([, v]) => v.resolution !== 'unresolved' && v.audioCurrent === 'true'),
    [orphanedEntries],
  );
  const autoReconciledStale = useMemo(
    () => orphanedEntries.filter(([, v]) => v.resolution !== 'unresolved' && v.audioCurrent !== 'true'),
    [orphanedEntries],
  );
```

and give each its own `useState` toggle, replacing the single `autoReconciledOpen`:

```tsx
  const [autoReconciledCurrentOpen, setAutoReconciledCurrentOpen] = useState(false);
  const [autoReconciledStaleOpen, setAutoReconciledStaleOpen] = useState(false);
```

- [ ] **Step 4: Render two disclosures**

The existing block is `src/views/cast.tsx:1275` through the close of its wrapper `<div>`
(immediately before the `{isNonEnglish && (` banner at `:1370`). **Extract it into a local
component and render it twice** — a second hand-written copy is the duplicate-logic shape
this whole lane exists to close.

**Three details in that block must become per-section, not shared** — copying it verbatim
twice ships a real a11y defect:

| Currently | Must become |
|---|---|
| `id="orphaned-auto-reconciled-list"` on the `<ul>` | unique per section — a duplicate `id` makes `aria-controls` ambiguous and the second one unreachable |
| `aria-controls={autoReconciledOpen ? 'orphaned-auto-reconciled-list' : undefined}` | points at that section's own id |
| `data-testid="orphaned-auto-reconciled"` | unique per section, or `getByTestId` throws on multiple matches |

```tsx
  /* #2129 — ONE component, rendered twice. The body (per-row markup, the reject
     chips, the resolved-name lookup) is identical between the two sections; only
     the entry list, the headline and the disclosure ids differ. A hand-copied
     second block is what lets the two drift, which is the same defect shape one
     level up from the one this whole lane closes. */
  function AutoReconciledSection({
    entries, open, onToggle, headline, slug, showTopBorder,
  }: {
    entries: Array<[string, OrphanedCharacterFallback]>;
    open: boolean;
    onToggle: () => void;
    headline: string;
    slug: string;               // 'current' | 'stale' — makes every id unique
    showTopBorder: boolean;
  }) {
    if (!entries.length) return null;
    const listId = `orphaned-auto-reconciled-${slug}-list`;
    return (
      <div className={showTopBorder ? 'border-t border-amber-200/60' : ''}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className="w-full min-h-[44px] fine-pointer:min-h-0 flex items-center justify-between gap-2 p-4 text-left"
        >
          {/* NOT role="status" — fix round 3: a live-region role on the
              button's only text leaves the button with no accessible name at
              all. Carried over verbatim from the block being replaced.

              The COUNT lives in the collapsed header: an operator must be able
              to read how much work is outstanding without expanding anything. */}
          <span className="text-sm font-semibold text-ink/80">
            {entries.length} character id{entries.length === 1 ? '' : 's'} {headline}
          </span>
          <IconChevR
            className={`w-3.5 h-3.5 text-ink/50 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </button>
        {open && (
          <ul
            id={listId}
            data-testid={`orphaned-auto-reconciled-${slug}`}
            className="flex flex-col gap-2 px-4 pb-4"
          >
            {/* The per-row <li> body from :1317-~1365, moved verbatim — the
                resolvedName lookup, the segment count, the reject/undo chips.
                Do not restyle it; do not change what it renders. */}
          </ul>
        )}
      </div>
    );
  }
```

then render both at `:1275`, current first:

```tsx
            <AutoReconciledSection
              entries={autoReconciledCurrent}
              open={autoReconciledCurrentOpen}
              onToggle={() => setAutoReconciledCurrentOpen((o) => !o)}
              headline="auto-reconciled — audio is current"
              slug="current"
              showTopBorder={needsDecisionOrphans.length > 0}
            />
            <AutoReconciledSection
              entries={autoReconciledStale}
              open={autoReconciledStaleOpen}
              onToggle={() => setAutoReconciledStaleOpen((o) => !o)}
              headline="auto-reconciled — audio needs a re-render"
              slug="stale"
              showTopBorder={needsDecisionOrphans.length > 0 || autoReconciledCurrent.length > 0}
            />
```

Preserve the 44px touch target verbatim (CLAUDE.md's mobile protocol —
`min-h-[44px] fine-pointer:min-h-0`, never `sm:min-h-0`). Do not restyle anything else in
this file. **Any existing test or e2e selector using `data-testid="orphaned-auto-reconciled"`
must be updated** — grep for it before running the suite.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/views/cast.test.tsx`
Expected: PASS, including every pre-existing reject/undo-chip test.

- [ ] **Step 6: Extend the e2e spec**

This crosses router/redux/layout seams, which is CLAUDE.md's stated bar for a Playwright
spec. In `e2e/orphaned-character-fallback-banner.spec.ts`, add a case asserting both
section headers render with their counts while collapsed, driven by the mock payload.

Run: `npm run test:e2e -- orphaned-character-fallback-banner`

- [ ] **Step 7: Mutate**

Change the stale filter to `v.audioCurrent === 'false'` (dropping `'unknown'`) and confirm
the unknown-bucketing test reddens.

- [ ] **Step 8: Commit**

```bash
git add src/views/cast.tsx src/views/cast.test.tsx e2e/orphaned-character-fallback-banner.spec.ts
git commit -m "feat(frontend): split the auto-reconciled orphan disclosure by audio currency (#2129)"
```

---

### Task 9: #2128 — the repair pass clears

**Files:**
- Modify: `scripts/repair-cast-id-drift.mjs` — `buildOrphansFromSegments` (`:2109`),
  `collectSegmentOrphans` (`:2155`), `planBookRepairs`'s zero-segment branch
  (`:1118-1142`), `main()`'s `--apply` tail (`:2611-2622`), the `mods` bundle (`:2032-2050`)
- Modify: `server/src/store/cast-resolve.repair-pass-contract.test.ts:78, 87, 95`
- Modify: `scripts/tests/repair-cast-id-drift.test.mjs` — **eight existing
  `buildOrphansFromSegments(segs, resolver)` call sites** at `:2589, 2606, 2622, 2629,
  2649, 2698, 2712, 2727` (`:2698`/`:2712` bind the whole result as `run1`/`run2`). Every
  one takes the new signature, or the branch lands red: Step 3's body calls
  `isAudioCurrent(...)` unconditionally on the first segment, so an `undefined` fourth
  argument throws `TypeError: isAudioCurrent is not a function`. Round 1 (C3) — the first
  draft of this plan named only the server-side contract test.
- Test: `scripts/tests/repair-cast-id-drift.test.mjs` (exists — extend it, do not create a
  second file)

**Interfaces:**
- Consumes: `isAudioCurrent` (Task 4) via `server/dist`, `SegmentsFile.castHistorySeq`
  (Task 6), `stampRecordedAtSeqIfAbsent` (Task 2).
- Produces: `buildOrphansFromSegments(segs, resolver, history, isAudioCurrent)` returns
  `{ orphans, currentNonExact: Set<string> }`.

**This is not a local change.** `orphans` feeds `planBookRepairs`, whose zero-segment
branch (fed by `:897`'s `orphans.get(id) ?? { segments: 0, … }`) carries an explicit
invariant at `:1124-1131`: *"Only `'exact'` skips `orphans` now … so `orphan.segments ===
0` here can only mean one thing: this id genuinely has zero rendered segments anywhere in
the book."* Once a *current* id also skips `orphans` that is false, and such an id is
emitted with the now-wrong reason `"…zero rendered segments — no damage to repair"` **and
drops out of `autoRecord` entirely** — the `autoReconciled`-bucket defect `511c5382` fixed
and `30456c71` deleted, one level down.

**Decisions the spec delegated, pinned here:**

1. **Is an affirmatively-current id still auto-recordable?** **No.** The existing
   zero-segment branch already refuses to auto-record an id with no damage on disk, and its
   stated reason applies unchanged: recording an alias for an id whose rendered audio is
   already correct is "a durable, unreviewed GUESS … with no wrong audio on disk to justify
   it and no reviewer in the loop". It goes to `reportOnly`, not `autoRecord`.
2. **The reason string.** A current id and a never-rendered id must not share one. The
   branch splits on `currentNonExact.has(id)`.
3. **The stale invariant comment** at `:1124-1131` is rewritten in the same edit.

Note that a *current alias* id never reaches this branch at all — `planBookRepairs`'s
"already-recorded" skip (`:885-895`) fires first for the `'history'` / `'normalised-history'`
tiers. The reachable new case is a **`'normalised-id'`-tier id that is current**, which is
precisely register row A32's `the-torment` / `lightning-dave` shape.

- [ ] **Step 1: Write the failing tests**

**Framework, verified — this file is NOT Vitest.** `scripts/tests/*.test.mjs` run under
`node --test` via `npm run test:hooks` (`scripts/run-hooks-tests.mjs` globs them and spawns
`node --test`); the root `vitest.config.ts` `include` is `src/**` + `skills/**` and never
touches `scripts/`. So: `import { test, describe } from 'node:test'` and
`import assert from 'node:assert/strict'` — **`test`, not `it`; `assert.equal`, not
`expect`.** Both are already imported at the top of the target file.

```js
describe('#2128 — a re-rendered chapter drops off the repair list', () => {
  test('drops an alias id whose every chapter was re-rendered above its marker', () => {
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 } };
    const segs = [{ chapterId: 1, castHistorySeq: 5, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, isAudioCurrent);
    assert.equal(orphans.has('mayrin'), false);
  });

  test('KEEPS an id whose chapter was not re-rendered', () => {
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 5, recordedAtSeq: { mayrin: 3 } };
    const segs = [{ chapterId: 1, castHistorySeq: 1, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, isAudioCurrent);
    assert.equal(orphans.get('mayrin').segments, 1);
  });

  test('KEEPS every id in a book whose history has no recordedAtSeq field', () => {
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 99 };
    const segs = [{ chapterId: 1, castHistorySeq: 99, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, isAudioCurrent);
    assert.equal(orphans.has('mayrin'), true); // 'unknown' LISTS
  });

  test("KEEPS an id when the file counter is below a render's stamp", () => {
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, seq: 2, recordedAtSeq: { mayrin: 1 } };
    const segs = [{ chapterId: 1, castHistorySeq: 99, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, isAudioCurrent);
    assert.equal(orphans.has('mayrin'), true);
  });

  test('KEEPS an id when the history object has recordedAtSeq but no seq', () => {
    // Round 1 (C1) — the fail-open shape, pinned on the consumer side too.
    const history = { schema: 1, supersededBy: { mayrin: 'mairin' }, recordedAtSeq: { mayrin: 1 } };
    const segs = [{ chapterId: 1, castHistorySeq: 9, segments: [{ characterId: 'mayrin' }] }];
    const { orphans } = buildOrphansFromSegments(segs, resolverFor(history), history, isAudioCurrent);
    assert.equal(orphans.has('mayrin'), true);
  });

  test('reports a current non-exact id as such, not as never-rendered', () => {
    // A 'normalised-id'-tier id, re-rendered: skips `orphans`, but it DID render.
    const history = { schema: 1, supersededBy: {}, seq: 1, recordedAtSeq: {} };
    const segs = [{ chapterId: 1, castHistorySeq: 1, segments: [{ characterId: 'The_Torment' }] }];
    const { orphans, currentNonExact } = buildOrphansFromSegments(
      segs, resolverFor(history, [{ id: 'the-torment' }]), history, isAudioCurrent,
    );
    assert.equal(orphans.has('The_Torment'), false);
    assert.equal(currentNonExact.has('The_Torment'), true);
  });

  test('orphans membership WINS over currentNonExact across chapters', () => {
    // Current in ch1, stale in ch2. Without the subtraction at the end of
    // buildOrphansFromSegments the id lands in BOTH, and planBookRepairs then
    // reads the wrong one — the "any-current => clean" direction that re-opens #2107.
    const history = { schema: 1, supersededBy: {}, seq: 4, recordedAtSeq: {} };
    const segs = [
      { chapterId: 1, castHistorySeq: 4, segments: [{ characterId: 'The_Torment' }] },
      { chapterId: 2, segments: [{ characterId: 'The_Torment' }] }, // no stamp -> 'unknown'
    ];
    const { orphans, currentNonExact } = buildOrphansFromSegments(
      segs, resolverFor(history, [{ id: 'the-torment' }]), history, isAudioCurrent,
    );
    assert.equal(orphans.has('The_Torment'), true);
    assert.equal(currentNonExact.has('The_Torment'), false);
  });

  test('planBookRepairs distinguishes current from never-rendered, and auto-records neither', () => {
    /* `planBookRepairs(input, deps)` — verified signature at
       repair-cast-id-drift.mjs:716-718. `input` destructures
       `{ liveCast, history, cacheNameIndex, bakNameIndex, orphans,
       cacheAvailable = false, bakAvailable = false }` plus this lane's new
       `currentNonExact`. There is NO `candidateIds` field: the ids come from
       the name indexes, so the fixture must seed `bakNameIndex`/`cacheNameIndex`
       the way this file's existing planBookRepairs cases do. Round 1 (I10)
       caught the first draft inventing a parameter and driving no branch. */
    const { reportOnly, autoRecord } = planBookRepairs(
      {
        ...baseInput, // liveCast, history, both name indexes, cacheAvailable/bakAvailable: true
        orphans: new Map(),
        currentNonExact: new Set(['The_Torment']),
      },
      deps,
    );
    assert.deepEqual(autoRecord, []);
    // Matches Step 5's string exactly — "every rendered segment carrying this id
    // is already current". Round 1 (I10): the first draft asserted a phrase the
    // implementation never produces.
    assert.match(reportOnly.find((r) => r.id === 'The_Torment').reason, /is already current/);
    assert.match(reportOnly.find((r) => r.id === 'never-spoke').reason, /zero rendered segments/);
  });
});
```

Plus an `--apply` test, in the same framework (the file already imports `node:fs` as `fs`
and `node:net` — it has an existing live-server-refusal case to model on):

```js
test('--apply performs the one-shot stamp on a scanned book with no auto-records', async () => {
  // The books carrying pre-lane aliases are exactly the ones A33 already visits.
  const dir = bookWithHistory({ schema: 1, supersededBy: { mayrin: 'mairin' } });
  await runMain(['--apply']);
  const after = JSON.parse(fs.readFileSync(historyPath(dir), 'utf8'));
  assert.deepEqual(after.recordedAtSeq, { mayrin: 1 });
});

test('still refuses --apply while a server is live', async () => {
  // Pin the existing gate — #2128's counter depends on a single writer.
  // Model this on the file's existing port-probe refusal case rather than
  // inventing a second server fixture.
  const server = await listenOn(port);
  await runMain(['--apply']);
  assert.equal(process.exitCode, 1);
  await server.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test scripts/tests/repair-cast-id-drift.test.mjs`
Expected: FAIL — `buildOrphansFromSegments` takes two arguments.

- [ ] **Step 3: Change `buildOrphansFromSegments`**

```js
export function buildOrphansFromSegments(segs, resolver, history, isAudioCurrent) {
  const orphans = new Map();
  /* #2128 — ids that skipped `orphans` because their audio is affirmatively
     CURRENT, though they do not resolve via `'exact'`. `planBookRepairs`'s
     zero-segment branch needs to tell these apart from an id that genuinely
     never rendered a line: both now arrive with `segments === 0`, and giving
     them the same reason string re-opens the `autoReconciled`-bucket defect
     511c5382 fixed one level down. Reported as fact here; the policy lives in
     the caller. */
  const currentNonExact = new Set();
  for (const seg of segs) {
    const perChapterCount = new Map();
    const perChapterDuration = new Map();
    for (const s of seg.segments ?? []) {
      const id = s.characterId;
      if (typeof id !== 'string') continue;
      const resolution = resolver.resolve(id);
      /* #2128 — the skip is now "affirmatively current", not "resolves via
         exact". `isAudioCurrent` is the SAME predicate the Cast banner calls
         (server/src/store/cast-audio-currency.ts) — plan 278's invariant 7,
         extended from candidate ranking to currency. Anything other than a
         literal `true` is listed: 'unknown' means the comparison could not be
         made, and reading that as clean is what #2107 exists to prevent.

         The empty-result note above still holds in FORM: `orphans` being empty
         for an id must mean AFFIRMATIVELY CURRENT, never merely "the resolver
         returned something". */
      if (isAudioCurrent(resolution, seg, history) === true) {
        if (resolution?.via !== 'exact') currentNonExact.add(id);
        continue;
      }
      perChapterCount.set(id, (perChapterCount.get(id) ?? 0) + 1);
      if (typeof s.startSec === 'number' && typeof s.endSec === 'number') {
        perChapterDuration.set(id, (perChapterDuration.get(id) ?? 0) + Math.max(0, s.endSec - s.startSec));
      }
    }
    // ... unchanged aggregation ...
  }
  return { orphans, currentNonExact };
}
```

**Aggregation caveat.** `isAudioCurrent` is per-segments-file, and this loop is already
per-file, so an id current in ch2 and stale in ch5 lands in `orphans` from ch5 **and** in
`currentNonExact` from ch2. `orphans` membership must win: at the end of the function,
`for (const id of orphans.keys()) currentNonExact.delete(id);`. Add that line and a test
for it — this is the same "any-current ⇒ clean" direction that re-opens #2107.

- [ ] **Step 4: Thread the predicate through `collectSegmentOrphans` and `mods`**

Add `isAudioCurrent` to the dynamic-import bundle (`:2032-2050`):

```js
    import('../server/dist/store/cast-audio-currency.js'),
```
```js
    isAudioCurrent: castAudioCurrency.isAudioCurrent,
```

and in `collectSegmentOrphans`:

```js
  const { orphans, currentNonExact } = buildOrphansFromSegments(segs, resolver, history, mods.isAudioCurrent);
  return { orphans, currentNonExact, resolver };
```

- [ ] **Step 5: Rewrite the zero-segment branch and its stale invariant comment**

Replace **`:1116-1142`** — the comment block starts at `:1116`
(`// --- review round 1, Important 2, guard 3: …`), so replacing from `:1118` leaves two
orphaned lines ending mid-sentence above the new comment (round 1, M16):

```js
      // #2107, widened by owner decision (2026-08-05), then narrowed again by
      // #2128: the skip is "affirmatively current" (`isAudioCurrent === true`),
      // not "resolves via 'exact'". So `orphan.segments === 0` no longer means
      // one thing — it means EITHER this id genuinely has zero rendered
      // segments anywhere in the book, OR it rendered and every one of those
      // renders is current. `currentNonExact` (buildOrphansFromSegments) is
      // what tells them apart; giving both the same "zero rendered segments"
      // reason would emit a demonstrably false statement about a book with 67
      // rendered segments, and is one level down from the `autoReconciled`
      // bucket 511c5382 fixed and 30456c71 deleted.
      //
      // NEITHER is auto-recorded, for the same unchanged reason: there is no
      // wrong audio on disk to justify a durable, unreviewed alias, and no
      // reviewer in the loop (spec §4.7 scopes this pass to REPAIR).
      if (orphan.segments === 0) {
        const current = currentNonExact.has(id);
        reportOnly.push({
          id,
          segments: 0,
          chapters: [],
          reason: current
            ? `name/id-matched "${matchedId}" (${evidence}) but every rendered segment carrying this id is ` +
              `already current (rendered against the cast-id-history state that established its target) — no ` +
              `damage to repair`
            : `name/id-matched "${matchedId}" (${evidence}) but this id has zero rendered segments — no ` +
              `damage to repair, so this pass does not pre-emptively alias a never-rendered id`,
          candidates: [],
        });
        continue;
      }
```

`planBookRepairs` must accept `currentNonExact` as an input (defaulting to an empty `Set`
so its existing tests keep passing) and `main()` must pass it through from
`collectSegmentOrphans`.

- [ ] **Step 6: Add the `--apply` one-shot stamp**

`main()` currently only writes for books with auto-records (`pendingWrites`). Collect every
scanned book's dir in the main loop:

```js
  const scannedBookDirs = [];
```
```js
    scannedBookDirs.push(book.bookDir);
```

and after the existing `pendingWrites` block:

```js
  if (apply) {
    /* #2128 — the one-shot back-fill stamp, for EVERY book scanned, not only
       ones with an alias to record. Absence of `recordedAtSeq` reads 'unknown'
       and lists the whole book forever; the books carrying pre-lane aliases are
       exactly the ones this A33 workflow already visits, so this is where they
       get their field. No-op on a book that already has one, on a book with no
       history file, and on a malformed file (which is left alone to be fixed,
       never overwritten). */
    let stamped = 0;
    for (const bookDir of scannedBookDirs) {
      if (await mods.stampRecordedAtSeqIfAbsent(bookDir)) stamped += 1;
    }
    if (stamped) console.log(`\nstamped cast-id-history recordedAtSeq on ${stamped} book(s) (#2128 one-shot)`);
  }
```

adding `stampRecordedAtSeqIfAbsent` to the `mods` bundle. **Order it after the alias
writes** — a book that just received an alias already has the field from
`bumpSeqAndStamp`, so the stamp is a no-op there, and doing it first would be equally
correct but harder to reason about.

- [ ] **Step 7: Update the pinned cross-boundary contract test**

`server/src/store/cast-resolve.repair-pass-contract.test.ts:78, 87, 95` calls
`buildOrphansFromSegments(segs, resolver)` from the **server** suite, deliberately
exercising the script's function against the real `buildCastResolver` (#2130). **That file
moves in this lane or the lane lands red.** Update all three call sites to the new
four-argument signature, importing the real `isAudioCurrent` from
`../store/cast-audio-currency.js` — which strengthens the test: it now pins the script's
function against **both** real server implementations.

- [ ] **Step 8: Run everything**

Run: `npm run test:hooks` (this is what runs `scripts/tests/*.test.mjs` — `npx vitest run
scripts/` matches nothing and would report a vacuous green), then
`cd server && npx vitest run src/store/cast-resolve.repair-pass-contract.test.ts`.
Then a real dry run against the workspace: `node scripts/repair-cast-id-drift.mjs`
Expected: the dry run still reports **23 rows / 188 segments** — no history file has been
through the one-shot stamp yet, and no chapter has been re-rendered, so day-one output is
byte-identical to today's. **A dry run that reports fewer rows before any re-render means
the unknown rule got inverted somewhere.** Stop and find it.

- [ ] **Step 9: Mutate**

Change the skip to `isAudioCurrent(...) !== false` and confirm the two `'unknown'` tests
redden. Drop the `orphans.keys()` subtraction and confirm the mixed-chapter test reddens.

- [ ] **Step 10: Commit**

```bash
git add scripts/repair-cast-id-drift.mjs scripts/tests/repair-cast-id-drift.test.mjs \
        server/src/store/cast-resolve.repair-pass-contract.test.ts
git commit -m "feat(scripts): clear a repaired id from the drift report once its audio is current (#2128)"
```

---

### Task 10: Reconcile #2133 from the sibling branch

> **Shipped as specified.** Merged via PR #2163 (2026-08-06, merge commit
> `7add81c0`), carrying commits `8c0925a2` and `03dd0fc6` from this sibling branch.
> This is the one task in this document whose outcome matches what was planned.

**Files:** none written in this lane. Verification and a merge.

**Interfaces:**
- Consumes: `fix/server-cast-identity-followups` (`8c0925a2`, `03dd0fc6`).
- Produces: #2133 closed.

The concurrent session's implementation was read against spec §8 while this plan was being
written and **matches it**:

- `analysis.ts` gets a **locked** write, in its own `withCastLock`, with the
  `writeJsonAtomic(castJsonPath(` text **textually inside** the `withCastLock(` parens —
  which is what the call-graph-blind guard requires. `analysis.ts` holds no cast lock at
  any of its eight `recordRetirements` sites (its only `withCastLock`, at `:2924`, wraps an
  unrelated `rm`), so an unlocked write here would have failed
  `cast-lock.guard.test.ts` immediately.
- `cast-merge.ts` gets its removal under the lock it already holds.
- `recordRetirements` returns / acts on `retireCharacterId`'s `droppedSelfLoopRejections`.
- Best-effort: a failure clearing the edge does not fail the retirement.
- Plan 278 gained the invariant (+39 lines).
- One incidental fix folded in and declared in the commit body (DELETE
  `/reject-orphan-match` now clears an abandoned half-write's edge), one on the frontend
  (a chip whose target has left the live cast is hidden rather than rendering a
  permanently-404ing Undo).

- [ ] **Step 1: Verify, do not assume**

```bash
git -C C:/Claude/Projects/wt-cast-identity-followups log --oneline origin/main..HEAD
git -C C:/Claude/Projects/wt-cast-identity-followups diff origin/main...HEAD -- server/src/routes/analysis.ts
```

Confirm each bullet above against the actual diff. If the branch has moved since this plan
was written, re-read it — a concurrent session is what produced it.

- [ ] **Step 2: Confirm the lock guard is genuinely green there**

Run in that worktree: `cd server && npx vitest run src/workspace/cast-lock.guard.test.ts`
Expected: PASS with `analysis.ts`'s allowlisted **unlocked** count unchanged — the new
write is locked, so it must not appear in the count at all. If the count moved, the write
is outside the parens.

- [ ] **Step 3: Confirm the "rename vs discard" question was settled empirically**

Spec §8: *"The tests must settle empirically whether the edge survives the merge at all —
whether Y's row is renamed (data carries over) or discarded in favour of X's. Unverified.
If a path discards the row, the fix is a no-op there and the test records that rather than
asserting a phantom."*

Check `cast-merge.test.ts` for a test that establishes which it is. **If no such test
exists, that is the one gap to close in this lane** — write it before merging, and let it
record whichever answer the code actually gives.

- [ ] **Step 4: Merge into this lane's branch**

```bash
git merge --no-ff fix/server-cast-identity-followups
```

Conflicts are likely in `server/src/store/cast-id-history.ts` (Task 2 rewrote its write
sites; the sibling branch touched its `droppedSelfLoopRejections` doc comment) and in
`docs/features/278-cast-character-identity.md`. **After resolving, grep the whole tree for
conflict markers** — not just the files git named — and re-run **both** branches' guards:
`cast-lock.guard.test.ts` and the two new guards from Task 5. Two defects can exist in
neither branch alone and produce no marker.

- [ ] **Step 5: Full battery**

Run: `npm run verify:fast:branch`
Expected: PASS.

- [ ] **Step 6: Commit the merge**

The merge commit is the deliverable; no separate code commit.

---

### Task 11: Documentation, release notes, on-box acceptance, follow-up issue

**Files:**
- Modify: `docs/features/278-cast-character-identity.md`
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/testing/onbox-acceptance-register.md`,
  `docs/testing/cast-id-drift-onbox-acceptance.md`,
  `docs/testing/onbox-acceptance-register-live-view.html`
- Modify: `docs/features/INDEX.md` (this plan is new), `docs/BACKLOG.md` if any closed
  issue is `type:feature`

- [ ] **Step 1: Add plan 278's new invariants**

Append to `docs/features/278-cast-character-identity.md`'s invariants section:

- **The whole `CastIdHistory` is threaded, never a subset** (spine rule 2). Enforced by
  `server/src/store/cast-history-threading.guard.test.ts`, whose allowlist is keyed on file
  **and** count and records a reason per entry.
- **A `supersededBy` entry and its markers are written and destroyed together**, with no
  exception. `keys(recordedAtSeq) === keys(supersededBy)` bidirectionally after every
  write; `seq` strictly increases across every write, including the four that touch no key.
- **`recordedAtSeq[k]` tracks the CURRENT target's establishment**, not first recording —
  which is what makes a merge-repoint (same person, different cast row, different voice)
  re-list its renders.
- **`'unknown'` never clears a row.** Only an affirmative comparison does.
- **The render stamp is written only by the full-render path.** The two partial writers
  carry it forward verbatim.
- **Invariant 8 amended** — `cast-create`'s taken set now includes `supersededBy`
  **values** as well as keys, and the avoidance report has a third branch.
- **#2133's semantics** — a reject's two writes are created together and destroyed
  together (already added by the sibling branch; verify it survived the Task 10 merge).

- [ ] **Step 2: Both release-notes documents, respecting the known limits**

`docs/release-notes-next.md` (technical register, PR-refed) and a matching brand-voice line
in `RELEASE_NOTES.md`'s in-progress section. **The wording must say "as chapters are
re-rendered", not "as the work gets done"** — known limit 1: a QA repair re-synthesises the
affected sentences correctly but carries the old stamp forward, so the row stays listed.
Known limit 2 (Reject-then-Undo lists the chapter until re-rendered) is operator-visible
and earns its own line.

- [ ] **Step 3: On-box acceptance — a merge gate**

#2128's acceptance is only provable by fully re-rendering a real chapter on the box.
**Recording blocks the merge; running does not.** All three surfaces move in this PR:

1. A row in `docs/testing/onbox-acceptance-register.md`, grouped with A33's hardware
   prerequisite. State concretely what to observe: *run `repair-cast-id-drift.mjs` dry and
   note the row count; fully re-render one listed chapter; re-run and confirm that
   chapter's id drops off while every un-re-rendered chapter stays listed; confirm the Cast
   banner's two auto-reconciled counts move in the same direction.*
2. The criteria in `docs/testing/cast-id-drift-onbox-acceptance.md`.
3. `docs/testing/onbox-acceptance-register-live-view.html` — **edit that tracked
   hand-authored HTML file and publish IT**, with the `url` from the register header. Never
   publish the `.md`; never publish without the `url`. Recompute the derived figures (owed
   count, group counts, oldest debt) rather than carrying them over.

Run `npm run check:onbox-register`. **Immediately before publishing**, save the page
currently live at that URL and run
`npm run check:onbox-register -- --against-published <saved copy>`; stop if it disagrees.

- [ ] **Step 4: Record the #2129 premise correction on the issue**

#2129's second premise — a stale "don't contradict the Cast banner" comment in
`planBookRepairs` — was **already discharged**: the comment existed verbatim (`511c5382`)
and was deleted by `30456c71`, the #2107 widening, along with the `autoReconciled` bucket
it justified. #2129 was filed against the pre-widening tree. Post that as a comment on the
issue so a later reader does not go looking for it.

- [ ] **Step 5: File the follow-up issue for known limit 4**

Cross-process writes to `cast-id-history.json` are **gated, not excluded**: `withKeyLock`
is in-process only, and `--apply` writes from a separate process. Pre-existing (
`retireCharacterId`'s repoint loop is already a non-atomic read-modify-write) and already
gated by the live-server port probe (`:2203-2215`, #2090). File a `type:chore` issue
against the module for genuine cross-process atomicity, referencing #2015. Label
`area:srv`; leave `moscow:` unset. **No `docs/BACKLOG.md` row** — chores never render there.

- [ ] **Step 6: Index and backlog**

Add this plan to `docs/features/INDEX.md` under its area. Run `npm run backlog:sync` only
if one of the four closed issues is `type:feature`; check with
`gh issue view <n> --json labels` rather than assuming.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs(docs): record the cast-identity follow-up invariants and acceptance (#2128)"
```

---

## Operational notes

**Ordering against A33.** Either order works. If `repair-cast-id-drift.mjs --apply` runs
first it performs the one-shot stamp on every book it scans (Task 9), which is strictly
helpful. **The two must not run concurrently** — the counter assumes a single writer, and
`withKeyLock` (`workspace/file-lock.ts:5`) is a module-scope `Map`, i.e. in-process only.
That is enforced by the existing live-server port probe (`repair-cast-id-drift.mjs:2203-2215`,
#2090), which Task 9 pins with a test.

**Day-one output is byte-identical to today's.** Every existing history file has no
counter and no `recordedAtSeq`; every existing segments file has no `castHistorySeq`. Both
read `'unknown'`, so every currently-listed row stays listed until the one-shot stamp lands
**and** the chapter is fully re-rendered. A dry run reporting fewer than 23 rows / 188
segments before any re-render means the unknown rule was inverted somewhere.

**Known limits — properties of the design, not defects.** Stated so they are known rather
than discovered:

1. **Only a full re-render clears a row.** `chapter-qa-repair` re-synthesises affected
   sentences against the current resolver, correctly, but carries the old `castHistorySeq`
   forward — fail-closed and deliberate, since the file's other segments were not
   re-rendered. Release-notes wording must say "as chapters are re-rendered".
2. **Reject-then-Undo lists the chapter until re-rendered.** `restoreSupersededId` stamps
   the current seq, so an Undo with no intervening render leaves every prior render below
   the new marker. Accepted because the alternative is the narrator-voice false negative
   above. Worth a release-notes line.
3. **`castHistorySeq` cannot express a resolver *change*.** Its presence proves the
   four-tier resolver existed, the only distinction #2128 needs. It cannot distinguish v1
   from a future v2 — a later change to the tier set or to `normaliseIdKey` would alter
   which ids resolve via `'normalised-id'` with no marker to invalidate against. Adding a
   version field then is the fix; adding it now is speculative. **If a future lane changes
   either, this is the invariant it breaks.**
4. **Cross-process writes are gated, not excluded.** Pre-existing (`retireCharacterId`'s
   repoint is already a non-atomic read-modify-write), already gated by the live-server
   probe. Task 11 step 5 files the follow-up.

## Out of scope

- Rewriting frozen `segments.json` files to migrate ids — plan 278 invariant 6.
- Any change to `resolution`'s three values or to the reject/undo chips.
- Pruning dangling `supersededBy` entries (Task 1's rationale).
- Per-segment currency stamping — the file-level stamp is confined to the full-render path.
- A second candidate ranker on any surface — plan 278 invariant 7.

## Review history

**Rev 1 → 2** (Premium `assumption-checker` pass, 2026-08-06). Declared **not converged**.
Three Criticals and eleven lesser findings, all verified against source before acting:

- **The predicate itself fail-open.** `if (finite(history.seq) && history.seq < stamp)`
  meant an object with `recordedAtSeq` but no `seq` — `seq?` is optional, so a hand-narrowed
  subset type-checks — skipped the counter-reset guard and could return `true`. Spine rule
  2's exact shape, inside the one function the whole lane exists to make trustworthy. Now
  `!finite(history.seq) || …`, with its own test.
- **Guard 5 asserted nothing it claimed, and was red as written.** `ASSIGN_RE` was
  exercised only against synthetic strings and never applied to the module; the two
  file-wide counts were wrong against the implementation Task 2 specifies, and the
  "adjust the counts" escape hatch would have made the lane's one new write site
  permanently invisible. Rewritten to scan per top-level function, with a hand-run
  neutralisation proof and its residual blind spot stated.
- **Eight unlisted callers.** `scripts/tests/repair-cast-id-drift.test.mjs:2589, 2606,
  2622, 2629, 2649, 2698, 2712, 2727` all call `buildOrphansFromSegments(segs, resolver)`
  and would have thrown on the new signature.
- **Wrong test framework** (found while verifying the above, not by the review):
  `scripts/tests/*.test.mjs` run under `node --test` via `npm run test:hooks`, with
  `node:test` + `node:assert/strict`. Task 9's block was written in Vitest, and its run
  command (`npx vitest run scripts/`) matches nothing — a vacuous green.
- **Three line ranges that produce broken edits**: `cast-create.ts` 126-129 would have
  deleted `isTaken` (correct: 125-128); `repair-cast-id-drift.mjs` 830-834 leaves a
  dangling assignment (correct: 829-835 — **the spec §1 carries the same error**);
  `planBookRepairs`'s comment starts at 1116, not 1118.
- **Four tests that could not fail or failed against the plan's own code** — two tripped
  the counter-reset guard before reaching what they meant to assert (making their
  prescribed mutants inert), one asserted a reason string the implementation never
  produces and passed a `planBookRepairs` field that does not exist, and #2110's
  normalised case was already blocked on `main` by the existing key check.
- **Task 2's tests invented a harness.** No `tmpBook()` exists;
  `cast-id-history.test.ts` is sync-fs-only with a module-level `dir` and a
  `writeTestHistoryFile` helper, and a direct write to `castIdHistoryPath` ENOENTs.
- **Two defects the plan created rather than inherited**, both added as work: a repeat
  `retireCharacterId` would restamp and re-list a whole book (no idempotence guard existed
  — invisible until `seq` made a redundant write observable), and the frontend's optimistic
  reject/undo reducers never touch `audioCurrent`, reproducing #2129's own divergence one
  layer up.
- Plus `cast-resolve.ts`'s `CastResolution` cited as `:13-58`/`:57` when it is `:13-29`
  with `via` at `:28` (inserting at `:57` puts the field in a comment), a `node:fs`
  `globSync` that does not exist on Node 20, an `"entryies"` plural, a `.catch(() => ({}))`
  that breaks narrowing, and the guard-3 allowlist misattributing `idOnlyResolver`.

**Carry back to the spec:** §1's `repair-cast-id-drift.mjs:830-834` should read `829-835`.
Not corrected in the spec itself — the plan is the artifact an implementer follows, and the
spec's own "Review history" convention is to record rather than silently rewrite.

## Shipping

Per CLAUDE.md's Before-shipping checklist:

1. Regression plan — **this document**; set `status: active` when implementation starts and
   fill **Ship notes** when it merges.
2. Paired tests — every task above.
3. On-box acceptance — Task 11 step 3. **Recording is a merge gate.**
4. `docs/features/INDEX.md` — Task 11 step 6.
5. Both release-notes documents — Task 11 step 2.
6. PR body: `Closes #2110`, `Closes #2129`, `Closes #2133`, `Closes #2128`. Note that a
   `Closes` trailer in a **commit** fires even if the PR body later says `Refs`, and a
   comma-separated list closes only the first — one `Closes #NN` per line.
7. `npm run verify:fast:branch` locally; cloud `verify.yml` is the authoritative gate.
8. Ship notes + `git mv` to `docs/features/archive/` when `status: stable`.
9. Surface the user-visible delta in the end-of-turn summary.
10. **Mandatory `code-review` pass** at Premium tier, `high` effort — this is a
    multi-scope PR (server + frontend + scripts + docs).

## Ship notes

**Partial.** #2110, #2129, #2133 shipped **2026-08-06** via **PR #2163**
(`fix/server-cast-identity-followups` → `main`, merge commit
`7add81c0ce4fde75657ca2e64f5bd0131eb87d16`) — see "What actually shipped" above for
how each diverged from the tasks below (all but Task 10/#2133). **#2128 (Tasks
2-9) did not ship** and is not archived here: this plan stays `status: active` and
out of `docs/features/archive/` until #2128 either lands or is formally deferred.
There is no single merge SHA for "this plan shipping" — only the three-issue
subset above landed, and not via this plan's own task breakdown for two of the
three.
