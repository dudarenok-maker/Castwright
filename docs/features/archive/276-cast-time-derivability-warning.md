---
status: stable
shipped: 2026-08-01
owner: null
---

# Cast-time warning — and fix — when a cloned voice cannot render on its routed engine

> Status: stable
> Key files: `server/src/tts/clone-readiness.ts` (new, shared by both sides), `src/store/voice-readiness-selectors.ts`, `src/store/start-generation-flow.ts`, `src/modals/clone-readiness-gate.tsx` (new), `server/src/routes/voice-library.ts`
> URL surface: `#/books/<id>/cast` ("Approve cast & start generating") and `#/books/<id>/generation` ("Resume generation")
> OpenAPI ops: `PATCH /api/voice-library/{voiceUuid}` (**extended**), `POST /api/voice-library/{voiceUuid}/engines/{engine}/retry` (**new**)

Closes #1980. Complements #1933 (PR #1991, merged 2026-07-31 as `d496ce6d`).

> **Revision note — read before proposing a fourth architecture.**
> **Rev 1** chose `classifyClonedVoice` as the oracle. Fatal: it never inspects
> `master.transcript` (`clone-voice-resolver.ts:242-246` tests `entry.master`
> truthiness only), so this plan's motivating scenario classified `repairable`
> with no reason.
> **Rev 2** replaced it with `clonedAssignBlock`. Also fatal: that short-circuits
> on `status: 'ready'` (`voice-library.ts:1268`) *before* checking clip or
> transcript — a deliberate loosening documented at `:1249-1251` as right for
> assign — so a stale-but-`ready` slot with a blank transcript read as fine and
> then hard-failed at render.
> **Both failed the same way: borrowing a predicate written for a different
> question and inheriting its policy.** Rev 3 stops borrowing, defines a
> purpose-built predicate, and drops the bespoke endpoint both earlier revisions
> assumed.
> **Rev 3 was reviewed and its architecture confirmed sound — do not redesign
> again.** Five defects were found *inside* it and are folded in below, flagged
> **[R3]**. The most important is C1: the client never sees the persisted slot
> status, so rev 3 as first written reproduced rev 2's false negative by a new
> route.
>
> **[R4] Path correction, made during implementation.** Every revision wrote
> these routes as `/api/voices/...`. **That is a different, existing endpoint
> family** — `GET /api/voices` (`openapi.yaml:1815`) walks every confirmed
> `cast.json` in the workspace and has nothing to do with the voice library. The
> library is mounted at **`/api/voice-library`** (`app.ts:195`), which is what
> `withComputedStaleness` serves and what the client actually fetches
> (`api.ts:9576`). Corrected throughout. Left uncorrected it would have had
> Task 9 document two routes that do not exist, under a name that collides with
> a real and unrelated one.

## Benefit / Rationale

- **User:** an unrenderable cast is caught at cast time **and fixable there** — not
  merely announced. Requested by the repo owner while scoping #1933: hard-failing
  at render *"leaves it to hard fail not letting them know earlier at cast time to
  allow to fix."*
- **Technical:** removes the last state that is terminal-by-accident. A clip
  ingested without a transcript is currently a permanent brick with no in-app
  recovery; after this it is an editable field.
- **Architectural:** establishes that a pre-flight predicate is purpose-built and
  contract-tested against the render, rather than assembled from predicates
  written for adjacent questions.

## The problem

