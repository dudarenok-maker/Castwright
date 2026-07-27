---
status: active
shipped: null
owner: null
---

# 270 — fs-38 Wave 3c: cloned + designed voices on Coqui XTTS v2

> Status: active — live-GPU acceptance owed (see §"Owed on-box acceptance" below)
> Key files: `server/tts-sidecar/main.py` (`CoquiEngine.clone_voice`,
> `_synth_lock`, `_latents_cache`/`_evict_epoch`/`_bump_evict_epoch`,
> `POST /xtts/clone-voice`, `POST /xtts/evict-voice`, `_voice_paths`,
> `_atomic_torch_save`), `server/src/workspace/paths.ts`
> (`xttsVoiceLatentsPath`, `xttsVoiceSidecarPath`, `xttsVoiceDeriveSrcTmpWavPath`,
> `xttsVoicesDir`), `server/src/workspace/purge-clone-artifacts.ts` (xtts artifact
> set + evict wiring), `server/src/tts/clone-voice-resolver.ts`
> (`pickVoiceForEngine`, `resolveClonedVoicesForChapter`,
> `resolveDesignedVoicesForChapter` — both engine-parametric),
> `server/src/tts/synthesise-chapter.ts` (engine-partitioned derive +
> per-arm evict-before-first-derive hooks, the union pre-pass filter,
> `applyQwenFallback`), `server/src/tts/clone-engines.ts` (shared
> vocabulary — `hasClonedProvenance`/`clonedSlotForEngine`/`CLONE_ENGINE_LIST`),
> `server/src/routes/voice-library.ts` (provenance-gated dual-slot assign,
> Coqui availability signal), `server/src/tts/coqui-install-detect.ts`
> (`coqui_weights_present`), `server/src/tts/sidecar-health.ts`,
> `src/components/voices/voice-library-card.tsx` (per-engine cloned-voice
> state chip), `src/modals/profile-drawer.tsx`, `src/views/cast.tsx`,
> `src/mocks/voice-library.ts` (failure-injectable mock layer),
> `openapi.yaml`
> URL surface: `#/voices` (My voices — a cloned or designed card now shows
> per-engine state, Qwen and Coqui independently); Cast picker (a cloned
> voice can be cast on a Coqui-routed character; audition uses the routed
> engine)
> OpenAPI ops: no new endpoints on the Node contract this wave (the new
> sidecar routes `POST /xtts/clone-voice` / `POST /xtts/evict-voice` are
> internal, Node-to-sidecar only, not part of `openapi.yaml`)

