# Audition engine + tier fidelity, and one engine→modelKey source of truth

**Date:** 2026-07-26
**Issues:** #1812 (mapper consolidation), #1839 (the two live defects behind it),
#1841 (ungated 1.7B tier picker), #1842 (library-card preview tier)
**Branch:** `fix/frontend-audition-engine-tier`
**Status:** design approved, revised after adversarial review

**This is Wave 1 of a two-wave delivery.** Wave 2 is the cloned/designed voice
resolver progress signal (#1813), specified in
`2026-07-26-resolver-prepass-progress-phase-design.md` and shipped on its own
branch once this merges. The two waves are independent in code and share only
this delivery arc — both are fs-38 Wave 3b2 follow-ups.

## Context

#1812 was filed during fs-38 Wave 3b2 as a tidy-up: two adjacent engine→modelKey
mappers with different semantics and nothing keeping them in sync. Auditing the
call sites turned up two live defects behind that drift, so this is a `fix`, not
a `chore`.

This document was revised after an independent review. Three of its original
claims were wrong; they are corrected in place below and called out in
**Corrections after review** at the end, so the reasoning that changed is not
silently rewritten.

## The three problems

### 1. A voice preview can play in the wrong engine

`sampleModelKeyForEngine` (`src/lib/tts-voice-mapping.ts:379`) returns the
**project's** model key for every non-Qwen engine:

```ts
return effectiveEngine === 'qwen' ? QWEN_MODEL_KEY : projectModelKey;
```

Its doc comment justifies this with "the picker offers kokoro|qwen". That is
stale — `VoiceEnginePicker` offers `kokoro | qwen | coqui`
(`src/modals/profile-drawer.tsx:1163`), and `eligibleTtsEngines` genuinely can
contain `coqui` (`server/src/workspace/scan.ts:792`; `scan.test.ts:347` asserts
`['coqui','qwen']`). So a book defaulting to Coqui XTTS with a character
overridden to Kokoro builds a sample request carrying `modelKey:
'coqui-xtts-v2'`, and the preview renders in Coqui.

The server does not correct it. `voice-sample.ts:117` re-picks a matching key
**only** on the raw base-voice branch (`rawEngine` + `rawSpeaker`); the
character-audition branch is `engine = engineForModelKey(modelKey)`
(`voice-sample.ts:121`), and `:123 pickVoiceForEngine(engine, …)` then picks a
Coqui speaker. The client's key *is* the routing decision.

Existing tests only cover the Qwen arm and already-matching engine/key pairs
(`src/lib/tts-voice-mapping.test.ts:98-108`), which is why this went unseen.

### 2. Qwen previews are pinned to 0.6B even when the book renders at 1.7B

The same function collapses every Qwen audition to `qwen3-tts-0.6b` regardless
of the run's tier, so a book generating at 1.7B previews its cast at 0.6B — the
preview is not the voice you will hear.

There is also a VRAM consequence, though a narrower one than this document
originally claimed. `reconcileResidentQwenTiers`
(`server/src/tts/ensure-sidecar-loaded.ts:182-218`) runs **once at run start**
and evicts every Qwen base tier the run's cast does not need, and the synth path
lazily loads whichever tier the request names (`main.py:4414`,
`sidecarModelId`). So a hardcoded-0.6B audition fired *during* a 1.7B render
does force the 0.6B base resident alongside the 1.7B one — manufacturing the
co-residency the reconcile pass just eliminated.

### 3. Four mappers and three `TtsEngine` declarations

| Location | Shape |
|---|---|
| `src/lib/tts-voice-mapping.ts:379` `sampleModelKeyForEngine` | lossy — Qwen arm only |
| `src/lib/tts-models.ts:207` `modelKeyForEngineChoice` | full table, `qwenTier ?? '0.6b'` |
| `server/src/tts/model-keys.ts:87` `canonicalModelKeyForEngine` | full table, tier-preserving |
| `server/src/routes/voice-sample.ts:53` `defaultModelKeyForEngine` | full table minus Qwen |

`TtsEngine` is declared three times: `src/lib/types.ts:115` (derived from the
OpenAPI `BaseVoice.engine`, which `api-types.ts:3692` confirms is required and
enumerates all five engines), `src/lib/tts-voice-mapping.ts:19`, and
`src/store/queue-slice.ts:22`.

## The constraint that shapes the design: the audition key is a cache key

`server/src/tts/voice-sample-cache.ts:1-9` states an invariant that no earlier
draft of this design accounted for:

> The voice-sample player (`POST /api/voices/:id/sample`) and the Qwen
> design-voice route both render a ~12 s preview MP3 and cache it under the
> **same deterministic filename** … designing a bespoke Qwen voice from a
> character's own line produces exactly the file the "Play 12s" button later
> reads — **one synthesis, not two**.

`server/src/routes/qwen-voice.ts:13,23,480` repeats it. Today every side
resolves to `qwen3-tts-0.6b`, so they agree by construction.

Two consequences follow, and they drive everything below:

1. **Every site that computes an audition key must compute the *same* key** for
   the same character — the play sites *and* the design sites. Making one
   tier-aware and not the other splits the filename, causing a silent second
   synthesis and breaking the "is this row playing" prefix check.
2. **The tier in that key must be a stable function of persisted state.** It
   cannot depend on anything transient. In particular it cannot be gated on
   `ttsLifecycle.qwen1_7b.state`, which `use-tts-lifecycle.ts:179` derives from
   `sidecarHealth.qwenBase17Loaded` — *currently resident*, not *installed*.
   Gating on residency would make the same character key 1.7B while the model
   happens to be loaded and 0.6B afterwards.

Four call sites this design originally listed as auditions are in fact **design**
requests — `cast.tsx:427` (bulk), `voice-readiness-gate.tsx:74`,
`rebaseline-modal.tsx:277`, `script-review-diff.tsx:74`. Server-side their
`modelKey` is used *only* to name the cached audition file
(`design-voice-core.ts:206`); the design request body carries no tier at all
(`design-voice-core.ts:272-278`). They are VRAM- and output-neutral — which is
exactly why they matter here: they are on the shared cache key.

## Design

### The audition tier comes from the session key, never per-character

```
auditionModelKey = modelKeyForEngineChoice(effectiveEngine, sessionModelKey)
```

with **no character-tier argument at any audition or design call site**.

This is what makes the tier follow the book. The Start-generation modal is the
affordance that chooses a tier, and `layout.tsx:1743-1760` documents that it
deliberately converges **three sinks** — `ui.ttsModelKey` (the session key), the
cast-wide pins via `api.setCastTier`, and the queue dispatcher's fallback — so
that "this book is on 1.7B" is already expressed in the session key. Reading the
session key therefore captures the real workflow: pick 1.7B, and every preview
follows at 1.7B.

Deriving the key per-character instead would:

- **split the shared design/play cache key**, since bulk design
  (`cast.tsx:427`) sends one `modelKey` for N characters and physically cannot
  match a heterogeneous per-character key. This is the structural reason, and it
  alone settles it.
- reintroduce the worst VRAM case — a single 1.7B-pinned character inside a 0.6B
  book would load the 1.7B base *alongside* the resident 0.6B, for a 12-second
  clip.

A per-character 1.7B pin still governs **generation** exactly as it does today
(`synthesise-chapter.ts` `routeFor`, `higherQwenTier`). It simply stops
fragmenting the preview cache. The one case that loses preview fidelity is a
character individually pinned above its book's tier — the same case that is
worst on VRAM, so the trade is aligned rather than a compromise.

### The VRAM gate stays at admission — and admission learns to free an idle base

A voice sample flows through the same sidecar synth path as a render —
`voice-sample.ts:138 selectTtsProvider` → `SidecarTtsProvider.postWithCapacityRetry`
(`sidecar.ts:297-320`) → `withCapacityRetry` (`capacity-retry.ts:85`) — and the
sidecar's `admit()` is tier-aware (`main.py:2260`). The frontend has no VRAM
reading and will not pre-guess one.

Admission today **serialises** (a bounded ~60 s poll while other GPU work
drains) and **evicts** — but only the analyzer Ollama, once, and only when
`analyzerEvictWouldHelp` (`capacity-retry.ts:116-120`). It never frees a
resident *TTS* model. That leaves a case where the right answer is obviously
"make room", and the current answer is "refuse":

> A book on 1.7B. The 0.6B base is resident from earlier work. The analyzer
> isn't running, so the one eviction lever is a no-op. The preview polls for
> ~60 s and fails — while a base it does not need sits idle holding the VRAM.

`reconcileResidentQwenTiers` (`ensure-sidecar-loaded.ts:182`) already knows how
to free exactly that, and already speaks `/unload {engine:'qwen', model:'1.7b'}`.
It just only fires at generation start.

**So admission gains a second eviction lever, symmetric with the analyzer one:**
before giving up, free a resident Qwen base tier this request does not need, then
retry. Fires at most once per call, after the analyzer lever and before the poll.

Two constraints keep it safe:

- **Only when no render is in flight anywhere** — `activeGenerationBooks()`
  (`generation.ts:602`) must be empty. A resident base during a render may be in
  active use, and a mixed-tier book can legitimately have both tiers live at
  once (a character pinned above its book's tier renders at 1.7B while the
  session sits at 0.6B). This guard also means the lever is **inert during
  generation by construction** — which is correct, because the render path
  already gets `reconcileResidentQwenTiers` at run start. No new behaviour is
  introduced on the render hot path.
- **Qwen bases only.** Coqui and Kokoro are user-controlled: unloading them
  behind the user's back would be surprising. The scenario this addresses is two
  Qwen tiers, which is what the reconcile pass already models.

### If we won't evict it, we must say so — loudly

Declining to auto-evict Coqui/Kokoro *and* staying quiet about it is the worst
combination: the user watches a preview fail against a message that reads only
"free VRAM or attach a second GPU" (`tts-errors.ts:20`), naming nothing.

So when capacity is genuinely exhausted, `NoCapacityError` names the resident
user-controlled models and gives the specific remedy for each. The two remedies
differ, because the two models are controlled differently — and getting this
wrong would send the user hunting for a button that does not exist:

| Resident model | Control | Remedy |
|---|---|---|
| Coqui XTTS | button-driven `ModelControlPill` | "Stop it in the Models panel." |
| Kokoro | **no Load/Stop pill** — eagerly resident, gated by `tts.preload.kokoro` | "Turn off *Preload Kokoro* in settings." |

A resident Qwen base is deliberately **not** listed: the lever above already
frees an idle one, so naming it would be noise on top of an action already
taken. The generic "free VRAM or attach a second GPU" line survives as the
fallback for when nothing user-controlled is resident — in that case the GPU is
genuinely busy and there is no button to press.

This supersedes the earlier "no-capacity UI copy is out of scope" note: the
sample route surfaces the error as a typed `503 { code: 'no_capacity', message,
blockers }`, mirroring the `remediation` shape `chapter_failed` already uses
(`generation.ts:1029`).

The net effect is that a preview which *can* be made to fit does fit — by
freeing something genuinely idle — and `NoCapacityError` is reserved for the
case where nothing can be freed and the GPU is genuinely busy.

### One source of truth per side

- **`TtsEngine` → one declaration.** `src/lib/types.ts:115` wins.
  `tts-voice-mapping.ts:19` and `queue-slice.ts:22` become imports/re-exports.
- **Engine→modelKey → one mapper per side.** Frontend `modelKeyForEngineChoice`
  becomes a complete mirror of the server's `canonicalModelKeyForEngine`;
  `sampleModelKeyForEngine` is deleted. Server-side `defaultModelKeyForEngine`
  folds into `canonicalModelKeyForEngine` — a behaviour-preserving de-duplication
  (under its `engineForModelKey(modelKey) !== engine` guard the two tables agree
  on every reachable input), not a fix.
- `QWEN_MODEL_KEY` stays exported — `src/lib/play-emotion-variant.ts:15` and
  `src/components/script-review-voice-nudge.test.ts:3` import it.

The `modelKeyForEngineChoice` Qwen arm still accepts its existing optional tier
argument, which the **assign guard** callers (`voice-library-panel.tsx:264`,
`profile-drawer.tsx:382`) pass. That guard is engine-only and tier-agnostic
(`server/src/routes/voice-library.ts:886`), so their behaviour is unchanged; the
argument simply is not used by audition callers.

### The "Sampled" lifecycle tier must stop anchoring on one tier

`hasCachedQwenSample` (`server/src/routes/voices.ts:250`) tests the cached
filename against the literal prefix `` `${sampleScope}-qwen3-tts-0.6b-` ``. Once
an audition can render at 1.7B the file is named `<scope>-qwen3-tts-1.7b-<hash>.mp3`
and the character silently drops out of the **Sampled** tier. The scan must match
either tier, and `openapi.yaml`'s `sampled` field description (mirrored into
`api-types.ts:3733`) hardcodes the same 0.6B example and must be updated with it.

