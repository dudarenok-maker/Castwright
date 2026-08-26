---
status: draft
---

# `qwen-voice.ts` clone-consent refusal: write-time re-check (part of #2006 / srv-81)

Sibling to `2026-08-22-clone-consent-voices-override-refusal-design.md`, which
resolves the `voices.ts`/`single-design.ts` gate. **This spec resolves the third
gate: `persistEmotionVariant` (`server/src/routes/qwen-voice.ts:144-209`),
shared by the JSON `design-voice` route (call site `qwen-voice.ts:671`) and the
SSE bulk "Design full cast" job (call site `cast-design.ts:555`).** It does not
touch `cast-design.ts`'s base-voice path (`applyOverrideToCastFiles`),
`cast-link-prior.ts`, or the `voiceUuid` double-mint — those remain exactly as
open as #2006's history already recorded them.

**Line numbers below are cited against this worktree's own
`server/src/routes/qwen-voice.ts`** (branch `docs/docs-2006-clone-consent-refusal-spec`),
verified directly, not against `main` — this branch is currently ~12 lines
behind `main` in that file (missing #2246's `language_unset` block), so a
citation that looks off by roughly that much elsewhere is a sign the reader is
comparing against `main`, not an error in this spec. Rebase before
implementation and re-verify if the gap has grown.

**Revision history.** Four rounds of the mandatory adversarial review
(`assumption-checker`, Opus/xhigh) — three as the capped review loop, a fourth
as a fresh check warranted by how much the mechanism changed after a
judgment call was resolved:

- **v1 → v2:** fixed a two-boolean return shape that silently mislabeled
  "character not found" as success; added artifact teardown on refusal.
- **v2 → v3:** removed the teardown and a walker-signature-extension idea,
  because round 2 found both dangerous — the teardown could delete a
  deterministically-named artifact a sibling book's independent successful
  write still referenced; the signature extension contradicted the sibling
  spec's explicit commitment not to touch `forEachMatchingCastCharacter`.
- **v3 → v4:** round 3 found that v3's "per-book independence is intentional"
  framing rested on a false premise — clone consent is recorded per-book
  (`voice-library.ts`'s clone-assign writes the marker to exactly one book),
  but the character's identity and artifact key are series-wide. This was
  raised to the user as a genuine product decision rather than resolved
  unilaterally. The user decided: **clone-consent refusal is scoped to the
  linked voice identity (series-wide), not to a single book's marker** — a
  clone anywhere in the series refuses the whole propagation — implemented as
  a **best-effort** (not fully atomic) fresh scan immediately before the write
  walk, explicitly declining to reopen #2000 §3.2's rejected workspace-lock
  model for full atomicity.
- **v4 → v5 (this revision):** a fresh round-4 check of the new mechanism
  found two real defects in v4's implementation of the user's decision (not
  further judgment calls):
  1. v4 made only the *write-time* re-check series-wide. All four gates
     upstream of it — the frontend's own gate, both routes' upfront 409s, and
     the design core's #1954 guard — stayed book-local. For any character
     cloned on a sibling book (a stable configuration, not a race), that meant
     every design attempt would run full GPU synthesis and *then* refuse,
     deterministically, every time — the exact case this spec exists to make
     cheap to refuse. Fixed by making both callers' upfront checks series-wide
     too (§"Upfront checks" below), reusing the same exported function.
  2. v4 cited the `voices.ts` sibling as precedent for silently discarding a
     residual mid-walk skip — but the sibling built its `skipped` array
     specifically to report that exact case, not to swallow it. Fixed by
     threading `forEachMatchingCastCharacter`'s own returned count through
     instead of discarding it, and logging (not silently absorbing) the rare
     residual-skip case. See §"Series branch" below.

  Two smaller corrections: `clonedVariantRefusal`'s message assumed the
  refusal was always caused by *this* book's own copy, which a series-wide
  refusal can make false; reworded to be accurate regardless of which linked
  book carries the marker. `hasClonedSlotAmongMatches`'s doc comment is scoped
  to its one existing caller; exporting it for a second caller makes that
  comment stale, which this spec fixes in the same round per CLAUDE.md's
  incidental-findings rule rather than filing it separately.

## The problem, restated after reading the current code

The issue as filed frames this as one TOCTOU gap (read-then-decide in one
scope, write in another). Reading the code surfaces a second, independent gap:

1. **TOCTOU.** Both callers check `characterHasClonedSlot` once
   (`qwen-voice.ts:600-605`, `cast-design.ts:430-440`), before the (slow) GPU
   design call, then call `persistEmotionVariant` afterward with no re-check. A
   clone can land on the character during GPU synthesis and the stale decision
   persists anyway.
2. **The check was never series-wide.** Both upfront checks, and the design
   core's own #1954 guard, test only the *originating* book's own character.
   `persistEmotionVariant`'s `seriesFilter` branch then propagates the variant
   to every linked-cast character across the series via
   `forEachMatchingCastCharacter`'s mutate closure (`qwen-voice.ts:186-188`),
   unconditionally — so a linked character cloned in a *different* book than
   the one the request came from was never checked at all, anywhere, until
   this spec.

**Why gap #2 is not a rare edge case — it is a routine, deterministic failure
mode without the upfront fix.** A character cloned on a sibling book is a
stable, steady-state configuration (someone recorded consent-refusal once, for
that book), not a timing coincidence. Every one of the four existing
book-local gates — the frontend's `cloned` check
(`src/components/emotion-variant-designer.tsx:125-127`), both routes' upfront
409s, and the core guard below — passes for a character in this state, every
time, because none of them looks past the caller's own book. Without also
fixing the upfront checks, a write-time-only fix would make the correct
refusal happen *after* a full GPU design round completed, deterministically,
for every attempt — not occasionally, under a race. §"Upfront checks" below
closes this at the cheap end instead of only the expensive one.

**Not this spec's problem, confirmed by reading the code:** `addVariant`
(`qwen-voice.ts:157-166`) stamps `baseVoiceId` onto a sibling that has no
existing qwen slot at all. That is the intended base-propagation behaviour —
the whole point of the series branch is that a linked character's qwen
identity travels — and is orthogonal to clone-consent: a sibling with no qwen
slot at all is not itself evidence of anything; the clone check is what
determines refusal, not the presence/absence of a prior qwen slot.

**The core's own #1954 guard remains a book-local backstop, not a gate this
spec upgrades.** `designQwenVoiceForCharacter`'s guard (`qwen-voice.ts:424-425`,
inside `server/src/routes/qwen-voice.ts:372`) reads `p.character` — the
caller's own snapshot, built at `qwen-voice.ts:649` (`characterForDesign`) and
passed in at `:653`. Once both callers' upfront checks are series-wide (below),
this guard becomes redundant-but-harmless for the normal path — GPU work is
never reached for a series-wide-cloned character in the first place — and is
left as-is rather than given a `seriesFilter` parameter of its own, since its
only remaining job is guarding the narrow residual window between the
upfront check and this same GPU call, which is small and already covered by
the upfront check having *just* run.

**Why the just-minted artifact is left alone rather than torn down.** The
emotion-variant embedding id is deterministic —
`` `${baseVoiceId}__${emotion}` `` (`qwen-voice.ts:428`) — not unique per
design attempt. Tearing it down on refusal risks deleting something a
different book's successful write or a pre-existing consented design still
references. This spec does not attempt artifact cleanup on refusal: the
consent guarantee is that no clone-protected linked character's `cast.json`
ever points at the newly-minted embedding, which the series-wide refusal
below fully delivers by not writing to *any* book when a clone is found
anywhere. An unreferenced `.pt`/`.json` sitting on disk (or, on the audition
side, a cached MP3 — a pre-existing gap this codebase doesn't solve anywhere,
including for the redesign-invalidation path at `qwen-voice.ts:878-880`) is a
storage-hygiene question, not a fresh consent violation, once the
cast.json-write guarantee holds for every linked book rather than only the
caller's own.

## The decision this spec finalizes

### 1. Return contract

`persistEmotionVariant` changes from `Promise<void>` to:

```ts
type PersistEmotionVariantOutcome =
  | 'applied'        // the variant was propagated to at least one book (book-scoped:
                      // the caller's own book; series-scoped: series-wide, no clone
                      // found anywhere, at least one matching confirmed-cast book existed)
  | 'skippedClone'   // refused: a clone was found — the caller's own character
                      // (book-scoped) or ANY linked character in the series
                      // (series-scoped) — no book was written
  | 'notFound';      // no-op: unknown character, vanished mid-write, or (series-scoped)
                      // no confirmed-cast book matched at all — nothing written and no
                      // clone was the reason. Existing silent-no-op disposition, named
                      // rather than expanded.

Promise<PersistEmotionVariantOutcome>
```

Both callers branch **only** on `'skippedClone'` vs. everything else, so
`'applied'` and `'notFound'` collapse to the same caller-visible behaviour —
today's existing behaviour, preserved exactly. The series branch derives
`'applied'` vs. `'notFound'` from `forEachMatchingCastCharacter`'s own
returned count (`Promise<number>`, `voices.ts:795`/`:860`) rather than
discarding it — `count > 0` is `'applied'`, `count === 0` is `'notFound'` (no
confirmed-cast book in the series matched this character at all, a state the
series-wide clone scan already ruled out as the reason).

### 2. Upfront checks: also series-wide, not just the write-time re-check

**Both callers' pre-GPU checks are upgraded to call the same exported,
series-wide scan** (§3 below), replacing their current book-local
`characterHasClonedSlot(character)` test:

- **JSON route** (`qwen-voice.ts:600-605`): this check currently runs
  *before* `isStandalone`/`seriesInfo` are computed (`:638-639`), so making it
  series-wide requires moving that computation earlier in the handler — a
  reordering with no behavioural effect on anything else in the function,
  since neither depends on work done between the current two positions.
  ```ts
  const isStandalone = located.state?.isStandalone === true;
  const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
  if (emotion && await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesInfo ?? undefined)) {
    return res.status(409).json({
      error: clonedVariantRefusal(character.name ?? characterId),
      code: 'clone_protected',
    });
  }
  ```
- **SSE bulk job** (`cast-design.ts:430-440`): `seriesFilter` is already in
  scope at this point (`runDesignJob`'s own parameter, threaded in from the
  job's start) — no reordering needed, just swap the predicate:
  ```ts
  if (await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter)) {
    job.skipped += 1;
    job.clonedSkips.push({ characterId, name: character.name ?? characterId });
    broadcast(job, { type: 'character_skipped', characterId, name: character.name ?? characterId, reason: 'already_cloned' });
    continue;
  }
  ```

This turns the routine, deterministic "full GPU round then refuse" case
(named above) into a cheap pre-GPU 409/skip — the same cost this spec already
pays to make the *write-time* check series-wide, just spent before GPU work
instead of after. **The frontend's own book-local `cloned` gate
(`emotion-variant-designer.tsx:125-127`) is not changed by this spec** — it
would need the character prop to carry cross-book clone state, which is a
frontend/API surface change this backend spec doesn't make. Until that
follow-up lands, a user whose character is cloned only on a sibling book can
still click "Design" and get a 409 rather than the button being disabled or
hidden — but the 409 now arrives immediately, not after a full GPU round.

### 3. Series-wide check, reused, not reimplemented

**Export `hasClonedSlotAmongMatches`** (`voices.ts:615-645`, currently
module-private) — no change to its logic or its two-parameter-plus-optional
signature (`voiceId`, `seriesFilter?`, `otherThanEngine?`), only its
visibility. Both this spec's call sites pass `otherThanEngine` as `undefined`,
matching the existing plain `characterHasClonedSlot`-based checks it
replaces — the `otherThanEngine` parameter stays specific to `voices.ts`'s own
SET-branch asymmetry (`voices.ts:723`) and is irrelevant here. **Update the
function's doc comment** (`voices.ts:588-614`), which currently describes it
as scoped to "the clear branch below" and one SET-branch caller — both false
once this spec adds a second, unrelated caller. This is a chore this spec's
own change makes owed, fixed in the same round rather than filed separately.

`persistEmotionVariant`'s series branch calls it **fresh, at write time**,
before any book is touched — in addition to the callers now also calling it
**before GPU work**, per §2:

```ts
if (seriesFilter) {
  const stillCloned = await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter);
  if (stillCloned) return 'skippedClone'; // whole propagation refused — no book written
  // ... proceed to the walk below
}
```

This replaces the caller's stale pre-GPU snapshot with a fresh, series-wide
read at the moment of writing — shrinking the residual TOCTOU window from
"GPU synthesis duration" (closed by §2) down further to "the time between
this specific check and the walk actually reaching each book."

**Residual window, named rather than hidden — this is not full atomicity.**
Between this check passing and an individual book's own write inside the walk
below, a clone can still appear on that specific book (the same reasoning
#2006's issue body gives for why a true atomic veto needs #2000 §3.2's
workspace-lock reopened, which this spec does not do). The walk's own mutate
closure keeps a defensive per-book re-check as a second layer, and — unlike
v4 — this revision does not discard what that layer learns:

```ts
let residualSkip = false;
const updated = await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) => {
  if (characterHasClonedSlot(c)) {
    residualSkip = true;
    return c; // unchanged — this book's own write correctly declined
  }
  return addVariant(c, baseVoiceId);
});
if (residualSkip) {
  console.warn(
    `[persistEmotionVariant] residual-window skip: a clone appeared on a linked book for ${characterId} between the series-wide scan and this walk reaching it (${updated} book(s) still received the variant).`,
  );
}
return updated > 0 ? 'applied' : 'notFound';
```

**Why this is a logged, not a reported, outcome.** The user-facing contract
(§1) still resolves to `'applied'`/`'skippedClone'`/`'notFound'` — adding a
fourth, partial-success outcome would require both callers to handle a shape
neither the JSON 409 nor the SSE `clonedSkips` channel currently has room for,
and would reopen exactly the "how much per-book detail does a caller need"
question the review process already spent three rounds narrowing down. The
residual case is: (a) rare — it requires a clone to land in the specific
window between a passing series-wide scan and the walk reaching that one
book, not the routine sibling-already-cloned case §2 now closes cheaply; (b)
still fully protected on cast.json — the affected book's own write is
correctly declined by the same predicate, it just isn't reflected in the
return value's granularity. `console.warn` makes it observable to an operator
reading server logs without inventing new plumbing for a residual window this
spec's own stated scope (best-effort, not fully atomic) already discloses.
**This differs from v4's disposition of the same case**, which asserted it
needed no visibility at all; this revision's position is narrower — no
*caller-facing* reporting, but not silent either.

This function never needs to distinguish the caller's own book from any
other matched book, so no signature change to `forEachMatchingCastCharacter`
or its mutate parameter is needed anywhere in this design — it stays exactly
as it is today, and its three other callers (`applyOverrideToCastFiles`,
`applyTierToCastFiles`, `ensureCharacterVoiceUuid`'s `stamp`) are untouched.

### 4. Refusal message: book-agnostic wording

`clonedVariantRefusal` (`qwen-voice.ts:99`) currently reads: `` `"${name}" uses
a cloned voice, so emotion variants are unavailable … Assign a designed voice
to this character to use emotion variants.` `` Under series-wide scoping, the
refusal can fire for a character that, *in this book*, is not cloned and
already has a designed voice — making both the claim and the remedy false.
Reworded to be accurate regardless of which linked book carries the marker:

```ts
export function clonedVariantRefusal(name: string): string {
  return (
    `"${name}" is linked to a cloned voice somewhere in this series, so emotion variants are unavailable — ` +
    `they are only offered for a designed voice. Minting one would re-derive a ` +
    `new performance of a real person's voice under a key their consent record ` +
    `does not cover and revoking consent does not erase. Remove the clone from ` +
    `every linked book to use emotion variants for this character.`
  );
}
```

Used identically at the upfront checks (§2), the write-time series check
(§3), and the core's own #1954 guard (`qwen-voice.ts:424-425`) — one message,
accurate at every call site regardless of which book triggered it.

### 5. Bulk-job skip channel: reused, not new

Confirmed against `cast-design.ts:430-440`: both the upgraded upfront check
(§2) and the write-time re-check report through the *exact same* channel —
`job.skipped += 1; job.clonedSkips.push({characterId, name}); broadcast(job,
{type: 'character_skipped', characterId, name, reason: 'already_cloned'})` —
not a new reason or counter. `character.name` is in scope at both the upfront
site and the write-time call site (`cast-design.ts:555`), and the existing
`break` at `:560` is unaffected (it sits inside the `for (;;)` retry loop
above the persist call, not inside the outcome branch this spec adds).

## Mechanism

### Book-scoped branch (no `seriesFilter`, `qwen-voice.ts:200-208`)

Unchanged from the series question above — there is no series to scan for a
standalone book. Already re-reads fresh inside its own `withCastLock`. Add a
`characterHasClonedSlot(freshCharacter)` re-check immediately before
`addVariant`. On a positive: skip the write entirely and return
`'skippedClone'`. Otherwise apply and return `'applied'`. The existing `if
(!fresh || idx === -1) return;` at `:203` returns `'notFound'`.

### Series branch (`forEachMatchingCastCharacter`, `qwen-voice.ts:168-189`)

```ts
const baseVoiceId = qwenStorageKey(character, characterId);

const stillCloned = await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter);
if (stillCloned) return 'skippedClone';

