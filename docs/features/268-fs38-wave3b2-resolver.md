---
status: active
shipped: null
owner: null
---

# 268 — fs-38 Wave 3b2: cloned-voice resolver + lifecycle

> Status: active
> Key files: `server/src/tts/clone-voice-resolver.ts`,
> `server/src/tts/synthesise-chapter.ts` (the resolver pre-pass, `applyQwenFallback`
> backstop, `UnresolvableClonedVoiceError` re-export), `server/src/workspace/purge-clone-artifacts.ts`,
> `server/src/workspace/paths.ts` (`qwenVoiceWavPath`), `server/src/routes/voice-library.ts`
> (revoke/delete wiring, assign-time wrong-engine guard, ECAPA-transport tolerance),
> `server/src/routes/failure-taxonomy.ts` + `failure-remediations.ts` (`cloned-voice-broken`),
> `server/tts-sidecar/main.py` (`_atomic_torch_save`, `design_voice` clip-persist),
> `src/store/generation-stream-runner.ts` (toast + help link),
> `src/components/voices/voice-library-card.tsx` (Broken/Repairable chip),
> `src/components/voice-library-panel.tsx`, `src/mocks/voice-library.ts`,
> `openapi.yaml` (`FailureCode`, the assign body's optional `modelKey`)
> URL surface: `#/voices` (My voices — cloned cards now show a Broken/Repairable
> state chip); the generation view (a `cloned-voice-broken` chapter failure now
> toasts immediately with a help link)
> OpenAPI ops: `POST /api/voice-library/{voiceUuid}/assign` (new optional `modelKey`
> body field), `GET /api/help/failures` (`FailureCode` enum extended)

Source spec: [`docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`](../superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md) §5 (resolver), §5.4 (fail-fast), §5.5 (1.7B), §5.6 (purge), §2.3 (clip-persist)
Implementation plan: [`docs/superpowers/plans/2026-07-25-fs38-wave3b2-resolver.md`](../superpowers/plans/2026-07-25-fs38-wave3b2-resolver.md)
Continues: [`267-fs38-wave3-voice-clone.md`](267-fs38-wave3-voice-clone.md) (3a ingest/consent/recorder + 3b1 first Qwen clone)
Umbrella doc: [`194-voice-cloning.md`](194-voice-cloning.md) · fs-38 · [#624](https://github.com/dudarenok-maker/Castwright/issues/624)

## Benefit / Rationale

- **User:** a cloned voice now either sounds like the person it was built from,
  or the chapter fails loud and tells you why — never a silent stand-in. If Qwen
  is briefly unreachable, or a `.pt` cache goes stale, Castwright quietly rebuilds
  it from the retained sample before the line is spoken; if the voice was
  revoked, misconfigured, or genuinely can't be rebuilt, the chapter stops and
  the voice-library card marks it "Needs attention" instead of the audiobook
  quietly slipping into a different voice. Revoking a voice now actually erases
  everything Castwright could rebuild it from.
- **Technical:** closes the resolver/lifecycle half of the never-substitute
  invariant that 3b1 only partially covered (a single `applyQwenFallback`
  exemption). Adds a reusable, dependency-injected classifier +
  async-orchestrator pair (`clone-voice-resolver.ts`) that both the synthesis
  path and (for designed voices) a gentler self-heal path can call, plus a
  single `purgeCloneArtifacts` erasure routine reused by both revoke and delete
  so the two flows can no longer diverge on what gets wiped.
- **Architectural:** establishes the pre-pass pattern — validate every
  in-chapter cloned voice's health BEFORE any synth call, not interleaved with
  it — as the seam any future engine's clone support (3c XTTS) plugs into. Also
  fixes a real corruption window (#1804): the sidecar's `.pt` writes for both
  `clone_voice` and `design_voice` are now atomic (temp file + `os.replace`),
  matching the pattern the 1.7B path already used.

## Architectural impact

- **New seams / extension points:**
  - `server/src/tts/clone-voice-resolver.ts` — a pure classifier
    (`classifyClonedVoice: ClassifyInput -> ClonedVoiceState`) plus two async
    orchestrators: `resolveClonedVoicesForChapter` (cloned voices — throws on
    Broken) and `resolveDesignedVoicesForChapter` (designed voices — Task 12,
    §2.3 — best-effort, never throws). Both take fully injected deps, so the
    classifier and orchestrator logic are unit-testable with zero real fs/
    sidecar access.
  - An async **per-chapter pre-pass** in `synthesiseChapter`
    (`server/src/tts/synthesise-chapter.ts`, right after
    `buildSentenceGroups`/`castById` and before the title beat) that calls the
    cloned-voice resolver over exactly the cloned Qwen voices whose character
    speaks in this chapter, then (Task 12) the designed-voice self-heal over
    the same in-chapter set.
  - `purgeCloneArtifacts(uuid, { deleteEntryDir? })`
    (`server/src/workspace/purge-clone-artifacts.ts`) — the single erasure
    routine both `/revoke` and `DELETE /:voiceUuid` now call; erases the base
    `.pt`, `__1.7b.pt`, `.json`, both `-preview` variants, `__master.wav` (a
    designed voice's Task-11 retained clip) and `-preview__master.wav` (a
    preview design's retained clip — a 2nd consent-erasure gap the Task-11
    review found and fixed alongside the first), then the sample cache, then a
    best-effort sidecar cache-evict (files first, sidecar last).
  - `qwenVoicePtPath` moved from `routes/qwen-voice.ts` to
    `server/src/workspace/paths.ts`, alongside a new `qwenVoiceWavPath` —
    both are now the single source of truth for a qwen voice's on-disk
    artifact paths, consumed by `purge-clone-artifacts.ts` and the resolver's
    default dependency wiring.
  - `FailureCode` gains `'cloned-voice-broken'`
    (`server/src/routes/failure-taxonomy.ts`, `failure-remediations.ts`,
    `openapi.yaml`, regenerated `src/lib/api-types.ts`) — a distinct,
    reason-neutral chapter-failure code for `UnresolvableClonedVoiceError`,
    consumed by the frontend's toast + help-link surfacing
    (`generation-stream-runner.ts`, `src/data/help-failures.ts`).
  - `BrokenClonedVoice.reason` gains `'wrong-engine'` — distinct from
    `'engine-unavailable'` — for a cloned voice assigned on a book/character
    that simply doesn't route to Qwen at all (Qwen itself may be healthy).
  - `POST /:voiceUuid/assign` gains an optional `modelKey` body field
    (OpenAPI-first) — a client-side advisory guard that 409s a cloned-voice
    assign at assign time when the caller's *intended* render engine (the
    session/pending engine choice, not the persisted default) isn't Qwen.
- **Invariants preserved:** the 3b1 `applyQwenFallback` cloned-voice exemption
  (267's Invariant 9) is untouched and now documented as a **backstop**, not
  the live guard — the resolver pre-pass runs first in production and always
  throws before that branch is reached (see Invariant 1 below). The write-time
  consent guard (267's Invariant 1) and the assign-readiness gate (267's
  Invariant 10) are unchanged.
- **Migration story:** additive only. No `cast.json`/voice-library manifest
  shape change — `resolveClonedVoicesForChapter` only writes
  `engines.qwen.{status,baseModel}` fields that already existed pre-3b2. A
  pre-Wave-3 entry (no `master`, no `consent`) never enters the cloned
  resolver path at all (it's gated on `provenance === 'cloned'`).
- **Reversibility:** everything here is inert for a non-cloned character; a
  revert leaves designed/imported voices and pre-existing cloned entries
  exactly as `resolveClonedVoicesForChapter` never having existed — the only
  behavioural loss is the fail-fast/re-derive/purge coverage this wave adds.

## Invariants to preserve

1. **A cloned voice is never silently substituted.** The async per-chapter
   pre-pass in `synthesiseChapter` (`server/src/tts/synthesise-chapter.ts:1172-1212`)
   classifies every in-chapter cloned voice Healthy/Repairable/Broken **before
   any synth call** (title or body); any Broken voice aborts the whole chapter
   via `UnresolvableClonedVoiceError.fromList` (`clone-voice-resolver.ts:247`) —
   never reroutes to Kokoro/Coqui/another voice. `applyQwenFallback`'s own
   cloned-voice exemption (`synthesise-chapter.ts:1130-1133`) is retained as a
   documented backstop for any future caller that bypasses the pre-pass, not
   the live guard.
2. **Fail-fast wastes zero GPU.** The pre-pass sits right after
   `buildSentenceGroups` (`synthesise-chapter.ts:1162,1184`) and before the
   title beat (`~1315`) — a Broken voice throws before any sidecar synth call,
   title or body, fires this chapter.
3. **The readiness gate is intersected to THIS chapter's characters — both
   narrator paths included.** `inChapterCharacterIds` starts from
   `groups.map(g => g.characterId)` and the narrator is unioned in when
   **either** a title beat will actually narrate (`Boolean(titleText)`) **or**
   a group carries a `characterId` not present in `cast` at all (the
   "orphaned characterId safety net" that `resolveNarratorChar()` backstops
   further down) — `synthesise-chapter.ts:1184-1192`. A cloned voice not cast
   on any in-chapter character is never resolved, so an unrelated Broken
   cloned voice elsewhere in the book can't fail a chapter it doesn't appear
   in.
4. **Transient vs. permanent derive failure.** `isTransientDeriveFailure`
   (`clone-voice-resolver.ts:168-172`) treats a thrown error as **permanent**
   ONLY when it carries a numeric `status` in `[400, 500)` — status `0`
   (unreachable), any `5xx`, or no numeric status at all is **transient**.
   A transient failure collects Broken/`derive-failed` **without** persisting
   `engines.qwen.status:'failed'` (the voice can retry next run); only a
   permanent 4xx persists `'failed'`. This matters because classification
   rule 3 (`qwen.status === 'failed'` → Broken) fires unconditionally — a
   persisted `'failed'` is terminal until a fresh derive clears it, so a
   transient outage must never reach that state.
5. **Consent-scoped erasure is total.** `purgeCloneArtifacts`
   (`server/src/workspace/purge-clone-artifacts.ts:24-40`) erases, under
   `voices/qwen/`: `qwen-<uuid>.pt`, `.json`, `__1.7b.pt`, both `-preview`
   variants, `__master.wav`, and `-preview__master.wav`, plus the sample cache
   (`purgeVoiceSamples`) — wired into **both** `/revoke`
   (`voice-library.ts:935`, no `deleteEntryDir` — manifest + entry-dir
   `master.wav` retained) and `DELETE /:voiceUuid` (`deleteEntryDir: true`).
6. **Atomic sidecar `.pt` writes.** `_atomic_torch_save`
   (`server/tts-sidecar/main.py:202-`) writes to a temp sibling then
   `os.replace`s onto the live path, used by both `clone_voice` (~3940) and
   `design_voice` (~3828) — matching the pre-existing 1.7B persist pattern, so
   a crash/kill mid-write can no longer corrupt a live `.pt` (#1804). A third
   bare `torch.save` at `mint_variant` (~4011, emotion-variant clone prompt)
   is explicitly **out of scope** — it's off the resolver's re-derive path.
7. **`wrong-engine` is diagnosed distinctly from `engine-unavailable`, and
   the assign-time guard checks the client's INTENDED `modelKey`, not the
   persisted default.** `classifyClonedVoice` checks `wrongEngine` before
   `engineUnavailable` (`clone-voice-resolver.ts:125-126` — the more specific
   diagnosis wins). The assign-time guard (`voice-library.ts:869-891`) prefers
   `body.modelKey` (the caller's pending/session engine choice) over
   `getResolvedTtsModelKey()` (the persisted account default) when present —
   closing a false-409/false-200 pair a first cut of this guard introduced by
   reading only the persisted default while render routes off the request/
   session key. The guard is advisory (see Known limitations); the render-time
   pre-pass is the hard boundary either way.
8. **Designed-voice self-heal is scoped to a MISSING `.pt` only, and never
   introduces a new hard failure.** `resolveDesignedVoicesForChapter`
   (`clone-voice-resolver.ts:297-323`) skips entirely when `ptExists` is true —
   a **stale** `.pt` (old `baseModel`) is deliberately left alone, matching
   today's "renders fine, just from an older embedding" behaviour; only a
   missing `.pt` triggers a re-derive attempt from the retained
   `qwen-<uuid>__master.wav` (Task 11). Any failure along that path (no
   retained clip, sidecar down, derive error) is swallowed — the function
   never throws, so a failed self-heal degrades to exactly today's
   missing-designed-voice behaviour, not a new abort shape.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_qwen_pt_atomic.py`) —
  `clone_voice`'s `.pt` write goes through a temp file + `os.replace`, never a
  bare `torch.save` onto the live path.
- Pytest sidecar (`server/tts-sidecar/tests/test_design_clip_persist.py`) —
  `design_voice` writes `qwen-<uuid>__master.wav`, and it's the exact clip
  that was distilled (asserted against `engine._base.prompt_calls[-1][0]`).
- Vitest server (`server/src/workspace/purge-clone-artifacts.test.ts`) —
  erases all seeded artifact files including `__1.7b.pt`; calls
  `purgeVoiceSamples`; leaves the entry dir alone unless `deleteEntryDir` is
  set; the sidecar evict POST fires after the unlinks (ordering).
- Vitest server (`server/src/routes/voice-library.test.ts`, extended) —
  `/revoke` stamps `revokedAt` **and** purges artifacts (spy) with no
  `deleteEntryDir`, entry still readable after; `DELETE` purges with
  `deleteEntryDir: true` and, against a real temp workspace with `fetch`
  stubbed to fail (sidecar simulated unreachable), the on-disk `__1.7b.pt` is
  genuinely gone (proves the Node-side unlink, not the sidecar evict path);
  the assign-time wrong-engine 409 fires on a book-default mismatch and on a
  character-level `ttsEngine` override, with cause-specific copy for each;
  `modelKey` in the assign body overrides the persisted default for the
  guard's decision.
- Vitest server (`server/src/routes/voice-library.clone.test.ts`, extended) —
  a `transient`-tagged `assessCloneFidelity` throw (ECAPA embed unreachable,
  including a `NoCapacityError`) still 200s and persists
  `cloneFidelityUnavailable: true` with no `cloneCosine`; a genuine
  `SidecarDesignError` from the same call still aborts as before.
- Vitest server (`server/src/tts/synthesise-chapter-error.test.ts`) —
  `UnresolvableClonedVoiceError.fromList` carries the structured broken list
  and reason-aware remedy copy (`wrong-engine` gets its own accurate sentence,
  never folded into "re-enable Qwen"); the legacy single-name constructor
  (3b1 backstop) still works.
- Vitest server (`server/src/tts/clone-voice-resolver.test.ts`, 30+ cases) —
  the full `classifyClonedVoice` precedence table (revoked beats wrong-engine
  beats engine-unavailable beats a persisted `'failed'` beats stale/missing
  `.pt`); `resolveClonedVoicesForChapter`'s headline invariant test (a revoked
  voice rejects and `deriveEngineArtifact` is **never called** — not a
  vacuous `misconfigured` pass); repairable re-derive preserves a sibling
  engine slot untouched; both `status:0` and `status:500`/no-status transient
  failures are Broken without persisting `'failed'`; a `422` permanent
  failure IS persisted `'failed'`; two Broken voices both surface in one
  thrown error; `resolveDesignedVoicesForChapter`'s narrower rules (missing-
  `.pt`-only trigger, never throws, stale `.pt` explicitly untouched).
- Vitest server (`server/src/tts/synthesise-chapter-cloned-resolver.test.ts`)
  — integration-level: a revoked cloned voice rejects the whole
  `synthesiseChapter` call with **zero** recorded synth calls (fail-fast); a
  cloned voice not cast on any in-chapter character never enters the
  resolver (readiness gate); a repairable voice re-derives once then the
  chapter renders; a `wrong-engine` cloned character rejects with zero synth
  calls; the orphaned-characterId path pulls a cloned narrator into the
  readiness gate even with no title beat (the Task 6 review finding).
- Vitest server (`server/src/tts/synthesise-chapter-designed-resolver.test.ts`)
  — the designed-voice self-heal's own integration coverage, including the
  "stale `.pt` present → explicitly no re-derive" pin and the "skipped when
  the character doesn't route to Qwen this run" case.
- Vitest server (`server/src/tts/synthesise-chapter-cloned-resolver-real-deps.test.ts`)
  — the same pre-pass driven through the REAL `readEntry`/`ptExists`/
  `readMasterPcmDefault` production wiring against a temp workspace (not fake
  deps), so the dependency-assembly code itself is exercised, not just the
  pure resolver logic.
- Vitest server (`server/src/routes/failure-taxonomy.test.ts`, extended) —
  `classifyFailure(UnresolvableClonedVoiceError, 'qwen')` returns
  `{ code: 'cloned-voice-broken' }` with a defined remediation.
- Vitest unit (`src/store/generation-stream-runner.test.ts`, extended) — a
  `chapter_failed` tick with `errorCode: 'cloned-voice-broken'` pushes an
  immediate per-chapter-deduped toast, same shape as `voice-not-designed`.
- Vitest unit (`src/components/voices/voice-library-card.broken.test.tsx`) —
  a revoked cloned entry renders the `danger` "Needs attention" chip; a
  healthy cloned entry does not.
- Playwright e2e (`e2e/voice-library.spec.ts`, extended) — the revoked
  cloned fixture (`lib-cloned-revoked`) renders its card and state chip
  alongside the existing golden-path card-count assertions (adjusted
  6→7→8→9 to include it and the newly-cloned voice from Step 6).

> **Known coverage note:** the capacity-admission-ON branch of
> `/qwen/clone-voice` remains an accepted, pre-existing pytest gap (carried
> over from 267 — admission defaults off in the test env), unaffected by
> this wave.

### Manual acceptance walkthrough

Run against the real server + sidecar (`voices.library.enabled` on, a real
Qwen-capable book) — mock mode only exercises the frontend/store seams.

1. Cast a character to a cloned voice, then stop the TTS sidecar. Generate
   that chapter. Expected: the chapter fails immediately (before any audible
   synth), with a `cloned-voice-broken` toast naming the character and
   "engine-unavailable"-flavoured detail.
2. Revoke that same cloned voice's consent (`My voices` → card → Revoke),
   restart the sidecar, and generate the chapter again. Expected: fails loud
   with a "revoked" detail; the card in My voices shows the "Needs attention"
   chip.
3. Manually delete the voice's `voices/qwen/qwen-<uuid>.pt` on disk (simulating
   a corrupted/evicted cache) without touching the manifest, then generate
   the chapter. Expected: a brief re-derive happens transparently (no error),
   the chapter renders normally, and the `.pt` reappears on disk.
4. Assign a cloned voice to a character on a book whose engine is Kokoro.
   Expected: the assign call itself 409s with "Switch the book's engine to
   Qwen" (or the character-specific variant if the character carries its own
   `ttsEngine` override).
5. Delete a cloned voice entirely (My voices → card → Delete). Expected:
   `voices/qwen/qwen-<uuid>.pt`, `__1.7b.pt` (if it existed), `.json`, and any
   `-preview`/`__master.wav` siblings are all gone from disk; the entry no
   longer appears anywhere in the library.

> **Owed — on-box live-GPU acceptance, not yet run.** (a) a real revoked
> voice fails a live render loud, exactly as described in step 2 above; (b) a
> voice re-derives identically after a real base-model bump (step 3, but
> triggered by an actual `currentQwenBaseModel()` change rather than a
> manually deleted `.pt`); (c) after a real revoke, `__1.7b.pt` and both
> `__master.wav` variants (base + preview) are confirmed gone via `ls`, not
> just asserted against a temp-workspace test fixture. Track alongside the
> existing 267 on-box acceptance debt.

## Known limitations / owed on-box acceptance

- **(a)** A real revoked voice fails a live render loud — described above,
  not yet walked on real hardware.
- **(b)** A base-model-bumped voice re-derives — the resolver logic is
  unit- and integration-tested against a synthetic `currentBaseModel`
  mismatch, but not yet exercised against an actual model-version bump on a
  live box.
- **(c)** After a real revoke, `__1.7b.pt` and both `__master.wav` variants
  are confirmed gone by inspecting disk directly, not just via the
  `voice-library.test.ts` temp-workspace assertions.
- **(d)** The assign-time `wrong-engine` guard (`voice-library.ts:869-891`) is
  **advisory only** — it checks the caller's supplied `modelKey`, but a
  client can omit or misrepresent it, so this 409 is a nicety, not a
  correctness boundary. The actual hard guarantee (never substitute) is the
  render-time resolver pre-pass, which fails loud regardless of what the
  assign call was told.
- **(e)** `src/lib/tts-voice-mapping.ts::sampleModelKeyForEngine` and
  `src/lib/tts-models.ts::modelKeyForEngineChoice` are two adjacent
  engine→modelKey mappers with different semantics and no cross-reference —
  a pre-existing overlap, not introduced or worsened here, but a latent drift
  risk the Task 6b fix wave's review flagged in passing. Filed as
  [#1812](https://github.com/dudarenok-maker/Castwright/issues/1812)
  (type:chore).
- **(f)** The resolver pre-pass's `reportProgress` is wired to `undefined` in
  production (`buildDefaultCloneResolverDeps`/`buildDefaultDesignedResolverDeps`,
  `synthesise-chapter.ts`) — there is no free-text progress channel on
  `SynthesiseChapterOpts` today, only typed per-group/per-title ticks, so a
  multi-second re-derive during chapter generation shows no UI signal (the
  chapter just appears briefly idle before synth resumes). Not a correctness
  gap — the chapter still completes — but an observability one. Filed as
  [#1813](https://github.com/dudarenok-maker/Castwright/issues/1813)
  (type:chore).

## Out of scope

- **3c — XTTS clone support.** `purgeCloneArtifacts` has no `voices/xtts/`
  path to erase (there is no such artifact on disk in 3b2 — see the `TODO(3c)`
  comment in `purge-clone-artifacts.ts:43-45`); the resolver is Qwen-only.
  Not shipped here.
- **Catalogue rebuild.** Still deferred, per 267 — unaffected by this wave.
- **A first-class progress channel for the resolver pre-pass.** See Known
  limitations (f) / [#1813](https://github.com/dudarenok-maker/Castwright/issues/1813).
- **Consolidating the two engine→modelKey mappers.** See Known limitations
  (e) / [#1812](https://github.com/dudarenok-maker/Castwright/issues/1812).

## Ship notes

_(fill in when this PR merges: shipped date, commit SHA, any behaviour delta
vs. the plan.)_
