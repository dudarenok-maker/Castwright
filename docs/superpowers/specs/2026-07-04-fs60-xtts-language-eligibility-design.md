---
title: 'fs-60 — Coqui XTTS per-language engine eligibility (gap-fill beyond Qwen)'
status: draft
date: 2026-07-04
issue: '#1005'
related:
  - 2026-06-22-fs41-fs50-language-aware-ingest-and-breadth-design.md (§11.2 — the deferral this spec picks up)
  - 162-fs2-multilanguage.md (the never-cross-language invariant this spec relaxes, in one specific direction)
  - 194-voice-cloning.md (fs-38, draft — the future consumer of the per-synth Coqui language plumbing this spec builds)
  - 108-qwen-coexistence.md (per-character `ttsEngine` + multi-engine-per-chapter routing this spec extends)
  - 113-qwen-true-batching.md (the scatter/gather index-order reassembly primitive this spec reuses for engine serialization)
  - 238-preload-toggle-dedup.md (`autoPreloadKokoro` default, changed by this spec)
---

# fs-60 — Coqui XTTS per-language engine eligibility (gap-fill beyond Qwen)

> **Scope at a glance.** Let a non-English book (Russian, Spanish, French, German — the languages Qwen
> already fully supports per fs-41/fs-50) use Coqui XTTS voices as a first-class casting choice, not just
> the forced designed-Qwen path. **Kokoro is explicitly out of scope** — it has no non-English G2P backend
> and no non-English voice packs, which is a real new-dependency project, not a gap-fill (see §7). This is
> the XTTS-only slice of GitHub issue fs-60 (#1005); the Kokoro half, XTTS languages beyond this five-language
> set, and a cross-book/cross-language voice-identity check are each split into their own follow-up issues
> (§7) rather than bundled here.

## 0. Why this is narrower than the issue as filed

fs-60 (#1005) as originally written bundles two very differently-sized problems under one issue:

- **Coqui XTTS** is already natively multilingual. The current integration hardcodes a single boot-time
  language (`COQUI_LANGUAGE` env var, `server/tts-sidecar/main.py:705`) instead of threading it per synth
  call — this is a plumbing job.
- **Kokoro** has zero non-English infrastructure today: no G2P backend (`misaki[ja,zh]`, `fugashi`,
  `unidic`, `jieba`, `pypinyin`, `espeak-ng` language data are all absent from every requirements file), and
  the shipped voice packs are English-only by construction (`ENGLISH_VOICE_PREFIXES = ("af_","am_","bf_","bm_")`,
  `main.py:966`). Making Kokoro speak another language means standing up a new dependency chain *and*
  sourcing new voice packs — real, uncertain-scope work.

This spec covers only the XTTS half. Kokoro non-English gets its own follow-up issue (§7).

## 1. Motivation

The primary driver is **resilience**, not voice variety: today, if a non-English book's designed Qwen voice
is unavailable or undesigned, generation fails loud (`MissingDesignedVoiceError`) with no fallback — the
mirror-image of English books, which silently fall back to Kokoro. This spec gives non-English books an
equivalent fallback path onto Coqui. **Scoped to exactly today's trigger conditions** (unavailable/undesigned)
— a mid-render Qwen synth *error* does not go through this seam today (it hits separate retry/recycle logic)
and adding error-triggered fallback is explicitly out of scope here, not silently folded in.

It's also a **prerequisite for fs-38 (voice cloning, draft)**: fs-38's XTTS reference-clip cloning path is
the same boot-time-English-locked Coqui integration this spec fixes. Without per-synth language threading,
a cloned voice could never speak a non-English book — this spec is the plumbing fs-38 will build on top of.

Given both drivers, the design also unlocks **manual** XTTS selection for non-English characters via the
existing voice-engine picker, not just a silent behind-the-scenes substitution.

## 2. Language & engine eligibility model

**Per-engine capability, not per-language branching.** A new data table,
`ENGINE_LANGUAGE_SUPPORT` (`server/src/tts/voice-mapping.ts`, alongside the existing `*_PROFILE_VOICES`
tables):

```ts
export const ENGINE_LANGUAGE_SUPPORT: Record<TtsEngine, string[]> = {
  qwen:   ['en', 'ru', 'es', 'fr', 'de'],  // today's shipped analyze-supported set
  coqui:  ['en', 'ru', 'es', 'fr', 'de'],  // NEW row this spec enables
  kokoro: ['en'],                           // unchanged — no G2P for anything else
  gemini: [...],                            // whatever Gemini's real non-English behavior is today — verify
                                             // at implementation time (not independently confirmed in this
                                             // design), rather than assumed equal to Qwen's set
};
```

`TtsEngine` also includes `'piper'` at the type level (`server/src/tts/model-keys.ts:18`), but it's a dead
placeholder — `'piper-en-us-medium'` is commented `// future local` and no Piper sidecar backend was ever
built. This spec doesn't give it a table row; whoever eventually implements Piper for real adds one then.
Since `Record<TtsEngine, string[]>` requires an exhaustive key set, the implementation either drops `'piper'`
from the `TtsEngine` union as part of this work (it's unused dead code, and CLAUDE.md's surgical-changes
principle says remove code your change orphans) or keys the table as `Partial<Record<TtsEngine, string[]>>`
with unimplemented engines treated as unsupported everywhere — a call for whoever implements this plan.

A new pure function, `resolveEligibleEngines(bookLanguage, installedEngines)` in
`server/src/tts/language.ts` (next to `isNonEnglish`), computes:

```
installedEngines.filter(engine => ENGINE_LANGUAGE_SUPPORT[engine].includes(bookLanguage))
```

This becomes the **single enforcement authority**, replacing the ad-hoc `isNonEnglish`/`forbidKokoroFallback`
checks at the three server-side enforcement sites: `generation.ts:591-593`, `chapter-splice.ts:302`,
`chapter-qa-repair.ts:423`. Each now asks "is this character's engine in the eligible set" instead of
deriving a boolean inline. Adding a language later is a one-line table edit; adding a new engine is one new
table row — no branching logic to touch either way.

**Fully API-driven — no duplicated frontend logic.** `openapi.yaml` gains a computed `eligibleTtsEngines:
TtsEngine[]` field on the book-metadata schema already returned by book-state GET (which already carries
`language`). Regenerate `src/lib/api-types.ts` via `npm run openapi:types`.

Two of the three call sites compute `bookLanguage !== 'en'` inline today — `cast.tsx:153`
(`isNonEnglish`) and `profile-drawer.tsx:279` (`lockedToQwen`) — and switch to reading `eligibleTtsEngines`
instead. The third, `voice-readiness-gate.tsx`, reads it via a Redux selector,
`selectIsBookNonEnglish` (`store/voice-readiness-selectors.ts:60-63`), not an inline compute — that selector
is replaced by an eligibility-aware equivalent (§5 covers the resulting behavior change to the gate itself).

`voice-engine-picker.tsx`'s `lockedToQwen: boolean` prop (component, lines 52-57 and 118-143) is a hard
override — when true it discards `installedEngines` entirely and renders a single disabled Qwen option with
a fixed "This book isn't English…" note. **The component itself needs no code change.** What changes is what
its callers compute and pass in: today `lockedToQwen = bookLanguage !== 'en'`; after this spec,
`lockedToQwen = eligibleTtsEngines.length === 1` (still true, same locked UX, for any language that still has
no fallback — i.e. everything outside en/ru/es/fr/de) and `installedEngines = intersect(allInstalledEngines,
eligibleTtsEngines)` (so for ru/es/fr/de, `lockedToQwen` becomes `false` and the picker's existing unlocked
branch naturally renders exactly `{Default (Qwen), Qwen, Coqui}` — no new rendering logic, just different
inputs). This is a caller-side fix, not a picker redesign, but it's a real behavior change at all three call
sites, not a drop-in field read.

**`overrideTtsVoices` shape is unchanged.** XTTS's catalog voices (`COQUI_PROFILE_VOICES` —
"Damien Black," "Claribel Dervla," etc.) are XTTS v2's built-in multilingual studio speakers: the *same*
speaker embedding renders in any supported language, selected by a `language` parameter passed at synth
time, not baked into the voice itself. The existing 16-voice archetype table needs **zero new entries** for
ru/es/fr/de — it already works, once the language code is threaded per call (§3). There is therefore no new
per-voice `language` field to add to `overrideTtsVoices.coqui`, and no Coqui analog to
`clearMismatchedDesignedVoices` (which exists because a *designed* Qwen voice genuinely only speaks the
language it was designed in — a *catalogue* Coqui voice has no such constraint).

## 3. Synth-time mechanics

**Per-synth Coqui language parameter.** `server/tts-sidecar/main.py:705` currently reads `COQUI_LANGUAGE`
once at process boot into `self._language`, fixed for the sidecar's lifetime. This changes to a per-request
parameter: the `/synthesize` request body gains an optional `language` field (BCP-47, e.g. `"ru"`); the
Coqui synth call uses `request.language or self._language` — falling back to the boot-time env var default
(`"en"`) when the field is absent, fully backward-compatible for every existing English caller. Server-side,
every Coqui synth call in `synthesise-chapter.ts` threads `book.language` through.

**Qwen → Coqui fallback.** `applyQwenFallback` (`synthesise-chapter.ts:873-893`) has exactly one downgrade
path today (→ Kokoro), blocked when `forbidKokoroFallback` is set, firing on exactly the same condition it
checks today — `!voiceName || qwenUnavailable` (undesigned voice, or the whole Qwen engine unavailable). This
gains a second, independent branch on that **same** trigger condition (no new triggers — see §1's scope
note): if that condition holds **and** `coqui` is in the book's `eligibleTtsEngines` **and** Kokoro-fallback
is forbidden (i.e. non-English) → fall back to Coqui instead of throwing `MissingDesignedVoiceError`. The
Coqui voice resolves exactly like today's English Coqui fallback:
`pickVoiceForEngine('coqui', character, hint)` → profile inference against `COQUI_PROFILE_VOICES` when no
explicit override exists — no new per-language voice data (§2). If `coqui` is *not* in the eligible set
(a still-unsupported language), behavior is byte-identical to today: fail loud.

**`forbidKokoroFallback` stays Kokoro-specific** — not renamed or generalized. The new Coqui branch is a
parallel fallback path gated on eligibility, not a relaxation of the Kokoro guard. **`clearMismatchedDesignedVoices`
stays Qwen-only** — unchanged, per §2's reasoning.

## 4. VRAM handling

**Kokoro's eager-preload default flips to off.** The real knob is `tts.preload.kokoro`
(`server/src/config/registry.ts:523-529`, env `PRELOAD_KOKORO`) — a **boot-time sidecar preload flag**, not
a live per-user "on demand" toggle; its own help text says changing it requires a sidecar restart. (The
earlier draft of this spec called this `autoPreloadKokoro`, a name that doesn't exist in the codebase —
corrected here.) This spec flips its shipped default from `true` to `false`, matching how `PRELOAD_COQUI`
and `PRELOAD_QWEN` already default off — Kokoro will no longer be preloaded at sidecar boot, and instead
loads on first request, same as Coqui/Qwen already do. This takes effect on the next sidecar restart, not
instantly. Motivation is unchanged: once non-English books are no longer forced onto a single engine, an
always-hot English-only engine is a less universally good default use of VRAM headroom. Existing installs
that have explicitly set the preference keep their choice; only the shipped default changes.

**Qwen and Coqui are similarly VRAM-heavy and must never be resident together.** Unlike Kokoro (cheap,
non-exclusive), Qwen and Coqui are comparable weight classes — running both loaded simultaneously risks OOM
on 6–8 GB cards. When a non-English chapter's `requiredEngines` set includes both `qwen` and `coqui` (only
possible now that Coqui-fallback exists for non-English books), segments are **partitioned by engine before
synthesis** rather than interleaved: all Qwen-routed segments render first (Qwen resident, Coqui not
loaded), then the sidecar evicts Qwen and loads Coqui, then the remaining Coqui-routed segments render.
Final audio assembly reuses the scatter/gather **index-order reassembly** primitive already proven in plan
113 (Qwen true batching) as-is — every segment carries its original sentence index, so partitioning by
engine doesn't disturb output regardless of synthesis order. **The partition-then-evict-then-render
sequencing itself is new** — today's pool dispatches engine groups and lets the GPU semaphore serialize
admission, with no explicit "evict between phases" step; this spec adds that orchestration, it doesn't reuse
an existing one. Kokoro-routed segments (English books only) are unaffected and continue to interleave
freely with Qwen as today.

