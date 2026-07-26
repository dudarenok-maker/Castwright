# Audition engine + tier fidelity, and one engine→modelKey source of truth

**Date:** 2026-07-26
**Issues:** #1812 (mapper consolidation) + #1839 (the two live defects behind it)
**Branch:** `fix/frontend-audition-engine-tier`
**Status:** design approved, plan pending

## Context

#1812 was filed during fs-38 Wave 3b2 as a tidy-up: two adjacent engine→modelKey
mappers with different semantics and nothing keeping them in sync. Auditing the
call sites turned up two live defects behind that drift, so this is a `fix`, not
a `chore`.

## The three problems

### 1. A voice preview can play in the wrong engine

`sampleModelKeyForEngine` (`src/lib/tts-voice-mapping.ts:379`) returns the
**project's** model key for every non-Qwen engine:

```ts
return effectiveEngine === 'qwen' ? QWEN_MODEL_KEY : projectModelKey;
```

Its doc comment justifies this with "the picker offers kokoro|qwen". That is
stale — `VoiceEnginePicker` offers `kokoro | qwen | coqui`
(`src/modals/profile-drawer.tsx:1163`, filtered by fs-60 eligibility). So a book
defaulting to Coqui XTTS with a character overridden to Kokoro builds a sample
request carrying `modelKey: 'coqui-xtts-v2'`, and the preview renders in Coqui.

The server does not correct this. `voice-sample.ts:117` re-picks a matching key
**only** on the raw base-voice branch (`rawEngine` + `rawSpeaker`); the
character-audition branch is `engine = engineForModelKey(modelKey)`
(`voice-sample.ts:121`) — the client's key *is* the routing decision.

Existing tests only cover the Qwen arm and already-matching engine/key pairs
(`src/lib/tts-voice-mapping.test.ts:98-108`), which is why this went unseen.

### 2. Qwen previews are pinned to the wrong tier, and it costs VRAM

The same function collapses every Qwen audition to `qwen3-tts-0.6b`, regardless
of the character's or the run's tier. This was understood as a guard against the
#1388 co-residency OOM. It is the opposite.

`reconcileResidentQwenTiers` (`server/src/tts/ensure-sidecar-loaded.ts:182`)
evicts, at run start, every Qwen base tier the run's cast does not need, "so
only the needed tier occupies the GPU — a pure-1.7B render no longer co-resides
the 0.6B base (and vice-versa)." A hardcoded 0.6B audition against a 1.7B-pinned
character forces the 0.6B base resident **alongside** the 1.7B one — it
manufactures exactly the co-residency the reconcile pass exists to prevent.

Matching the audition to the character's real tier reuses a base that is already
loaded. It is strictly cheaper on VRAM than today's behaviour, and the preview
becomes the thing the user will actually hear.

### 3. Four mappers and three `TtsEngine` declarations

| Location | Shape |
|---|---|
| `src/lib/tts-voice-mapping.ts:379` `sampleModelKeyForEngine` | lossy — Qwen arm only |
| `src/lib/tts-models.ts:207` `modelKeyForEngineChoice` | full table, `qwenTier ?? '0.6b'` |
| `server/src/tts/model-keys.ts:87` `canonicalModelKeyForEngine` | full table, tier-preserving |
| `server/src/routes/voice-sample.ts:53` `defaultModelKeyForEngine` | full table minus Qwen |

`TtsEngine` is declared three times: `src/lib/types.ts:115` (derived from the
OpenAPI `BaseVoice.engine`), `src/lib/tts-voice-mapping.ts:19` (hand-written
literal union), and `src/store/queue-slice.ts:22` (hand-written literal union).

## Design

### Tier resolution reuses the rule the codebase already has

`higherQwenTier` (`server/src/tts/model-keys.ts:118`) is the established policy
for reconciling a per-character tier against the run default: take the higher, so
"a character whose stored tier happens to be the lower one can never drag a run
that was explicitly started at the higher tier back down." Auditions adopt the
same rule rather than inventing a second one.

| Character tier | Run default | Audition today | After |
|---|---|---|---|
| 1.7B pinned | 1.7B | 0.6B — forces a 2nd base resident | 1.7B — reuses the resident base |
| unpinned | 1.7B | 0.6B | 1.7B |
| 1.7B pinned | 0.6B | 0.6B | 1.7B |
| unpinned | 0.6B | 0.6B | 0.6B (unchanged) |

### The VRAM gate stays at admission, where the truth is