## Testing

- **Regression, wrong engine (fails before, passes after):** a character
  overridden to Kokoro in a Coqui-default book auditions with `kokoro-v1`.
- **Regression, wrong tier:** a Qwen character in a 1.7B-session book auditions
  with `qwen3-tts-1.7b`.
- **Cache-key uniformity:** the play sites and the design sites resolve to the
  same `modelKey` for the same character and session — the invariant that keeps
  design's output and Play's lookup on one file.
- **Mapper table:** `('kokoro','coqui-xtts-v2') → 'kokoro-v1'` and
  `('qwen','qwen3-tts-1.7b') → 'qwen3-tts-1.7b'` are the two the old function got
  wrong. These are table coverage, not the regression proof — the regression
  proof is at the call sites, since the broken function was never
  `modelKeyForEngineChoice`.
- The `sampleModelKeyForEngine` describe block retires with the function; its
  cases move to `tts-models.test.ts` first, so no coverage is lost.

### Gate the 1.7B tier picker on installed weights (#1841)

`start-generation.tsx:11-18` offers the 1.7B tier unconditionally, while the
1.7B base is a **separately downloaded** model (`main.py:6070`
`_qwen_base17_weights_present`, `:3146` `Base17UnavailableError`). Picking it on
a box without those weights is already broken for *generation*; once the preview
tier tracks the session key, previews inherit that exposure too — so the gate
belongs here, on the control that sets the tier.