let residualSkip = false;
const updated = await forEachMatchingCastCharacter(character.voiceId ?? character.id, seriesFilter, (c) => {
  if (characterHasClonedSlot(c)) {
    residualSkip = true;
    return c; // unchanged — this book's own write correctly declined
  }
  return addVariant(c, baseVoiceId);
});
if (residualSkip) {
  console.warn(
    `[persistEmotionVariant] residual-window skip: a clone appeared on a linked book for ${characterId} between the series-wide scan and this walk reaching it (${updated} book(s) still received the variant).`,
  );
}
return updated > 0 ? 'applied' : 'notFound';
```

`hasClonedSlotAmongMatches` needs importing into `qwen-voice.ts` alongside the
existing `forEachMatchingCastCharacter` import (`qwen-voice.ts:47`).

### JSON route (`qwen-voice.ts:600-605` upfront, `:671` write-time)

Upfront (moved after `isStandalone`/`seriesInfo`, per §2):

```ts
const isStandalone = located.state?.isStandalone === true;
const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
if (emotion && await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesInfo ?? undefined)) {
  return res.status(409).json({
    error: clonedVariantRefusal(character.name ?? characterId),
    code: 'clone_protected',
  });
}
```

Write-time:

```ts
const outcome = await persistEmotionVariant(bookDir, characterId, emotion, voiceId, seriesInfo ?? undefined);
if (outcome === 'skippedClone') {
  return res.status(409).json({ error: clonedVariantRefusal(character.name ?? characterId), code: 'clone_protected' });
}
```

The frontend consumer (`src/components/emotion-variant-designer.tsx`'s
`designOne`, lines 145-167) catches any thrown error generically (`catch (e) {
setError(...) }`) with no assumption about *when* the error arrives relative
to GPU progress, so a 409 landing after a previously-always-200 GPU
round-trip needs no frontend change to avoid crashing. With §2's upfront fix,
the *routine* sibling-cloned case never reaches that point at all — it 409s
immediately, before `designOne` even starts its GPU round.

**Noted, not fixed here — a frontend visibility gap for the *residual*
case only.** That same component's `designAll` (`:190-193`) awaits `designOne`
per emotion in sequence, and each iteration's `setError(null)` (`:147`)
clears the previous emotion's error before its own attempt starts — so a
`clone_protected` 409 on one emotion is overwritten by the next emotion's
attempt before the user can read it. With §2's fix in place, this only
matters for the residual-window case (§3) or a genuine mid-GPU-synthesis
clone (§1's original TOCTOU) — no longer the routine "already cloned
elsewhere" case, which now 409s before `designAll`'s loop does any GPU work
per emotion. Flagging as a smaller-scope UI follow-up than v4 identified:
fixing it needs its own UI decision (a persistent per-emotion error list vs.
a toast vs. something else) that a backend consent-gate spec shouldn't make
unilaterally.

### SSE bulk job (`cast-design.ts:430-440` upfront, `:555` write-time)

Upfront:

```ts
if (await hasClonedSlotAmongMatches(character.voiceId ?? character.id, seriesFilter)) {
  job.skipped += 1;
  job.clonedSkips.push({ characterId, name: character.name ?? characterId });
  broadcast(job, { type: 'character_skipped', characterId, name: character.name ?? characterId, reason: 'already_cloned' });
  continue;
}
```

Write-time:

```ts
const outcome = await persistEmotionVariant(job.bookDir, characterId, emotion, voiceId, seriesFilter);
if (outcome === 'skippedClone') {
  job.skipped += 1;
  job.clonedSkips.push({ characterId, name: character.name ?? characterId });
  broadcast(job, { type: 'character_skipped', characterId, name: character.name ?? characterId, reason: 'already_cloned' });
} else {
  job.done += 1;
  broadcast(job, { type: 'variant_designed', characterId, emotion, voiceId,
    ...(fellBackToDesignVoice ? { viaFallback: true, fallbackReason } : {}) });
}
```

## What this does not claim

- **Not fully atomic.** The residual window between `hasClonedSlotAmongMatches`
  passing and the walk reaching each book is real, though far smaller than the
  window this spec closes (GPU-synthesis duration → this function's own walk
  duration). A true atomic veto needs #2000 §3.2's workspace-lock reopened —
  out of scope here, named explicitly rather than silently accepted, per the
  user's own decision above.
- The residual-window case is logged (`console.warn`), not surfaced to either
  caller's user-facing outcome — see §3's rationale for why that's a
  deliberate, narrower disclosure than full per-book reporting, not an
  oversight.
- A concurrent redesign of the *source* character between
  `persistEmotionVariant`'s unlocked outer read (`qwen-voice.ts:185`,
  `baseVoiceId`) and a given target book's write still propagates the OLD key
  — the existing `I4` staleness window, already tracked on #2006, not
  addressed here.
- Does not tear down the just-minted artifact on refusal — see the rationale
  above.
- Does not purge the cached audition MP3 in any case (pre-existing gap,
  shared with the redesign-invalidation path).
- Does not fix the frontend's error-visibility gap for the residual/TOCTOU
  case in a `designAll` run (flagged above as a follow-up, not fixed here).
- Does not address `cast-design.ts`'s base-voice path
  (`applyOverrideToCastFiles`), `cast-link-prior.ts`, or the `voiceUuid`
  double-mint.
- Does not change `#2000` §3.2's lock-granularity decision — reopening it for
  full atomicity is named as a real, larger option above, not taken here.