`/assign` (per #1933) writes **both** engine slots for every cloned entry, so a
character can carry a slot backed by an underivable artifact — a Qwen derive needs
a non-empty `master.transcript`, and a clip ingested without one can never derive.
The resulting 400 is stamped `status: 'failed'` (`clone-voice-resolver.ts:576`, the
**only** non-test writer of that value), which nothing clears. #1933's advisory
fires only at assignment; the likeliest route into the bad state never passes
through assign.

Verified: `resolveCharacterEngine` (`per-character-engine.ts:22-27`) is exactly
`character.ttsEngine ?? projectDefaultEngine`, and the run default is whatever
`modelKey` the individual `POST /:bookId/generation` carried
(`routes/generation.ts:729-738`). There is **no persisted per-book engine** —
`state.json`'s `audioModelKey` is a post-render stamp (`workspace/scan.ts:89-95`)
and `QueueEntry.modelKey` (`workspace/queue-io.ts:45-48`) is a per-entry override.

## Decision 1 — warn and allow, with fixes that actually fix

**Repo-owner decision, taken after seeing the counter-argument: warn-and-allow,
with in-app fix CTAs as a hard requirement.** A gate offering only Proceed and
Cancel does not implement this decision and must fail review.

The counter-argument — a dismissible warning is worse than none, since it is
dismissed every time and the user hits the same failure having been warned — draws
all its force from unactionability. Decisions 6 and 7 remove that.

| Reason | CTA | What it does |
|---|---|---|
| `no-transcript` | **Add transcript** | Decision 6 — sets `master.transcript`, clears the failed slot, voice becomes derivable |
| `derive-failed` | **Retry derive** | Decision 7 — clears the terminal stamp; the predicate then re-evaluates the *underlying* cause |
| `wrong-engine` | **Cast on _<engine>_** | sets `character.ttsEngine`; offered only when Decision 5's `castOnEngine` **[R4]** is non-null, and it names the engine |
| `missing-entry` **[R3]** | **Assign a different voice** | opens the cast profile drawer — the library entry is gone, so re-assignment is the only repair |
| `revoked`, `missing-master` | *(none)* | explanatory copy only — consent withdrawal and a discarded clip have no in-app repair |

**No "switch the book engine back" CTA.** Rev 2 promised one; it cannot be built
honestly. There is no stored previous value to return *to* — the only mutable thing
is the session `ui.ttsModelKey` (`src/store/ui-slice.ts:382`) — and flipping it
moves **every** default-riding character, potentially breaking others to fix one.
Per-character re-casting achieves the same with a bounded blast radius.

## Decision 2 — no new endpoint; compute client-side from data the client already owns

Rev 1 and rev 2 both specified a bespoke `GET /generation/readiness`. **Dropped.**

The frontend holds the full `VoiceLibraryEntry[]` in redux
(`src/store/voice-library-slice.ts:36`, `:210-211`); the cast roster and each
character's `ttsEngine` are in the cast slice; and the engine the render will use
is the session `ui.ttsModelKey` the POST is about to carry. The repo already
accepts a client-side mirror of this rule (`_mockClonedAssignBlock`,
`src/lib/api.ts:9950-9956`).

The verdict is a **pure selector**, and the flow reuses the existing
`fetchVoiceLibrary` thunk (`voice-library-slice.ts:61`, `GET /api/voice-library`) to
ensure entries are present. That matters: `fetchVoiceLibrary` is dispatched from
exactly one place — `src/components/voices/my-voices-section.tsx:30` — so on the
cast view the slice is empty unless the user visited My Voices. The check must
fetch, not assume.

**What this buys.** No new API surface, no OpenAPI change for the readiness path,
no per-character `stat()`, and no possibility of the readiness call and the
generation call disagreeing about the engine — they read the same session value.

**[R3] What the client does NOT see — the correction that matters most.**
`GET /api/voice-library` maps every entry through `withComputedStaleness`
(`routes/voice-library.ts:509-513`, impl `:489-500`), which **overwrites** `status`
with `'stale'` whenever the stored version stamp differs from current — *including
a slot whose persisted status is `'failed'`*. The render reads the raw on-disk
status and checks `'failed'` first (`clone-voice-resolver.ts:238`). So
`{status:'failed', baseModel:'old'}` reaches the client as `{status:'stale'}`, rule
3 misses, and the render hard-fails `derive-failed` — structurally the same false
negative that killed rev 2, arriving by a new route.

Three things follow, all required:

1. **`withComputedStaleness` must stop overwriting a `'failed'` status.** Staleness
   of a failed artifact is meaningless. One-line fix, its own test.
2. **`slotStatus` is defined as the post-`withComputedStaleness` value** — see
   Decision 3's input contract. Server-side callers apply the same transform before
   calling, so both sides see identical input by construction.

   **[R4] "By construction" was false as written, and the plan's own primary flow
   broke it.** The transform was applied on `GET /` **only**. But
   `patchEntry.fulfilled` (`src/store/voice-library-slice.ts:237-240`)
   **replaces** the slice's entry with the PATCH response, so after any edit the
   client held the **raw persisted** status. A version-stale-but-`ready` slot then
   read `'ready'` instead of `'stale'`, rules 5/6 stopped firing, and the result
   is a false negative of exactly the class that killed rev 2 — arriving by a
   *third* route. Decision 6's "Add transcript" CTA is a PATCH, so the fix flow
   itself was the trigger: the gate could clear for the wrong reason.
   **Every route that hands an entry to the client applies the transform**, the
   retry route's no-op path included — a `ready`-but-version-stale slot is both
   the case that no-ops there and the case the transform rewrites, so it is the
   one shape where returning raw changes the answer. Found by checking the
   invariant against *every* entry-returning route rather than only the one this
   decision names.
3. **The contract test routes its client side through `withComputedStaleness`**, or
   it is blind to exactly this class. Rev 3 fed both sides raw entries and would
   have missed it.

**What stays invisible — accepted.** Whether the `.pt` exists on disk, and whether
the master clip file still exists. This check catches **artifact-metadata**
problems, not **disk-integrity** ones; a manifest naming a since-deleted clip still
reaches the render. Every state #1980 is about is metadata-visible. Do not "fix"
this by restoring the endpoint without re-reading this section.

## Decision 3 — a purpose-built predicate, one shared module

The question: **"if this character renders on engine E, will its cloned voice
resolve — assuming the machine is up?"**

```ts
// server/src/tts/clone-readiness.ts — pure, no I/O, imported by BOTH sides
export type CloneUnready =
  | 'revoked' | 'wrong-engine' | 'derive-failed'
  | 'missing-master' | 'no-transcript' | 'missing-entry';

export interface CloneReadinessInput {
  /** false when the character's libraryUuid resolves to no entry at all. [R3] */
  entryFound: boolean;
  consentRevoked: boolean;
  /** POST-`withComputedStaleness` status of `entry.engines[manifestSlotFor(engine)]`.
      Both sides MUST apply that transform first — see Decision 2. [R3] */
  slotStatus: string | undefined;
  hasMaster: boolean;
  transcript: string | undefined;
  engine: TtsEngine;
  /** `hasClonedProvenance(character, engine)` — the CHARACTER's own cast slot for
      this engine, NOT the library entry's slot. See the trap below. [R3] */
  characterHasSlot: boolean;
}

export function cloneReadiness(input: CloneReadinessInput): CloneUnready | null;
```

Rules, in order — the order is the contract:

1. `!entryFound` → `missing-entry`. **[R3]**
2. `consentRevoked` → `revoked`.
3. `engine` is not clone-capable, or `!characterHasSlot` → `wrong-engine`.
4. `slotStatus === 'failed'` → `derive-failed`.
5. `slotStatus !== 'ready' && !hasMaster` → `missing-master`. **[R3]**
6. `slotStatus !== 'ready' && engine === 'qwen' && !transcript?.trim()` →
   `no-transcript`. **[R3]**
7. otherwise → `null` (ready, or needs a derive that will succeed).

**[R3] Why rules 5 and 6 are gated on `!== 'ready'`.** `classifyClonedVoice` only
reaches `missing-master` *via* `needsDerive` (`clone-voice-resolver.ts:241-246`): a
`ready` slot with a live `.pt` and no master is **healthy**, an explicitly
supported state (`voice-library.ts:1249-1251`). Ungated, rule 5 warns on a working
voice with no CTA, and rule 6 would tell the user to "fix" a voice that renders —
after which Decision 6's write would flip `transcriptSource` on a healthy entry.
Rev 2 died on a false negative here; ungated, rev 3 would have overcorrected into a
false positive. The gate is sound client-side precisely because of Decision 2's
fix: a client `'ready'` already implies not-version-stale. The residue — a `ready`
slot whose `.pt` was deleted — is the disk-integrity gap Decision 2 accepts.

**[R3] The `characterHasSlot` trap — this is where rev 1's bug would return.**
`characterHasSlot` is the **cast** slot: `hasClonedProvenance(character, engine)`
(`clone-engines.ts:113-124`), single-engine. It is **not**
`characterHasClonedSlot`, which takes one argument and is engine-*agnostic*
("cloned on ANY clone-capable engine", `:77-94`) — wiring that in makes rule 3 true
for any cloned character, reinstating the generic-substitution trap. And it is
**not** the library entry's slot: a voice cloned on Qwen has no `xtts` slot
(`voice-library.ts:1126` writes only `qwen`), so reading the library slot makes the
ordinary Coqui-routed case return `wrong-engine` — rev 1's exact fatal bug.

**Rule 7 is load-bearing.** A Qwen-cloned voice used on a Coqui-routed character
that *does* carry a coqui cast slot needs a derive, and that derive will succeed.
This is the ordinary first-render-on-the-second-engine path and must stay silent.
Post-#1933 assign writes both cast slots, so it is the common case; a pre-#1933
cast carrying one slot correctly returns `wrong-engine`, matching the render
(`clonedEngineFor` sets `wrongEngine: routedEngine !== engine`,
`synthesise-chapter.ts:1512-1531`, `:1567`).

**Machine state is deliberately absent.** No `engineUnavailable`, no
`currentArtifactVersion`. Engine availability is a machine question owned by
`routes/setup-readiness.ts` and the dual-model advisory (`generation.ts:955-965`).
Admitting it would let a cold-boot "engine not loaded yet" — the normal state
before generation — pre-empt every artifact verdict and blank the whole check,
because `classifyClonedVoice` is a short-circuiting chain returning one winner
(`:234-247`).

**One implementation, imported by both sides.** The frontend can import server
modules: `src/data/help-failures.ts:7-10` is a real production-bundle precedent
(consumed by `src/views/help.tsx:18`), and its target has zero imports.
`clone-engines.ts` is genuinely browser-safe — one `import type { TtsEngine }`, no
node builtins, no I/O. The structural `CloneReadinessInput` keeps
`VoiceLibraryEntry` (declared in `workspace/voice-library.ts`, which *does* pull
node builtins) out of the browser bundle rather than relying on `import type`
erasure; each side adapts its own shape at the call site.

**[R3] Task-1 build gate.** No existing precedent proves that a **value** import
carrying a `.js` specifier inside a server module resolves under `vite build` —
`help-failures.ts`'s target has no imports at all, and the `api.config.test.ts`
precedent is test-only with a type-only import. `clone-readiness.ts` →
`./clone-engines.js` (for `isCloneEngine`) would be the first. This very probably
works, but a twice-rewritten plan should not rest on that: **Task 1 runs
`npm run build` and greps `dist/assets` for a `clone-readiness` symbol**, and
records the result here before any other task starts.

> **Gate result — PASSED, 2026-08-01.** A throwaway `server/src/tts/clone-readiness.ts`
> value-importing `isCloneEngine` from `./clone-engines.js`, imported (extensionless,
> matching the `help-failures.ts` precedent) from `src/data/help-failures.ts`:
> `npm run build` succeeded and the probe's marker string landed in
> `dist/assets/help-failures-*.js`, i.e. Vite resolved the `.js` specifier to the
> `.ts` source and bundled the value. `npm run typecheck` (frontend `tsc --noEmit`,
> `moduleResolution: Bundler`) was clean over the same import. Decision 3's
> shared-module approach stands as written; the probe was reverted before Task 2.


**Binding to the render.** A shared module removes implementation drift but not
behavioural drift — `cloneReadiness` is still a second opinion about what
`resolveClonedVoicesForChapter` (`clone-voice-resolver.ts:415`) will do. A
**co-oracle contract test** is mandatory: one fixture table through both,
asserting agreement wherever both have an opinion, with the client side routed
through `withComputedStaleness` per Decision 2.

## Decision 4 — engine resolution mirrors the render

Per character: `character.ttsEngine ?? engineForModelKey(ui.ttsModelKey)` — the same
two-tier resolution as `resolveCharacterEngine` (`per-character-engine.ts:22-27`),
reading the same session value the generation POST will send. The verdict and the
render therefore cannot disagree about routing, which is what "survives a
book-level engine switch" reduces to.

## Decision 5 — entry condition, `castOnEngine`, and its own modal

**Entry condition: any character carrying a cloned slot**, via
`characterHasClonedSlot(character)` (`clone-engines.ts:77-94`) — *not* "any cloned
voice on a clone-capable engine". Rev 2's phrasing excluded the character routed to
Kokoro/Gemini/Piper, which is precisely the `wrong-engine` case it also listed in
its warn set. Routing is what the check *evaluates*, never what gates it.

**[R3] Two known bypasses, both named rather than silently inherited:**

- **Legacy bare-uuid characters.** `synthesise-chapter.ts:1601-1618` (#1891) builds
  resolver requests for characters where `characterHasClonedSlot` is **false** — a
  legacy qwen slot carrying a `libraryUuid` with no `provenance`. Those renders
  hard-fail like any other, so the entry condition must also admit "carries a
  `libraryUuid` on a cloned-capable slot without provenance", or this class is
  permanently unchecked and the contract's "agree wherever both have an opinion" is
  false over it.
- **Empty roster on cold mount.** `e2e/start-generation-tier-prompt.spec.ts:42-52`
  documents that `cast.characters` is `[]` on a cold route mount, so the thunk
  starts generation with no modal. The clone check inherits that and does not fire.
  Accepted and named, not described as "guarded".

**The tier prompt keeps its guard.** `startGenerationFlow`
(`src/store/start-generation-flow.ts:30-50`) short-circuits on `castRendersOnQwen`
(`:22-28`), which gates **two** things: the readiness gate (`:44-47`) and
`openStartGenPrompt()` (`:48`). The clone check gets its own entry condition and
early return; the tier prompt keeps `castRendersOnQwen`. A Coqui-only cast must
reach the clone gate and must **not** see a tier chooser.

**[R4] `otherEngineOk` became `castOnEngine: CloneEngine | null`.** The formula
below is kept for its reasoning, but "the other engine" is not well defined and
the boolean was not sufficient:

- **Not well defined.** A blind binary swap (`engine === 'qwen' ? 'coqui' :
  'qwen'`) lands on `'qwen'` for *any* non-qwen engine. So a character routed to
  **Kokoro** whose voice is cloned only on **Coqui** scored `false` and got a
  `wrong-engine` verdict with **no CTA** — even though re-casting to Coqui works.
  Decision 1 says a gate with no fix must fail review, and Decision 5
  *deliberately* admits the Kokoro-routed character, so the formula failed a case
  this very decision includes on purpose.
- **Not sufficient.** Decision 1's CTA is labelled "Cast on _<engine>_". A boolean
  cannot supply that name when the routed engine is Kokoro. The shape had to
  change for the modal regardless of the bug.

Now: scan `CLONE_ENGINE_LIST`, **excluding the character's routed engine**, and
take the first candidate for which the formula below returns `null`.
`CLONE_ENGINE_LIST` order is the deterministic tie-break when a character carries
both cloned slots — arbitrary but stable, not accidental. This **subsumes** the
binary case exactly: a qwen-routed character has only `coqui` as a candidate.

The routed-engine exclusion is **semantically right but not currently
distinguishable by any test**, and that was verified rather than assumed:
re-including the routed engine recomputes `characterHasSlot` to the same value
that produced the `wrong-engine` verdict, so it always self-rejects on rule 3.
It is kept as defence against a third clone-capable engine or a relaxed rule 3.
Do not delete it as dead, and do not write a test that pretends to cover it.

The per-candidate formula is unchanged:
`cloneReadiness({...input, engine: candidate, characterHasSlot: hasClonedProvenance(character, candidate)}) === null`.
**[R3]** Note the exact helper and arity: rev 3 wrote
`characterHasClonedSlot(character, otherEngine)`, which takes one argument and is
engine-agnostic — written literally it does not compile, and "fixed" by dropping
the argument it is true for any cloned character, making the CTA always appear.
Round 2 found this always-*false*; rev 3 made it always-*true*.

**[R3]** The reason to gate the CTA is not generic substitution. Re-casting a
character that lacks the other engine's cloned slot makes `clonedEngineFor` fall
back to whichever engine *does* carry it and set `wrongEngine: true`
(`synthesise-chapter.ts:1512`, `:1567`), so the chapter **hard-fails**
diagnosably (`:1507-1511`). Gating is still right — arguably more so — but the
mechanism cited must be the correct one.

**A new modal, not the existing one.** `src/modals/voice-readiness-gate.tsx` is
welded to the undesigned-Qwen concern: rows from `selectUndesignedQwenCharacters`
(`voice-readiness-selectors.ts:28-50`), copy promising a *"generic fallback voice"*
(~`:137` — false here; a cloned voice hard-fails), primary CTA "Design full cast"
(`:147-149`, which would design nobody), and `onProceedAnyway` dispatching
`openStartGenPrompt` (`:84-87`) — reintroducing the tier prompt this decision
forbids. A separate `clone-readiness-gate.tsx` is cheaper than branching it. When
both conditions hold, the voice-readiness gate shows first (no voice at all is the
more basic problem), then the clone gate.

**Async, failure posture, double-click.** The thunk becomes async; both dispatch
sites (`src/routes/index.tsx:775`, `src/views/generation.tsx:1068`) are
fire-and-forget `onClick`, so an ignored Promise is safe — `no-floating-promises`
is off, since `eslint.config.mjs` sets no `project`/`projectService`. **On fetch
failure the flow fails open** — it starts generation rather than blocking on an
advisory it could not compute — and the CTA **disables while in flight**.

## Decision 6 (folded) — a transcript becomes editable after the clone

Folded on the repo owner's instruction ("no follow ups, fix it now"). This makes
Decision 1's primary CTA real.

Extend `PATCH /api/voice-library/{voiceUuid}` (`routes/voice-library.ts:528-587`) to accept
`transcript`:

- Rejected unless `provenance === 'cloned'` and `existing.master` is present.
- Reuses the existing `MAX_CLONE_TRANSCRIPT_CHARS` cap
  (`routes/voice-library.ts:108`).
- Sets `master.transcript` and `master.transcriptSource = 'user'` — already typed
  `'whisper' | 'user'` (`workspace/voice-library.ts:56`), so the shape anticipated
  this; only the write path was missing.
- Writes through the existing per-uuid-locked `updateEntry` RMW
  (`routes/voice-library.ts:568-578`; the lock itself is `withEntryLock`,
  `workspace/voice-library.ts:288-298`), spreading over the **fresh** read.
- **Clears a `failed` slot** when the new transcript is non-empty — the cause is
  gone, so the stamp goes with it (Decision 7 defines how).

**[R3] Three invalidations rev 3 missed:**

- `entry.sampleTranscript` is a **second persisted copy** of the same text, written
  from `refText` at clone time (`routes/voice-library.ts:1115`). Editing
  `master.transcript` alone leaves the two disagreeing and the UI reading the stale
  one. **Update both.**
- The qwen `.pt` distilled against the old ref text is **not** invalidated. That is
  correct — it is acoustic, not lexical — but the plan must say so rather than
  leave it unconsidered.
- `master.languageCode` / `entry.languageCode` are Whisper stamps promoted at clone
  time and sent to the sidecar as `X-Language`. A user-edited transcript in another
  language leaves them wrong. **Re-detect or clear them**; do not silently keep a
  stamp the new text contradicts.

Frontend: the clone wizard already ships an editable transcript textarea with the
cap enforced (`src/components/voices/clone-capture-panel.tsx:80`, tested at
`clone-capture-panel.test.tsx:69,91,98`). Extract it for reuse rather than writing
a second one.

Fixture note: `VoiceMaster.transcript` is a **required `string`**
(`workspace/voice-library.ts:51-56`), so "ingested without a transcript" is `''`,
not an absent field. A fixture omitting it will not typecheck.

## Decision 7 (folded) — a `failed` slot can be cleared

`POST /api/voice-library/{voiceUuid}/engines/{engine}/retry` **deletes the engine's slot
key** from `entry.engines`, through the same `updateEntry` lock. **[R3]** Deletion
rather than a status rewrite: `VoiceLibraryEngineStatus.status` is required
(`workspace/voice-library.ts:24-29`) so there is no "unset", and an absent slot
flows correctly through `classifyClonedVoice:241-246` as "never derived". A fresh
derive rewrites the slot with its own version stamp. Nothing else needs resetting —
`master`, the clip, and the `.pt` are all fine to leave.

**[R3] Why this does not reintroduce the loop it exists to prevent.** Clearing a
stamp is not a fix, and a CTA that silently reported success would recreate #1980.
It does not, because rule 4 is ordered *before* rules 5 and 6: once the stamp is
gone, the predicate re-evaluates the **underlying cause**. A `derive-failed` voice
with a blank transcript immediately reports `no-transcript` and the gate stays up
with the CTA that actually fixes it. Only a failure whose cause is not expressible
in rules 5–6 (a sidecar OOM, say) clears to `null` and can fail again — that
residue is real, is why the CTA is labelled "Retry derive" rather than "Fix", and
a repeated failure simply re-stamps.

**[R3] The policy argument, corrected.** Rev 3 claimed
`clone-voice-resolver.ts:229-231` "explicitly anticipates an external clearer".
That is not a fair reading — the comment says *"a retry has to come from a fresh
derive attempt that clears it"*, i.e. a derive that clears the stamp as part of
doing the derive, not a standalone endpoint. The defensible argument is from
**intent**: the operative word is *"never **silently** retried"*, and the policy
exists to stop the render re-attempting on every chapter. A user-initiated,
explicit clear is not a silent retry. Argue it that way; do not put words in the
author's mouth.

## Invariants to preserve

1. `resolveCharacterEngine` stays `character.ttsEngine ?? projectDefaultEngine`
   (`per-character-engine.ts:22-27`). Decision 4 mirrors it; it must not fork.
2. Library slots are keyed `qwen` / **`xtts`** (`workspace/voice-library.ts:31-34`);
   cast overrides key Coqui as **`coqui`**. Every library read goes through
   `manifestSlotFor` (`clone-engines.ts:49-51`). Never index `entry.engines.coqui`.
3. `classifyClonedVoice` stays pure (`clone-voice-resolver.ts:223`) and keeps its
   precedence — `revoked` (`:234`), `wrongEngine` (`:235`), `engineUnavailable`
   (`:236`), slot status (`:238`). This plan does not modify it.
4. A cloned voice is never silently substituted with a generic one.
5. `updateEntry`'s per-uuid lock spans read-through-write (`withEntryLock`,
   `workspace/voice-library.ts:288-298`). Decisions 6 and 7 write through it, never
   via a bare `readEntry`+`writeEntry`.

## Test plan

Three revisions of this plan shipped placebo tests that review caught; #1933
shipped **ten** instances of "engine-parameterised behaviour pinned in one
direction only". Every test is **mutation-verified against the producer**, and the
mutation that must turn it red is named. **[R3]** marks tests added or repaired
after round 3 — including two of rev 3's own that were themselves placebos.

**Predicate (`server/src/tts/clone-readiness.test.ts`)** — a fixture **table** over
`entryFound` × `consentRevoked` × slot status × master × transcript × engine ×
`characterHasSlot`.

- Rule 7 silence: no derive yet, master + transcript present, coqui cast slot
  present, Coqui → `null`. *The most important case* — rev 1's fatal bug and the
  ordinary healthy path.
- `no-transcript` on Qwen; the identical input on Coqui → `null`.
- `slotStatus: 'ready'` + blank transcript + Qwen → `null`. Mutation: ungate rule 6
  → red. **[R3]** (rev 3's false positive)
- `slotStatus: 'ready'` + `hasMaster: false` → `null`. Mutation: ungate rule 5 →
  red. **[R3]**
- `slotStatus: 'stale'` + blank transcript + Qwen → `no-transcript`.
  **[R4] Mutation corrected:** rev 3 named "restore rev 2's
  `status === 'ready' → null` short-circuit". That mutation is **inert** — the
  guard is false for a `'stale'` input by construction, so it cannot redden any
  fixture, and an implementer who runs it as written gets a green suite and a
  false all-clear. The mutation that actually targets this case is **narrowing
  rule 6's gate from `slotStatus !== 'ready'` to `slotStatus === undefined`**
  (i.e. "only warn if never derived"), which is the plausible wrong
  implementation. Verified red on exactly this case.
- `entryFound: false` → `missing-entry`. **[R3]**
- **[R4] One case per verdict — rules 2, 4 and 5 must each be asserted
  positively**, on an otherwise-healthy input: `consentRevoked` → `revoked`,
  `slotStatus: 'failed'` → `derive-failed`, and (on **Coqui**, so rule 6 cannot
  supply the verdict instead) `!hasMaster` → `missing-master`. Without these,
  each of those three rules can be **deleted outright** with the whole suite
  still green — measured, not hypothesised. Every mutation rev 3 named probes a
  gate or an ordering; **none probes existence**, so the named list passed in
  full against a predicate missing half its rules. Existence mutations are part
  of the bar, not an extra.
- `wrong-engine` outranks slot status on a **doubly-broken** input (not
  clone-capable *and* a `failed` slot); with a healthy slot, precedence is untested
  and reversed-order code passes.
- **[R3] Deleted as a placebo:** rev 3's "asymmetric `derive-failed` fixture". Its
  rationale ("a symmetric fixture passes when the wrong slot is read") applies to a
  predicate that indexes `entry.engines[manifestSlotFor(engine)]` itself.
  `CloneReadinessInput` receives `slotStatus` **pre-computed**, so asymmetric and
  symmetric fixtures are the identical test. The wrong-slot bug now lives in the
  call-site adapter — covered at selector level below.
- **[R3] Deleted as a tautology:** rev 3's "machine state is absent: no input can
  express engine-unavailability". That is a type-level fact, not a behaviour test;
  it cannot fail against any implementation.

**Adapter (`src/store/*.test.ts`) [R3]** — where the real wrong-slot and
wrong-helper bugs live, and where rev 3 had no coverage:

- `characterHasSlot` is wired to `hasClonedProvenance(character, engine)`. Mutation:
  wire it to the library slot → the rule-7 case returns `wrong-engine` → red.
  Mutation: wire it to engine-agnostic `characterHasClonedSlot` → the CTA-hidden
  case goes wrong → red.
- `slotStatus` is the post-`withComputedStaleness` value.
- **The C1 regression:** `{status:'failed', baseModel:'old'}` served through
  `GET /api/voice-library` still yields `derive-failed`. Mutation: restore
  `withComputedStaleness`'s overwrite of a failed status → red.

**Co-oracle contract (`server/src/tts/clone-readiness-contract.test.ts`)** — the
fixture table through `cloneReadiness` and through
`resolveClonedVoicesForChapter`, **client side routed through
`withComputedStaleness`** [R3]. **[R3]** The table must carry a `consentRevoked`
axis and one doubly-broken row per adjacent rule pair (1v2, 2v3, 3v4, 4v5, 5v6) —
rev 3's stated axes omitted consent, so a rule-1-vs-2 flip had no fixture to catch
it and the "flip one rule's order → red" mutation was not guaranteed.

**Selector / thunk**

- Fires for a **Coqui-only** cloned cast (mutation: restore the `castRendersOnQwen`
  short-circuit) **and** its complement — that cast must **not** open
  `startGenPrompt`.
- Fires for a character routed to **Kokoro**.
- **[R3]** A qwen-cloned voice on a coqui-routed character with both cast slots
  present → the gate does **not** fire. Rule-7 silence at the level where the
  adapter actually runs; rev 3 tested this only via a hand-set `characterHasSlot`,
  the exact value a mis-wired adapter gets wrong.
- `fetchVoiceLibrary` is dispatched before the verdict is computed.
- Fetch failure → generation **starts** (fail-open); the CTA disables while in
  flight.
- Fires from **both** dispatch sites, including "Resume generation".
- Existing thunk tests: the shared `run()` helper
  (`start-generation-flow.test.ts:40`) needs `await`, plus awaiting it per case.

**CTA presence — makes Decision 1 self-enforcing.** Rev 2 pinned only what a CTA
does when present, so the suite stayed green on a gate that violated the decision.
**[R3]** Assert the **specific** CTA per reason from Decision 1's table — "a fix
CTA is rendered when one exists" is satisfiable by a single always-on button:

- each reason renders its own CTA and no other;
- `revoked` / `missing-master` render explanatory copy and **no** CTA;
- **[R4]** "Cast on _<engine>_" is **hidden** when `castOnEngine` is null, and
  when it is non-null the button **names that engine** — a Kokoro-routed
  character cloned only on Coqui must read "Cast on Coqui", not "Cast on Qwen"
  and not a generic label. A test asserting only that *some* re-cast button
  appears passes against the blind-swap bug this replaced.

**Decisions 6 & 7 (`server/src/routes/voice-library.test.ts`)**

- `transcript` on a `designed` entry → 400; over the cap → 400; on a cloned entry →
  persisted with `transcriptSource: 'user'`.
- **[R3]** `entry.sampleTranscript` is updated in the same write; language stamps
  are re-detected or cleared.
- A non-empty transcript **clears** a `failed` slot; `''` does **not**.
- The retry route **deletes** the slot key and is a no-op on a `ready` slot.
- Both write through `updateEntry` (mutation: swap to `readEntry`+`writeEntry` →
  red on a concurrent-write fixture).
- **[R3]** `withComputedStaleness` no longer overwrites a `failed` status, and
  still computes staleness for every other status.

**Build gate [R3]** — `npm run build` succeeds and `dist/assets` contains a
`clone-readiness` symbol. Rev 3's "browser-safety guard" asserted an import list in
**source**, which stays green while `vite build` fails on resolution, and covered
only `clone-readiness.ts` while the bundle also pulls `clone-engines.ts`. A source
assertion may stay as a cheap tripwire; it does not replace the build check.

**E2E** — a cast with a transcript-less cloned voice reaches the gate, the modal
names character/engine/reason, **Add transcript** saves and the gate clears, and a
second pass starts generation.

**Mock mirror** — mocks for the extended PATCH and the retry route. Note
`otherCloneEngineSlot` already exists at `src/lib/api.ts:9946` (slot keys
`qwen`/`xtts`) and `otherCloneEngine` at `routes/voice-library.ts:1220` (engines
`qwen`/`coqui`) — different functions, similar names; do not add a third of either.

### Manual acceptance walkthrough

1. Ingest a clip **without** a transcript; assign it while the session engine is
   Coqui → 200 with #1933's advisory.
2. Switch the session engine to Qwen; do not touch the cast.
3. "Approve cast & start generating" → gate names the character, Qwen,
   missing-transcript, and offers **Add transcript**.
4. Add a transcript, save → gate clears; re-open → no warning for that character.
5. Generate one chapter → the cloned voice renders on Qwen.
6. **Control A:** switch back to Coqui at step 3 → **no** gate.
7. **Control B:** a Qwen-cloned voice, coqui-routed character, both cast slots
   present, clip and transcript present → **no** gate.

Controls 6 and 7 are not optional: steps 1–5 pass equally well against a check that
always warns.

## On-box acceptance

Steps 1–7 need a real sidecar and a real cloned voice and cannot be proven in the
PR. If not run before merge this ships with a row in
`docs/testing/onbox-acceptance-register.md` — recording is a merge gate, running is
not.

## Before shipping

- `docs/release-notes-next.md` **and** the in-progress section of `RELEASE_NOTES.md`.
- `docs/features/INDEX.md` — new entry for plan 276.
- `openapi.yaml` for the extended PATCH and the new retry route, then
  `npm run openapi:types`; verify by regenerating and confirming `git status` is
  clean (`openapi-typescript` emits `description:` prose as JSDoc, so even a
  prose-only edit staleness-fails CI).
- `Closes #1980` in the **PR body**.
- `npm run backlog:sync` — #1980 is `type:feature`.

## Suggested follow-ups

None. Both of rev 2's follow-ups were folded in as Decisions 6 and 7 on the repo
owner's instruction.

## Ship notes

**Shipped 2026-08-01** — PR [#2067](https://github.com/dudarenok-maker/Castwright/pull/2067),
merge commit `8127c68e`. Closes #1980.

All nine tasks landed, plus the e2e spec. Four defects were found and fixed
during implementation rather than filed: `withComputedStaleness` overwriting a
persisted `'failed'` status; the same transform running on `GET /` only, so
`patchEntry.fulfilled` put a raw status back in the slice and the plan's own
"Add transcript" CTA could clear the gate for the wrong reason; `otherEngineOk`'s
blind binary engine swap, replaced by `castOnEngine`; and six misleading
`baseModel: 'current-model'` fixture stamps. Each is recorded as an `[R4]` note
against the decision it corrects.

**Four placebo tests were caught and repaired**, one of them authored by this
plan. Rules 2, 4 and 5 of the predicate could each be deleted outright with the
whole suite green, because every mutation the plan named probed a gate or an
ordering and none probed existence; the transcript-lock test pinned only the
first of the handler's two reads of the fresh snapshot; the contract test's 1v2
row was not actually doubly-broken; and the fail-open test exercised a branch
that could not execute, because a `createAsyncThunk` dispatch never rejects
without `.unwrap()`. That last one meant the gate failed **closed** — reporting
`missing-entry` for every cloned character whenever `GET /api/voice-library`
failed. Found by the `code-review` gate, not by the suite.

**Owed on-box acceptance:** register row **A21** and
[`docs/testing/clone-readiness-gate-onbox-acceptance.md`](../../testing/clone-readiness-gate-onbox-acceptance.md).
No automated layer proves that pressing the CTAs repairs the render — they all
stop at the API response — and `derive-failed` / "Retry derive" is unreachable
in mock mode by construction.

**Follow-ups filed:** [#2054](https://github.com/dudarenok-maker/Castwright/issues/2054)
(a cloned slot with no resolvable `libraryUuid` gets no verdict while the render
hard-fails `misconfigured`) and
[#2068](https://github.com/dudarenok-maker/Castwright/issues/2068) (four residual
gaps from the review, incl. a debounce race between "Cast on _engine_" and
"Proceed anyway").