The signal already exists end to end and needs no new plumbing: the sidecar
reports `qwen_base17_weights_present` in `/health` (`main.py:6408`), and the
server already forwards it as `qwenBase17WeightsPresent`
(`sidecar-health.ts:204,279`). Only the **frontend** stops short — `SidecarHealth`
in `src/lib/api.ts:6073-6084` carries `qwenBase17Loaded` and `qwenWeightsPresent`
but not the 1.7B weights field. Thread it through `useTtsLifecycle` → `layout.tsx`
→ the modal, and disable the 1.7B option with a reason when the weights are
absent.

Note this is **installed**, not **loaded** — the distinction that matters
throughout this design. `VoiceEnginePicker`'s existing `qwen17bAvailable` gate is
residency-based and therefore stricter; it is left alone, since a stricter gate is
not a bug.

### Make the library-card preview follow the same tier (#1842)

The My-voices card hardcodes 0.6B on both sides of its own design/play pair:
`voice-library.ts:434` (`POST /:voiceUuid/sample`) and `design-voice-core.ts:281`
(the preview design). Both use cache scope `qwen-<uuid>`, so **they share a cache
key with each other** exactly as the character sites do — the same invariant, one
level over. They must move together or not at all.

`POST /api/voice-library/:voiceUuid/sample` currently accepts only `{ text }` and
has no session context, so the tier has to be passed in: accept an optional
`modelKey`, validate it resolves to the Qwen engine, and default to
`qwen3-tts-0.6b` for any caller that omits it (so the endpoint stays
backward-compatible). The frontend sends the same
`modelKeyForEngineChoice('qwen', ttsModelKey)` expression every other call site
uses. `ui.ttsModelKey` is a global session setting, so this works on the
book-less `#/voices` tab too.

To be precise about what this fixes: the card and the cast row keep **separate
files** either way, because their cache scopes differ (`qwen-<uuid>` vs
`voiceId ?? char-…`). The defect is that the same voice could *sound different*
in the two places. After this they render at the same tier.

## Out of scope

- **Auditions already on disk at the old tier.** They stay valid and playable; no
  migration, no purge.
- **Wave 2 (#1813)** — the resolver pre-pass progress signal, on its own branch.

## Corrections after review

1. **"Strictly cheaper on VRAM" was wrong.** Tier fidelity is cheaper only
   *during* a 1.7B run. Under a per-character key it would have been more
   expensive in two reachable cases (a 1.7B-pinned character in a 0.6B run; any
   preview on an idle machine). Session-tier resolution avoids the first case;
   the second is inherent to previewing at the tier the book renders at.
2. **The audition `modelKey` is also a shared cache key.** Not accounted for in
   the first draft; it is now the constraint the design is built around.
3. **Four call sites were described as auditions.** They are design requests
   whose `modelKey` only names the cached file.

## Release notes

User-visible, so both `docs/release-notes-next.md` and `RELEASE_NOTES.md` get an
entry: voice previews now play in the engine picked for that character and at the
quality tier the book is set to generate at.