## Resolved via the `voices.ts` sibling design (v2)

Three questions this spec originally left open for the sibling's own author
are now decided by the user and implemented in
`2026-08-22-clone-consent-voices-override-refusal-design.md`'s v2 revision —
noted here rather than left dangling as still-open follow-ups:

- **The sibling's own write-time re-check is now series-wide too**, using the
  same `hasClonedSlotAmongMatches`-fresh-scan model this spec uses, not the
  narrower per-book independent check v1 of that document chose. See that
  document's "Revision note (v2)".
- **`cast-design.ts:544`'s base-voice call site now mirrors this spec's
  variant branch** — its previously-discarded `{updated, skipped}` return
  routes into the same `job.clonedSkips`/`character_skipped` channel. See
  that document's "Signature change" section.
- **The frontend's book-local `cloned` gate — in both
  `emotion-variant-designer.tsx:125-127` (this spec's own frontend consumer)
  and `profile-drawer.tsx:1102-1111` (the sibling's) — is upgraded to a new
  `clonedElsewhereInSeries` field**, computed via the same
  `hasClonedSlotAmongMatches` function, rather than staying book-local. See
  that document's "Frontend series-awareness" section for the field, the
  call-site diffs, and the reworded user-facing copy. This spec's own
  §"Upfront checks" note above ("does not change the frontend gate") is
  superseded by that section — the frontend gate does change, just via the
  sibling document rather than this one, since the same field serves both
  consumers.

## Testing

Paired tests for `persistEmotionVariant`:

1. Book-scoped, no clone — `'applied'`, variant slot recorded.
2. Book-scoped, clone present at call time — `'skippedClone'`, no field
   mutation. (The achievable race window is between the unlocked read at
   `:151` and lock acquisition at `:200` — a concurrent writer respecting
   `withCastLock` cannot land inside the lock's own critical section by
   definition, so this test injects the clone before the call. For the
   genuine concurrent-write race, follow the existing pattern at
   `qwen-voice.test.ts:1632-1640`.)
3. Series-scoped, two+ linked books, no clones anywhere — all get the
   variant, `'applied'`.
4. Series-scoped, clone present on a **different** linked book (not the
   caller's own) at call time — `'skippedClone'` for the caller, and **no
   book gets the variant, including the un-cloned ones** (verify via direct
   read of every matched book's cast.json).
5. Series-scoped, clone present on the caller's OWN linked book, siblings not
   cloned — `'skippedClone'`, same series-wide no-write assertion as test 4.
6. Series-scoped, no confirmed-cast book matches at all (e.g. every candidate
   fails `state.castConfirmed`) — `'notFound'`, distinguishing this from
   `'applied'` via the walker's own returned count being `0`.
7. Series-scoped, residual-window case: clone appears on one linked book
   *after* `hasClonedSlotAmongMatches` has already returned `false` but
   *before* the walk reaches that specific book (inject directly, simulating
   a race the fresh scan couldn't see) — that one book's write is skipped by
   the closure's defensive re-check, `persistEmotionVariant` still returns
   `'applied'` (since `updated > 0` from the other matched books), and
   `console.warn` is called with a message naming the character.
8. Mutation-verified: deleting the write-time predicate re-check (either the
   series-wide scan call, or the per-book closure backstop) must turn the
   corresponding test red, with the observed failure output captured.

Paired tests for the two call sites:

9. JSON route, upfront: character not cloned in this book but cloned on a
   sibling — asserts a 409 `clone_protected` **before** `designQwenVoiceForCharacter`
   is called at all (mock it and assert zero invocations) — this is the test
   that pins §2's fix and would have failed on v4.
10. JSON route, write-time: mock `persistEmotionVariant` to return
    `'skippedClone'` — assert 409 `clone_protected` with the (new, §4) message.
11. SSE bulk job, upfront: same sibling-cloned setup — asserts `job.skipped`
    incremented and `job.clonedSkips` gains the entry **before** any GPU design
    call for that character (mock `designQwenVoiceForCharacter` and assert zero
    invocations for that character).
12. SSE bulk job, write-time: mock `persistEmotionVariant` to return
    `'skippedClone'` — assert `job.skipped` incremented, `job.clonedSkips`
    gains the entry, and the broadcast event matches the existing
    upfront-skip shape exactly (same `type`/`reason` fields) so the frontend's
    existing handling (`src/store/cast-design-stream-middleware.ts`) needs no
    changes.