Source spec: [`docs/superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md`](../superpowers/specs/2026-07-25-fs38-wave3-clone-pipeline-design.md) §2.3 (designed clip-persist), §3.2 (latents persist), §5.3 (sidecar), §5.6 (erasure), §6/§8 (3c scope)
Implementation plan: [`docs/superpowers/plans/2026-07-26-fs38-wave3c-xtts.md`](../superpowers/plans/2026-07-26-fs38-wave3c-xtts.md)
Continues: [`267-fs38-wave3-voice-clone.md`](267-fs38-wave3-voice-clone.md) (3a ingest/consent/recorder + 3b1 first Qwen clone), [`268-fs38-wave3b2-resolver.md`](268-fs38-wave3b2-resolver.md) (3b2 resolver + lifecycle, Qwen-only)
Umbrella doc: [`194-voice-cloning.md`](194-voice-cloning.md) · fs-38 · [#624](https://github.com/dudarenok-maker/Castwright/issues/624)

## Benefit / Rationale

- **User:** a cloned or designed voice now works exactly the same way on
  Coqui XTTS v2 as it already did on Qwen — the same never-substitute
  guarantee, the same "fails loud with a reason" behaviour, and the same
  library card. A book routed to Coqui (most non-English books today) can
  finally cast a cloned real person, not just Qwen books. A designed voice
  travels with a book that switches to Coqui too, instead of silently
  reverting to a stock catalogue speaker.
- **Technical:** extends the resolver/erasure machinery 3b2 built for Qwen
  to a second, structurally different engine (no `CloningMixin`, hand-rolled
  latents, a single conditioning-tensor pair instead of Qwen's
  base/1.7B-tier split) without duplicating the never-substitute or
  total-erasure invariants — `pickVoiceForEngine`, `clone-voice-resolver.ts`
  and `purgeCloneArtifacts` are now engine-parametric rather than
  Qwen-hardcoded, and a THIRD notion — "the validate set must be a superset
  of the resolve set" (D-G) — was made explicit and enforced by construction
  rather than by inspection.
- **Architectural:** the wave shipped its own scope widening mid-flight
  (D-B, delivered at the user's explicit direction): designed voices ALSO
  derive lazily on Coqui, under a deliberately **opposite** failure policy
  from cloned voices (fail-soft, never hard-fails a chapter) — because a
  designed voice is not a real person's identity, so falling back to the
  catalogue on a bad derive is the *current, acceptable* behaviour, while a
  cloned voice's identity must never be silently swapped. Keeping the two
  policies in genuinely separate code paths (never a shared branch) is the
  wave's central architectural discipline, verified explicitly at every
  review pass.

## Architectural impact

- **New seams / extension points:**
  - `CoquiEngine.clone_voice` (`server/tts-sidecar/main.py`) — derives XTTS
    conditioning latents (`get_conditioning_latents`) config-faithfully from
    a reference clip and persists `xtts-<uuid>.pt` + `.json` via
    `_atomic_torch_save`, mirroring `QwenEngine.clone_voice`'s
    derive→persist→audition shape. Runs under the same `_synth_lock` Task 8
    added around the whole forward — clone and synthesise are now two
    concurrent entry points into `self._tts` and are fully serialized
    against each other, matching the pre-existing Qwen house pattern
    (`QwenEngine._guarded_base_synth`), not a Wave 3c regression in
    throughput.
  - An in-process `_latents_cache` + `_evict_epoch`/`_bump_evict_epoch` pair
    — a **VRAM-reclaim/dedup cache, not a consent boundary** (see Invariant
    5). `clone_voice` bumps the epoch on every persist, including a
    re-clone of the same `voice_id`, so a repeat clone from new source
    audio can never keep serving stale latents from a racing render.
  - `POST /xtts/clone-voice` and `POST /xtts/evict-voice`
    (`server/tts-sidecar/main.py`) — the sidecar HTTP surface Node drives,
    mirroring the Qwen pair. Both are fail-loud (`provenance: 'cloned'`);
    evict is deliberately **not** gated on model residency and pops the
    cache unconditionally (Invariant 5).
  - `xttsVoiceLatentsPath`/`xttsVoiceSidecarPath`/`xttsVoiceDeriveSrcTmpWavPath`
    (`server/src/workspace/paths.ts`) — the Node-side artifact-path helpers
    Task 13 of Wave 3b2 already anticipated a slot for
    (`purge-clone-artifacts.ts`'s `TODO(3c)`). The artifact set per cloned
    Coqui voice is **three** deterministic paths, not two: the `.pt`, the
    `.json`, and a reference-audio temp WAV
    (`<safe>.derive-src.tmp.wav`) that survives only a hard process kill
    mid-derive — the same severity class as the master recording itself,
    because it *is* the person's source audio, not a derived artifact.
  - `purgeCloneArtifacts` widened to erase all three Coqui paths on both
    revoke and delete, and to route Coqui through the same
    `evictSidecarVoice()` helper the Qwen sweep already used (byte-equivalent
    extraction, no Qwen regression) — closing the `TODO(3c)` gap.
  - `pickVoiceForEngine`, `resolveClonedVoicesForChapter` and
    `resolveDesignedVoicesForChapter` (`server/src/tts/clone-voice-resolver.ts`)
    are now engine-parametric instead of Qwen-hardcoded — the same pure
    classifier and async orchestrators 268 built now run once per
    clone-capable engine present in a chapter, over a **union filter**
    (Task 20) across every clone-capable slot rather than only the routed
    engine.
  - `synthesise-chapter.ts`'s per-chapter pre-pass gained a genuinely
    parallel **designed-voice-on-Coqui** arm (Task 20a, D-B) with its own,
    opposite failure policy from the cloned arm, plus per-arm
    evict-before-first-derive VRAM hooks (Task 22) so a chapter with many
    in-chapter designed speakers doesn't co-resident Qwen-1.7B-tier and
    XTTS on an 8 GB card.
  - `POST /:voiceUuid/assign` (`server/src/routes/voice-library.ts`, Task
    24) now writes **both** clone-capable slots when the entry can actually
    render on both — `provenance === 'cloned'`, or `provenance === 'designed'`
    **and** a retained designed clip exists on disk (D-E, amended twice
    during review — an earlier `entry.master`-based test was unsatisfiable
    dead code, since `master` is written only by the Qwen `/clone` promote
    and no designed entry can ever carry it).
  - A Coqui-availability wire field, `coqui_weights_present`
    (`server/tts-sidecar/main.py` `/health`, mirrored by
    `server/src/tts/coqui-install-detect.ts`/`sidecar-health.ts`) — closes a
    real, reachable defect Task 20 exposed: on a remote/LAN sidecar,
    `coqui_package_installed: true` used to fall back to a **local** disk
    stat of Coqui's weights directory, which is always absent on the box
    the *server* runs on when the sidecar is elsewhere — aborting chapter 1
    of every book with "Re-enable Coqui" on a box where Coqui was installed
    and working.
- **Invariants preserved:** every 267/268 invariant for the Qwen engine is
  untouched — this wave is additive on top of the engine-parametric
  refactor, not a rewrite of the Qwen path (confirmed at every review pass
  that the qwen arm's byte-for-byte behaviour, including its stale-`.pt`
  self-heal skip and its `applyQwenFallback` cloned-voice exemption, is
  unchanged). `TtsEngine` gains **no** `'xtts'` member — see Invariant 10.
- **Migration story:** additive to the data shape. A pre-existing `cast.json`
  entry with only a `qwen` clone-capable slot is unaffected; the new dual-slot
  write only happens on a fresh `/assign` call (Task 24) going forward, so no
  backfill exists or is needed. A pre-existing `voices/xtts/` directory
  cannot exist before this wave (3b2's `purgeCloneArtifacts` only had a
  `TODO(3c)` for it), so there is no legacy-data shape to reconcile on the
  erasure side either.
- **Reversibility:** a revert leaves Coqui exactly as "clone/design on this
  engine does not exist" — every new code path is gated on the presence of
  an `xtts-` slot or a coqui-routed clone/design call, inert otherwise for
  every existing Qwen-only entry.

## Global constraints this wave holds itself to

Carried verbatim from the implementation plan's "Global Constraints"
section, because they are the invariants every task below was reviewed
against:

- **Property 1 — never-silent-substitution**, now engine-neutral. A cloned
  voice either renders as itself on the engine it's cast on, or fails loud.
  Never substituted — not by a stock catalogue voice, not by
  `applyQwenFallback`, not by the sidecar silently accepting an unbacked
  `xtts-` key, and not by having its marker deleted upstream (Phase 0 — see
  Invariant 3).
- **Property 2 — erasure is total**, qualified. On revoke, every artifact the
  voice can be rebuilt or rendered from is destroyed — disk artifacts,
  sidecar in-process caches, and every audition cache regardless of scope
  key. **Already-rendered chapter audio is explicitly out of scope, by
  product decision** — stated here rather than left implicit (see Invariant
  4 for the timing qualification this wave adds on top).
- **`provenance` decides the failure policy, never a name prefix.**
  `cloneStorageKey('coqui', uuid)` returns `xtts-<uuid>` for **both**
  `cloned` and `designed` entries — a bare `xtts-` prefix test is not a
  "this is cloned" test. `cloned` ⇒ fail loud, always, on any engine.
  `designed` ⇒ fail soft, falls back to the catalogue, never hard-fails a
  chapter that rendered before (D-F).

## Design decisions carried forward from the plan

| Decision | What it means | Why |
|---|---|---|
| **D-A** | No engine picker in the clone wizard. Coqui derives lazily the first time a chapter routes a cloned character to it. | A picker asks the user to commit to an engine they cannot evaluate yet; `deriveEngineArtifact` already serves engine-switch + orphan self-heal for Qwen, unchanged pattern here. |
| **D-B** *(scope widened mid-wave, at the user's explicit direction)* | Designed-voice XTTS eligibility is in scope, with a **fail-soft** policy — the exact opposite of the cloned one. | A designed voice on a Coqui book today renders an unrelated stock catalogue speaker; even an imperfect derive from its own calibration clip is closer to the intended identity. The quality question is real and unresolved by anything short of a human listening — see the Known limitations and the acceptance-sheet §E starred item. |
| **D-F** *(required by D-B)* | Failure policy differs by provenance: cloned → fail loud, always; designed → fall back to the catalogue, never hard-fail. A designed entry with **no retained clip** gets no coqui slot at all and keeps byte-for-byte pre-wave behaviour. | Without this, D-B reintroduces exactly the Critical an earlier review round caught: a designed voice is not a real person's identity, so substituting it is acceptable; a cloned voice's identity is not. |
| **D-G** *(required by D-F)* | The validate set must be a superset of the resolve set — anything that can resolve to `xtts-<uuid>` must first have passed through a pre-pass that either derived the artifact or removed the slot. | An earlier delta review found three reachable paths (fs-60's Qwen→Coqui fallback, `qwenUnavailable`, `clearMismatchedDesignedVoices` deleting only the qwen slot) where a designed coqui slot could reach `pickVoiceForEngine` with no derive, turning a chapter that renders today into a 409. This is the single constraint that makes D-B safe. |
| **D-C** | Hand-rolled latents (`get_conditioning_latents` + `_atomic_torch_save`), not XTTS's built-in `CloningMixin`. | The built-in slugifies and writes via a plain, non-atomic `torch.save` to a path we don't control — purge could not reliably erase it, and a crash mid-write could corrupt it. |
| **D-D** | Sidecar substitution of a cloned key is fatal Node-side, gated on the `xtts-` prefix **plus provenance**. | Gating on `qwen-`/`xtts-` alone would make a **designed** substitution fatal too, which Property 1's designed-fail-soft policy forbids. |
| **D-E** *(amended twice during review)* | Assign writes both clone-capable slots only when the entry can actually render on both — `cloned`, or `designed` with a retained clip on disk. | The unconditional form was a shipped Critical: a qwen-only-backed slot written to the coqui field means an engine switch silently drops to a stock catalogue voice for a real person. `entry.master` is the wrong test (write-once by the Qwen `/clone` promote only) — the correct test is the designed clip **file**'s existence. |

## Invariants to preserve

1. **Never-silent-substitution is engine-neutral, and prefix-fatal is
   provenance-gated (D-D).** A substituted `xtts-<uuid>` key on the sidecar
   side is fatal Node-side (`sidecar.ts`), mirroring the pre-existing
   `qwen-` guard from 268 — gated on the prefix **and** on `provenance`, so a
   `designed` entry's coqui slot substituting under fail-soft (Invariant 2)
   never trips it.
2. **The two failure policies never share a code path (D-F).**
   `UnresolvableClonedVoiceError` is constructed only inside
   `resolveClonedVoicesForChapter`; `resolveDesignedVoicesForChapter`'s only
   throw is a deliberate `AbortError` re-throw (mirroring 268's Invariant 8).
   A designed voice with no retained clip on disk gets **no** coqui slot at
   `/assign` time at all (D-E) — the fail-soft path exists only for a voice
   that *could* derive but hit a transient/permanent failure doing so, never
   for one that was never eligible.
3. **The validate set is a superset of the resolve set (D-G), by
   construction.** Task 20's pre-pass filter derives its libraryUuid through
   the same `libraryVoiceForEngine` predicate the renderer itself gates on,
   so a malformed cloned slot fails the same way in both places; Task 20a's
   designed-coqui selection set is "the character has an xtts slot",
   independent of the character's routed engine and of `qwenUnavailable` —
   narrower selection here is exactly what turned three delta-review
   Criticals into live 409s on chapters that render today.
4. **Erasure is total but revoke is not instantaneous, and already-rendered
   audio survives by design.** `/xtts/evict-voice` pops the in-memory cache
   unconditionally and is empirically proven to close every subsequent
   `/synthesize` call (an epoch re-check on the warm-cache hot path, Task
   11a). But an `inference()` forward call already **past**
   `_load_voice_latents` when the evict lands still completes and returns
   audio — the worst-case revoke-to-silence bound is **one XTTS forward's
   wall-clock, not zero**. A mid-render 409 from this surface is never
   retried or rerouted (`sidecar.ts` marks `transient` only for 408/5xx), so
   it fails loud, consistent with Property 1. Already-rendered chapter
   audio is never erased on revoke — a deliberate product decision, not an
   oversight (see Global Constraints, Property 2).
5. **`_latents_cache` is a VRAM-reclaim cache, not a consent boundary.**
   `CoquiEngine.unload()` never touches `_latents_cache` — verified in
   source, and this corrects a false claim that appeared in one of this
   wave's own task briefs (Task 22's), not just in code: `unload()` nulls
   `self._tts`/`self._torch` only, and cache entries are loaded
   `map_location="cpu"`, so they never hold VRAM and clearing them on
   unload would free nothing. Erasure is `/xtts/evict-voice`'s job alone,
   unconditional on load state — so a revoked voice cannot render through
   the cache regardless of whether the engine happens to be loaded.
6. **`provenance` is never inferred from a name prefix.** A `qwen-`/`xtts-`
   prefix identifies the *slot*, not the *provenance* — `cloneStorageKey`
   returns the same shape for `cloned` and `designed` entries alike.
   Anything that branches on failure policy must read `provenance`, never
   the key shape.
7. **The Coqui-availability signal is a wire fact, not a local heuristic.**
   `coqui_weights_present` on `/health` mirrors the pre-existing
   `qwen_weights_present` field exactly; the local-disk-stat fallback is
   retained only for talking to an older sidecar that doesn't send the new
   field, never preferred over it when present.
8. **Per-arm VRAM eviction is policy-scoped and memoised once per chapter.**
   The leading/trailing coqui↔qwen evict hooks each run from *inside* their
   own resolver arm's existing `try`/`catch` — cloned's evict failure is
   fail-loud, designed's is fail-soft — never a single shared eviction call
   whose failure mode is ambiguous between the two policies. Memoisation is
   per-chapter: a chapter with 8–15 in-chapter designed speakers pays the
   evict cost once, not once per character.
9. **The narrator stub resolves its real cast row before any resolver runs
   (Task 23).** An orphaned-`characterId` narrator with a cloned/designed
   voice is looked up by its real uuid, not treated as a synthetic stub with
   no consent state — closing a blind spot the union-filter widening in
   Task 20/20a would otherwise have inherited.
10. **`TtsEngine` has no `'xtts'` member.** The engine is `'coqui'`; `xtts`
    is only the manifest slot key, the artifact-directory name, and the
    `cloneStorageKey('coqui', uuid)` storage-key prefix. Writing `'xtts'`
    into a `TtsEngine`-typed field anywhere is a type error and a
    misunderstanding of the layering — the single most common mistake this
    wave's own reviewers had to correct.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_xtts_clone_voice.py`) — the
  full `CoquiEngine.clone_voice`/`synthesize`/evict surface: config-faithful
  latents derive against the real installed `xtts.py` signature (including
  the `max_ref_len` → `max_ref_length` rename trap), fail-loud on a missing
  `.pt`, the `language in config.languages` guard (including the upstream
  `zh`-always-passes quirk), the epoch-guarded cache (a re-clone of the same
  `voice_id` invalidates a racing render's stale latents — proven by a
  genuine `threading.Event` interleaving test, not a sleep), and the
  three-artifact purge set.
- Pytest sidecar (`server/tts-sidecar/tests/test_xtts_clone_voice.py`,
  Task 11a) — an evict landing while a forward is already past
  `_load_voice_latents` still completes (documents the non-zero
  revoke-to-silence bound); an evict landing before that point is
  epoch-rejected. Both reproduced empirically (a scratch-sandbox rebuild of
  the pre-fix tree, not just "review says so").
- Pytest sidecar (`test_install_state.py`, Task 19) — `coqui_weights_present`
  present/absent/true/false branches, and independence from
  `coqui_package_installed`.
- Vitest server (`server/src/workspace/purge-clone-artifacts.test.ts`) —
  erases all three xtts artifact paths incl. the reference-audio temp WAV,
  wired into both revoke and delete, ordering (files first, sidecar evict
  last) preserved for both engines.
- Vitest server (`server/src/tts/clone-voice-resolver.test.ts`) — the
  classifier and both orchestrators now run parametrically over `'qwen'`
  and `'coqui'`; the designed-coqui arm's narrower fail-soft rules (`ptExists`
  gates BOTH soft-fail branches so a working `.pt` is never downgraded to a
  catalogue voice on a transient derive failure); the removal set is
  provably equal to the selection set (two characters sharing a uuid, only
  the designed slot dropped).
- Vitest server (`server/src/tts/synthesise-chapter-cloned-resolver.test.ts`
  / `synthesise-chapter-designed-resolver.test.ts`) — a coqui-routed cloned
  character fails the whole chapter fast on Broken; a coqui-routed designed
  character with a forced derive failure still renders the chapter on the
  catalogue voice (D-F, the acceptance sheet's starred item); the
  per-chapter evict-before-first-derive memoisation (same-arm AND cross-arm:
  cloned pays once, designed reuses).
- Vitest server (`server/src/routes/voice-library.test.ts`, Task 24) — a
  cloned voice assigns to a coqui-routed character and writes both
  engine-correct slot names; a designed entry with a retained clip also
  writes both; a designed entry with **no** retained clip writes only the
  qwen slot (byte-for-byte pre-wave behaviour); `variants` cleared on both
  slots; the read-modify-write window stays hoisted above the async work so
  it does not reopen the cast.json clobber class Task 14 closed.
- Playwright e2e (`e2e/voice-library.spec.ts` / a Coqui cast/audition spec,
  Task 30) — a cloned voice cast on a Coqui-routed character, mirroring the
  real `/assign` guard order (revoked → not-ready → wrong-engine) against
  the mock layer's now-failure-capable responses (Task 29), so a message
  asserted in mock mode matches what the real backend would say.
- Pytest sidecar golden gate (`server/tts-sidecar/tests/golden/test_cross_engine_sanity.py`,
  Task 31) — `test_coqui_sanity` now actually runs on a Coqui-only box (an
  `import TTS` probe replaces a Kokoro-shaped weights-path check that never
  fired for Coqui); new `test_xtts_clone_sanity`
  (`GOLDEN_XTTS_CLONE=<voiceUuid>`) and `test_xtts_designed_sanity`
  (`GOLDEN_XTTS_DESIGNED=<voiceUuid>`) — loose format/RMS/duration checks
  plus a long-sentence case (the shape that would have caught the
  `enable_text_splitting` crash), gated behind real weights and exercised
  only their SKIP path on this dev box (see Owed acceptance).

### Manual acceptance walkthrough

Scripted in full, with copy-pasteable PowerShell and expected artifact
listings, as **Section E** of
[`docs/testing/fs38-wave3-onbox-acceptance.md`](../testing/fs38-wave3-onbox-acceptance.md)
— the same run sheet 267/268's Sections A–D already cover, extended rather
than duplicated. Run it against a real Coqui-capable sidecar (a Russian or
other non-English book is the natural fixture, since that's the common case
that routes to Coqui today).

## Owed on-box acceptance

None of the items below can be settled from a CI box — they need either a
real GPU running the real sidecar, a real coqui-tts version bump, or a human
ear. Tracked here rather than silently dropped; **not a merge blocker** per
CLAUDE.md's Before-shipping checklist step 3.

- **E-1 — Designed voice vs. stock catalogue, judged by ear (D-B's open
  question).** Cast a designed voice on a Coqui-routed book, force a derive,
  and listen: does the synthetic-clip→latents derive genuinely sound closer
  to the designed persona than the stock `COQUI_PROFILE_VOICES` entry it
  replaces? This is the check the spec flagged as "quality-unvalidated" when
  scoping D-B, and format-level CI assertions (RMS/duration/no-crash) can
  only prove the audio isn't broken, never that it sounds right. Scripted as
  the Section E starred item.
- **E-2 — Golden gate real-voice pass path, unproven on this box.**
  `test_xtts_clone_sanity`/`test_xtts_designed_sanity` (Task 31) only ever
  exercised their SKIP branch here — no cloned `.pt` existed on this
  machine to gate `GOLDEN_XTTS_CLONE`/`GOLDEN_XTTS_DESIGNED` open. The tests
  themselves are real (loose-check pattern, long-sentence case, `_assert_sane`
  already asserts `substituted_from is None`), but their genuine PASS path
  has never actually executed.
- **E-3 — coqui-tts version-bump staleness detection, on a real bump.** The
  whole point of Task 18/19's staleness recompute is that an artifact
  derived under coqui-tts version N is (or isn't) safe to keep serving under
  N+1 — that premise has never been checked against a real version bump on
  a live box, only against a synthetic `currentArtifactVersion` mismatch in
  unit tests.
- **E-4 — `importlib.metadata.version("coqui-tts")` on the AMD/ROCm profile.**
  If it returns `None` there (a real possibility for a ROCm wheel with
  different package metadata), coqui staleness detection stays silently
  inert on that profile only — everywhere else it's live. Needs a ROCm box.
- **E-5 — A corrupted `.json` sidecar manifest, on real disk.** The
  fail-loud path for a coqui voice manifest that fails to `json.load` at
  render time has unit coverage against an injected read failure, but not
  against a genuinely hand-corrupted file on a real filesystem (permissions,
  partial write, encoding — the class of thing that only happens on real
  disk).

## Known limitations

- **(a) Three tasks in the plan did not land in this delivery — 10a, 14a,
  27 — and are tracked as their own follow-up issues, not silently deferred.**
  - **Task 10a — the manual-link consent hole (open, and made more
    exploitable by Task 24, not less).**
    `voice-override-linked.ts` blocks a coqui-slot rewrite only when the
    **existing** slot is already `cloned`; a character with no coqui slot,
    or a `designed` one, is unguarded. `parseOverride` accepts any
    non-empty client-supplied string as `name`; the resolution path falls
    through to returning that raw string as the storage key; and
    `xtts-<other-uuid>` is byte-identical to `cloneStorageKey('coqui',
    otherUuid)` — a real clone key. Before this wave, no route could write
    a coqui `libraryUuid` and no `xtts-` artifacts existed, so a planted key
    resolved to nothing; Task 24 is the route that starts minting real ones,
    which is what activates this latent hole rather than closing it. Filed
    as [#1884](https://github.com/dudarenok-maker/Castwright/issues/1884).
  - **Task 14a — a failed/timed-out sidecar evict on revoke is invisible.**
    The revoke route's sidecar-evict call is wrapped in a bare `catch {}`,
    and the response's `{failed}` array tracks only file-unlink failures —
    so revoke can answer `200` with no `artifactPurgeIncomplete` signal
    while the sidecar's XTTS latents cache (no TTL) may still hold the
    voice until the process restarts. Pre-existing in kind (not introduced
    by this wave), but a genuine Property 2 residual. Filed as
    [#1886](https://github.com/dudarenok-maker/Castwright/issues/1886).
  - **Task 27 — no engine-aware library sample route yet.** `POST
    /:voiceUuid/sample` still hardcodes a Qwen voice name, model key, and
    cache scope — so a Coqui-cloned card's Play button auditions the Qwen
    artifact (and 409s if Qwen is stale while the Coqui artifact is ready).
    Filed as [#1887](https://github.com/dudarenok-maker/Castwright/issues/1887).
- **(b) The synthetic-clip→latents quality claim is delivered but validated
  only at format level in CI.** Format-level checks (RMS/duration/no-crash)
  can prove a designed-voice-on-Coqui derive is not broken; only a human ear
  can judge whether it sounds better than the stock catalogue voice it
  replaces. The listening test is on-box only — see Owed acceptance E-1.
- **(c) Already-rendered chapter audio is not erased on revoke.** A
  deliberate product decision carried unchanged from 268, restated here so
  Property 2's "erasure is total" is never read as unqualified.
- **(d) Cross-process voice-library entry writes are still unserialized at
  the millisecond level** (#1826, inherited from 268 — Task 14 closed the
  seconds-wide GPU-derive window this wave's dual-slot writes also flow
  through, not the millisecond one between a re-read and its write).
- **(e) A Coqui clone reserves VRAM against the plain `coqui` engine
  footprint** — Task 11's settled simplification; there is no
  clone-specific admission tier, mirroring how a Qwen clone reserves against
  the plain `qwen` footprint.
- **(f) The splice/repair path's `clearMismatchedDesignedVoices` call is
  asymmetric.** `chapter-splice.ts` and `generation.ts` both call it (a
  reused designed voice whose baked manifest language differs from the
  book's gets re-checked); `chapter-qa-repair.ts` deliberately does not —
  documented in-line at the call site as a pre-existing asymmetry, not
  introduced by this wave. Filed as [#1889](https://github.com/dudarenok-maker/Castwright/issues/1889).
- **(g) `voiceSubstitutedFrom` is not carried through a re-record merge**
  `[ADV-H6]` — the per-line diagnostic field that records when a rendered
  line used a substituted voice does not survive the re-record/merge path
  that folds a repaired line back into a chapter's segment list. Filed as
  [#1888](https://github.com/dudarenok-maker/Castwright/issues/1888).
- **(h) The manual cast-link consent bypass is still open** `[ADV-M4]` —
  `cast-link-prior.ts:204-207` and `series-reuse-link.ts:390` both bypass
  `library-cast-scan.ts:81-83`'s consent check, so a cloned slot can be
  copied onto a character in a book that was never granted consent for that
  voice. Adjacent to but distinct from Task 6a's force-to-Qwen fix (that
  closed a different interaction on the same file). Filed as
  [#1885](https://github.com/dudarenok-maker/Castwright/issues/1885).
- **(i) `spawn-sidecar.ts`'s `XTTS_VOICES_DIR`/`QWEN_VOICES_DIR` are literal
  `join(...)` calls, not routed through `paths.ts`'s helpers.** Currently
  byte-identical to the helpers' output and a pre-existing convention (not
  introduced here) — but if the spawn env and the path helpers ever
  diverge, the sidecar would write artifacts purge cannot reach, a direct
  Property 2 violation. Filed as [#1890](https://github.com/dudarenok-maker/Castwright/issues/1890).
- **(j) A legacy qwen slot with a `libraryUuid` and no `provenance` field
  renders with zero revocation check.** `characterHasClonedSlot`'s pre-pass
  filter correctly requires `provenance === 'cloned'` (matching the
  pre-3c behaviour), so this old-shape slot skips the resolver pre-pass
  entirely and renders straight from the voice-library artifact regardless
  of revocation state. Not a Wave 3c regression — the pre-existing filter
  had the identical requirement — but a real consent-gate hole on
  old-shape data. Filed as [#1891](https://github.com/dudarenok-maker/Castwright/issues/1891).
- **(k) `npm run test:golden-audio:sidecar` crashes on this dev box**, in a
  sox/PowerShell-stderr interaction on the untouched Qwen probe line —
  reproduces identically on unmodified `main`. The gate is opt-in so nothing
  in CI depends on it, but a gate nobody can execute on their own box decays
  into a gate nobody trusts. Filed as [#1892](https://github.com/dudarenok-maker/Castwright/issues/1892).
- **(l) Two pre-existing fs-60 mixed-engine eviction gaps, both predating
  this wave** (blamed to 245862e0, 2026-07-11, unrelated to Wave 3c):
  `synthesise-chapter.ts`'s trailing `evictCoquiForQwenPhase` call has no
  enclosing `try`/`catch`, so it can throw out of `synthesiseChapter` when a
  chapter genuinely mixes qwen+coqui **render** groups; and a chapter with
  zero Coqui presence immediately following a Coqui chapter never evicts
  XTTS at all (the fs-60 render path only evicts qwen-for-coqui, never the
  reverse). Neither is fixed here — closing the second is exactly the kind
  of over-wide regression an earlier fix round for this wave had to back
  out of, so it needs its own design rather than a quick patch. Filed as
  [#1893](https://github.com/dudarenok-maker/Castwright/issues/1893) (the
  try/catch gap) and [#1894](https://github.com/dudarenok-maker/Castwright/issues/1894)
  (the reverse-direction eviction gap).
- **(m) A fourth inline copy of the `['narrator', 'char-narrator']` pair.**
  Already duplicated across `tts-voice-mapping.ts`, `routes/voices.ts`
  (`isNarratorId`), and `voice-style.ts` before this wave; Task 23's
  narrator-retarget fix is a fourth. None of the four are exported, so
  centralising means a cross-module export — a wider refactor than this
  wave's surgical-changes scope allows. Filed as [#1895](https://github.com/dudarenok-maker/Castwright/issues/1895).
- **(n) `voice-library-panel.tsx`'s fire-and-forget `assignVoice` dispatch
  silently swallows a server rejection.** The profile drawer's equivalent
  path was fixed to surface a refusal (part of 268's work, pinned by a
  regression test added in this wave's Task 29); this second surface, one
  panel over, was found but deliberately left — the same class of gap Task
  29 closed, in a different component. Filed as [#1896](https://github.com/dudarenok-maker/Castwright/issues/1896).

## Out of scope

- **Catalogue rebuild.** Still deferred, per 267/268 — unaffected by this
  wave.
- **A clone-engine picker in the wizard (D-A).** Coqui derives lazily; there
  is no UI to pre-select it.
- **A dedicated VRAM admission tier for a Coqui clone.** See Known
  limitation (e).
- **Three pre-existing gaps that fold into "already tracked elsewhere"**:
  the two engine→modelKey mapper overlap (#1812) and the resolver
  progress-channel gap (#1813), both inherited unchanged from 268; the
  entry-write serialization proper fix (#1826), inherited from 268 and
  extended (not closed) by Task 14 this wave.

## Ship notes

_(fill in when this branch merges: shipped date, commit SHA, any behaviour
delta vs. the plan — including whether Tasks 10a/14a/27 landed in the same
PR or a follow-up.)_
