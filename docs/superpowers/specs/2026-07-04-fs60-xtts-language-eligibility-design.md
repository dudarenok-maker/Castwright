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
is unavailable, undesigned, or erroring, generation fails loud (`MissingDesignedVoiceError`) with no
fallback — the mirror-image of English books, which silently fall back to Kokoro. This spec gives non-English
books an equivalent fallback path onto Coqui.

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
`language`). Regenerate `src/lib/api-types.ts` via `npm run openapi:types`. The three frontend call sites
that currently compute `lockedToQwen = bookLanguage !== 'en'` inline — `cast.tsx:153`, `profile-drawer.tsx:279`,
`voice-readiness-gate.tsx:37` — read this field instead and intersect it with `installedEngines` before
handing the result to `voice-engine-picker.tsx` (unchanged component; it already accepts a filtered engine
list as a prop, so no picker redesign is needed). This gives zero-drift, single-source-of-truth eligibility
rather than the ~6-site duplication pattern the current boolean already exhibits.

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
path today (→ Kokoro), blocked when `forbidKokoroFallback` is set. This gains a second, independent branch:
if the character's designed-Qwen route is unavailable/undesigned/erroring **and** `coqui` is in the book's
`eligibleTtsEngines` **and** Kokoro-fallback is forbidden (i.e. non-English) → fall back to Coqui instead of
throwing `MissingDesignedVoiceError`. The Coqui voice resolves exactly like today's English Coqui fallback:
`pickVoiceForEngine('coqui', character, hint)` → profile inference against `COQUI_PROFILE_VOICES` when no
explicit override exists — no new per-language voice data (§2). If `coqui` is *not* in the eligible set
(a still-unsupported language), behavior is byte-identical to today: fail loud.

**`forbidKokoroFallback` stays Kokoro-specific** — not renamed or generalized. The new Coqui branch is a
parallel fallback path gated on eligibility, not a relaxation of the Kokoro guard. **`clearMismatchedDesignedVoices`
stays Qwen-only** — unchanged, per §2's reasoning.

## 4. VRAM handling

**Kokoro's eager-preload default flips to off.** `autoPreloadKokoro` (per-user preference,
`server/src/config/registry.ts`) changes its shipped default from `true` to `false` — Kokoro now loads
on-demand like Coqui/Qwen already do, rather than sitting eagerly resident. This is motivated directly by
this spec: once non-English books are no longer forced onto a single engine, an always-hot English-only
engine is a less universally good use of VRAM headroom. Existing installs that have explicitly set the
preference keep their choice; only the shipped default changes.

**Qwen and Coqui are similarly VRAM-heavy and must never be resident together.** Unlike Kokoro (cheap,
non-exclusive), Qwen and Coqui are comparable weight classes — running both loaded simultaneously risks OOM
on 6–8 GB cards. When a non-English chapter's `requiredEngines` set includes both `qwen` and `coqui` (only
possible now that Coqui-fallback exists for non-English books), segments are **partitioned by engine before
synthesis** rather than interleaved: all Qwen-routed segments render first (Qwen resident, Coqui not
loaded), then the sidecar evicts Qwen and loads Coqui, then the remaining Coqui-routed segments render. This
reuses the scatter/gather **index-order reassembly** primitive already proven in plan 113 (Qwen true
batching) — every segment carries its original sentence index, and final audio assembly walks that index
regardless of synthesis order, so partitioning by engine doesn't disturb output. Kokoro-routed segments
(English books only) are unaffected and continue to interleave freely with Qwen as today.

**Cross-book concurrency still needs a budget-table update.** Serialization solves the *within-chapter*
risk, but this app's concurrent multi-book workflow is a first-class invariant (Book A rendering English
with Kokoro+Qwen while Book B renders Russian with Qwen/Coqui, simultaneously) — so system-wide, all three
engines can still legitimately be resident at once across books. `server/src/tts/engine-vram-cost.ts`
(`ENGINE_VRAM_COST = { kokoro:1, qwen:1, coqui:3, analyzer:4 }`, `DEFAULT_GPU_VRAM_BUDGET = 4`) currently
only enumerates 2-engine combos as "fitting," because Kokoro+Qwen+Coqui concurrently was unreachable before
this spec. The budget-check logic is extended to recognize this now-possible 3-way cross-book combination
and emit the existing "engines unloaded to free VRAM" style warning for it. This stays **advisory** (warn,
not block) — consistent with the existing dual-model advisory today.

## 5. Frontend

`profile-drawer.tsx`'s `lockedToQwen: boolean` and `cast.tsx`'s inline equivalent are replaced by reading the
new `eligibleTtsEngines` field (§2) and intersecting it with `installedEngines` before handing the list to
`voice-engine-picker.tsx` — unchanged component, already accepts a filtered engine list. `voice-readiness-gate.tsx`
reads the same field for its readiness check. XTTS becomes a manually selectable option for non-English
characters on eligible languages, not just a silent fallback — no new components needed.

## 6. Testing plan

- **Server unit:** `resolveEligibleEngines` against every language×engine combination in
  `ENGINE_LANGUAGE_SUPPORT`, including an installed-engines intersection case. `applyQwenFallback`'s new
  Coqui branch: undesigned/erroring Qwen + coqui-eligible language → falls back to a Coqui archetype voice;
  same scenario on a still-unsupported language → unchanged fail-loud `MissingDesignedVoiceError`.
- **Server integration:** a chapter with `requiredEngines = {qwen, coqui}` renders all Qwen segments,
  evicts, loads Coqui, renders the remainder, and reassembles in original sentence-index order (mirrors the
  existing plan-113 scatter/gather test pattern).
- **Sidecar pytest:** `/synthesize` accepts a per-request `language` field for Coqui and it overrides the
  boot-time `COQUI_LANGUAGE` default; an omitted field still falls back to the env var.
- **Frontend unit:** `voice-engine-picker`/`profile-drawer`/`cast.tsx`/`voice-readiness-gate.tsx` read
  `eligibleTtsEngines` from the API response instead of computing `lockedToQwen` inline; Coqui appears as a
  selectable option for ru/es/fr/de books, still absent for other non-English languages.
- **E2E:** a non-English (Russian) book where a character's Qwen route is forced to fail (undesigned)
  resolves audibly to a Coqui fallback voice rather than blocking generation — extends the existing
  generation e2e fixtures per CLAUDE.md's canonical-fixture guidance (`the-coalfall-commission.ru.md`).
- **Live-GPU acceptance (owed, not automatable):** a real Russian/Spanish/French/German chapter actually
  renders via Coqui fallback and sounds correct; Kokoro's new on-demand load doesn't regress English
  cold-start latency noticeably; a mixed Qwen+Coqui chapter serializes correctly with no OOM on an 8 GB card.

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