**Cross-book concurrency needs no admission-logic change — only an advisory-warning update, if that.**
`server/src/tts/engine-vram-cost.ts` (full table: `ENGINE_VRAM_COST = { kokoro:1, qwen:1, coqui:3, gemini:0,
asr:1, spk:1, analyzer:4 }`, `DEFAULT_GPU_VRAM_BUDGET = 4`) is, per its own file header, a **generic additive
N-way semaphore** — it admits any combination of concurrently-requested engines whose summed cost fits the
budget, not a hand-enumerated list of allowed combos. Kokoro(1)+Qwen(1)+Coqui(3)=5>4 already serializes
correctly today with **zero code change** — the semaphore was already general enough for a 3-way cross-book
case, it just never arose before (non-English books couldn't use Coqui at all). The file's inline comments
describing 2-engine combos as "fitting" are documentation of *today's typical* case, not the enforcement
logic, and don't need editing for correctness. The one open question is whether the existing advisory
warning's message text should be updated to explicitly name the new 3-way combination for operator clarity —
a small, optional copy change, not a logic change.

## 5. Frontend

`profile-drawer.tsx`'s `lockedToQwen` computation and `cast.tsx`'s `isNonEnglish` are both replaced by
deriving from the new `eligibleTtsEngines` field (§2), per the §2 caller-side fix — `lockedToQwen` becomes
`eligibleTtsEngines.length === 1`, `installedEngines` becomes the eligible∩installed set. `voice-engine-picker.tsx`
itself is unchanged. XTTS becomes a manually selectable option for ru/es/fr/de characters, not just a silent
fallback.

**`voice-readiness-gate.tsx` changes behavior, not just its data source.** Today `selectIsBookNonEnglish`
(`store/voice-readiness-selectors.ts:60-63`) drives a hard block for every non-English book with an
undesigned speaking Qwen character — no "Proceed anyway," per `voiceReadinessGateMessage`'s copy ("This
book can't fall back to a generic voice"). That copy is now inaccurate for ru/es/fr/de once Coqui fallback
exists. This selector is replaced with an eligibility-aware equivalent (e.g. `selectHasNoFallbackEngine`,
true only when `eligibleTtsEngines` excludes `coqui` too — i.e. still-unsupported languages) so ru/es/fr/de
books get the same soft-gate English already has ("proceed and they'll render with a Coqui fallback voice"),
while genuinely fallback-less languages keep today's hard block unchanged. This is a real behavior change
to this modal, not a drop-in field swap.

**`cast.tsx`'s eager-Qwen-load effect (lines 148-172) needs no change.** It unconditionally warms Qwen for
every non-English book on cast-view entry; Qwen remains the primary/preferred engine for ru/es/fr/de even
after this spec (Coqui is a fallback/manual alternative, not a replacement), so eagerly loading Qwen there
is still correct. Confirmed by reading the effect, not assumed.

## 6. Testing plan

- **Server unit:** `resolveEligibleEngines` against every language×engine combination in
  `ENGINE_LANGUAGE_SUPPORT`, including an installed-engines intersection case. `applyQwenFallback`'s new
  Coqui branch: undesigned/unavailable Qwen + coqui-eligible language → falls back to a Coqui archetype
  voice; same scenario on a still-unsupported language → unchanged fail-loud `MissingDesignedVoiceError`.
- **Server integration:** a chapter with `requiredEngines = {qwen, coqui}` renders all Qwen segments,
  evicts, loads Coqui, renders the remainder, and reassembles in original sentence-index order.
- **Sidecar pytest:** `/synthesize` accepts a per-request `language` field for Coqui and it overrides the
  boot-time `COQUI_LANGUAGE` default; an omitted field still falls back to the env var.
- **Frontend unit:** `voice-engine-picker`/`profile-drawer`/`cast.tsx` read `eligibleTtsEngines` and derive
  `lockedToQwen`/`installedEngines` correctly (Coqui selectable for ru/es/fr/de, still locked-Qwen-only for
  other non-English languages). `voice-readiness-gate.tsx`'s new eligibility-aware selector: a ru/es/fr/de
  book with an undesigned speaking Qwen character gets the soft-gate ("Proceed anyway") copy and affordance;
  a still-unsupported non-English language keeps today's hard block.
- **E2E:** a non-English (Russian) book where a character's Qwen route is forced to fail (undesigned)
  resolves audibly to a Coqui fallback voice rather than blocking generation — extends the existing
  generation e2e fixtures per CLAUDE.md's canonical-fixture guidance (`the-coalfall-commission.ru.md`).
- **Live-GPU acceptance (owed, not automatable):** a real Russian/Spanish/French/German chapter actually
  renders via Coqui fallback and sounds correct — **this is the load-bearing acceptance check**, since
  whether the same catalog speaker embedding actually sounds acceptable in another language (vs. accented or
  degraded) is a model-behavior claim this design can't verify from source, only from a real listen; also:
  Kokoro's new on-demand load doesn't regress English cold-start latency noticeably; a mixed Qwen+Coqui
  chapter serializes correctly with no OOM on an 8 GB card.

## 7. Deferred — follow-up issues

Three items surfaced during design that are explicitly **not** part of this spec, each filed as its own
backlog item so they aren't lost:

1. **`fs-69` — Kokoro non-English support** ([#1302](https://github.com/dudarenok-maker/Castwright/issues/1302))
   — the G2P backend (`misaki[ja,zh]`, `fugashi`, `unidic`, `jieba`, `pypinyin`, `espeak-ng`) plus sourcing
   non-English voice packs beyond the shipped `af_/am_/bf_/bm_` set. Real new-dependency work; needs its own
   spec.
2. **`fs-70` — XTTS languages beyond Qwen's five** ([#1303](https://github.com/dudarenok-maker/Castwright/issues/1303))
   — XTTS natively supports zh-cn, ja, ko, ar, hi, nl, pl, tr, cs, hu, it, pt, but the analyze/attribution
   pipeline doesn't support most of these book languages yet. A separate initiative, likely paired with
   future analyze-side language work (fs-59 CJK and beyond).
3. **`fs-71` — Cross-book/cross-language voice-identity check** ([#1304](https://github.com/dudarenok-maker/Castwright/issues/1304))
   — verifying a character's Coqui voice still "sounds like itself" across language editions of the same
   series (e.g. the fs-61 per-language Coalfall demo books). Design sketch: extend srv-36's render-integrity
   pipeline (`server/src/audio/render-integrity/`) with a comparison mode that, when the same character is
   cast on the same Coqui voice across sibling series books in different languages, pulls that character's
   persisted centroid from the other-language book (via the existing cross-book linking machinery +
   `centroids-io.ts`) and computes cross-book cosine similarity against it — reusing
   `buildCentroid`/`cosineToCentroid`/`CUTOFFS` as-is, with one new orchestration step. Below-threshold
   similarity would surface as a non-blocking QA flag via the existing verdict-file/badge mechanism, never
   blocking generation. This is the same plumbing fs-38 (voice cloning) will need for
   reference-clip-vs-render comparison, so it's not wasted even though catalog voices are its only caller
   today — but it has no real trigger until a multi-language series or fs-38 actually exists, so it's out of
   this spec.