A voice sample goes through the same sidecar synth path as a render, so it is
already gated by `withCapacityRetry` (`server/src/gpu/capacity-retry.ts`, #1720):
evict-once, then a bounded poll (`GPU_CAPACITY_POLL_MS` × `GPU_CAPACITY_MAX_ATTEMPTS`,
~60 s by default), then `NoCapacityError`. That layer reads live per-device
`freeMb` via `capacityProbe`; the frontend has no such reading.

**The frontend will not pre-guess whether a tier fits.** When 1.7B genuinely
cannot be admitted, the existing no-capacity error surfaces rather than a silent
downgrade to a different model. This is the honest outcome and it is the same
answer the *render* would give on that machine — if a 1.7B preview cannot fit
there, a 1.7B generation cannot either, which is worth learning before a long run
rather than after it.

### One source of truth per side

- **`TtsEngine` → one declaration.** `src/lib/types.ts:115` wins (it is derived
  from the OpenAPI contract, so it cannot drift from the wire format).
  `tts-voice-mapping.ts:19` and `queue-slice.ts:22` become re-exports/imports of
  it. If the unions turn out to have already drifted, that drift is a finding to
  report, not to paper over.
- **Engine→modelKey → one mapper per side.** Frontend keeps
  `modelKeyForEngineChoice` and it becomes a genuine mirror of the server's
  `canonicalModelKeyForEngine`, including the tier-preserving Qwen arm.
  `sampleModelKeyForEngine` is deleted. Server-side, `defaultModelKeyForEngine`
  (`voice-sample.ts:53`) folds into `canonicalModelKeyForEngine`.
- `QWEN_MODEL_KEY` stays exported — `src/lib/play-emotion-variant.ts:15` and
  `src/components/script-review-voice-nudge.test.ts:3` import it.

### Revised `modelKeyForEngineChoice` Qwen arm

```
qwen: higherQwenTier(
        characterTier ?? (sessionModelKey is a qwen key ? sessionModelKey : '0.6b'),
        sessionModelKey is a qwen key ? sessionModelKey : '0.6b')
```

`higherQwenTier` is mirrored into `tts-models.ts` alongside the existing
`engineForModelKey` mirror, which already carries the "add new prefixes here in
lockstep with `server/src/tts/index.ts`" convention.

### The "Sampled" lifecycle tier must stop anchoring on one tier

`hasCachedQwenSample` (`server/src/routes/voices.ts:250`) decides whether a
character reads as **Sampled** by testing the cached-audition filename against the
literal prefix `` `${sampleScope}-qwen3-tts-0.6b-` `` (`QWEN_SAMPLE_MODEL_KEY`,
`:69`). Once an audition can render at 1.7B the file is named
`<scope>-qwen3-tts-1.7b-<hash>.mp3` and the test fails — the voice would silently
drop out of the Sampled tier despite having a perfectly good audition on disk.

The scan must match **either** Qwen tier. The constant's own comment already
anticipates this ("Revisit if a second Qwen synth key is ever added"); this change
is what triggers it. Paired test: a `1.7b`-named sample file marks the character
Sampled.

### Call-site migration

| Call site | Argument | Effect |
|---|---|---|
| `cast.tsx:427`, `voice-readiness-gate.tsx:74`, `rebaseline-modal.tsx:277`, `script-review-diff.tsx:74` | literal `'qwen'` | engine unchanged; tier now follows the run/character instead of always 0.6B |
| `cast.tsx:500`, `cast.tsx:1018`, `cast.tsx:1223` | `effectiveEngineFor(c)` | wrong-engine fix + tier fidelity |
| `profile-drawer.tsx:655` | `effectiveEngine` (pending choice) | wrong-engine fix + tier fidelity |
| `profile-drawer.tsx:665` | `currentEngine` (persisted) | wrong-engine fix + tier fidelity |

The character tier comes from `charModelKey` in the drawer (already held in
state and already passed to `modelKeyForEngineChoice` at
`voice-library-panel.tsx:264`) and from `c.ttsModelKey` in the cast view.

## Testing

- **Regression, wrong engine (fails before, passes after):** render the profile
  drawer with project key `coqui-xtts-v2` and `engineChoice = 'kokoro'`; assert
  the sample URL prefix carries `kokoro-v1`.
- **Regression, wrong tier:** a 1.7B-pinned character in a 0.6B-default book
  requests `qwen3-tts-1.7b`.
- **Mapper table:** the three existing `modelKeyForEngineChoice` Qwen cases
  (`tts-models.test.ts:142-147`) must stay green unchanged; add
  `('qwen', 'qwen3-tts-1.7b')` → `qwen3-tts-1.7b` and
  `('kokoro', 'coqui-xtts-v2')` → `kokoro-v1`.
- The `sampleModelKeyForEngine` describe block (`tts-voice-mapping.test.ts:98`)
  retires with the function; its cases are already covered in
  `tts-models.test.ts`, plus the two new ones above. No coverage is lost.
- Server: `canonicalModelKeyForEngine` gains the raw-sample cases inherited from
  `defaultModelKeyForEngine`, including `piper → piper-en-us-medium`.

## Out of scope

- The no-capacity **UI** copy. If the frontend does not already surface a sample
  request's error body, wiring that is its own change — this spec only commits to
  not masking the error.
- Cache invalidation of auditions already on disk at the old tier. They stay
  valid and playable; the next audition for a 1.7B character simply writes a
  second file. No migration, no purge.

## Release notes

User-visible, so both `docs/release-notes-next.md` and `RELEASE_NOTES.md` get an
entry: voice previews now play in the engine and quality tier picked for that
character, instead of the book's default.
