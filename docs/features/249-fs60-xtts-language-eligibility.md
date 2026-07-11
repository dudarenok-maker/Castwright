---
status: active
shipped: null
owner: null
---

# fs-60 — Coqui XTTS per-language engine eligibility (gap-fill beyond Qwen)

> Status: active — code + automated tests land in this PR; Live-GPU acceptance owed (mock-mode e2e only; see "Out of scope" and the BACKLOG `fs-60` row).
> Key files: `server/src/tts/voice-mapping.ts` (`ENGINE_LANGUAGE_SUPPORT`), `server/src/tts/language.ts` (`resolveEligibleEngines`), `server/src/workspace/scan.ts` (`eligibleTtsEngines` computed field), `server/src/tts/synthesise-chapter.ts` (`applyQwenFallback`, `evictQwenForCoquiPhase`, `synthGroupsSerialized`), `server/src/routes/generation.ts` + `chapter-splice.ts` + `chapter-qa-repair.ts` (the three enforcement sites), `server/tts-sidecar/main.py` (per-request `language` param on `/synthesize`), `server/src/config/registry.ts` (`tts.preload.kokoro` default), `src/views/cast.tsx` (non-English banner), `src/modals/voice-readiness-gate.tsx` + `src/store/voice-readiness-selectors.ts` (`selectHasNoFallbackEngine`, `selectFallbackEngineName`), `src/modals/profile-drawer.tsx` (`lockedToQwen`), `src/lib/voice-status.ts` (Fallback (Coqui) pill), `openapi.yaml` (`LibraryBook.eligibleTtsEngines`).
> URL surface: `#/books/<id>/cast` (banner + engine picker), `#/books/<id>/manuscript` (voice-readiness gate modal).
> OpenAPI ops: `GET /api/books` (library list — carries the new `eligibleTtsEngines` field per book), `POST /api/books/{id}/generate` (per-chapter render — the fallback/serialization behavior).

## Benefit / Rationale

- **User:** A Russian, Spanish, French, or German book is no longer hard-locked to Qwen with no recovery path. An undesigned or unavailable Qwen character now falls back to a generic **Coqui** voice (same resilience English books already get from Kokoro), and the cast/manuscript UI names that fallback explicitly instead of hard-blocking or misnaming it.
- **Technical:** A single data-driven table (`ENGINE_LANGUAGE_SUPPORT`) replaces scattered `isNonEnglish`/`forbidKokoroFallback` derivations at three separate server enforcement sites, with one pure filter (`resolveEligibleEngines`) computing the per-book `eligibleTtsEngines` field the frontend reads. Also unblocks fs-38 (voice cloning) — a cloned XTTS voice can now speak a non-English book.
- **Architectural:** Preserves the fs-2/plan-162 "non-English ⇒ Qwen, fail loud" invariant unconditionally (`qwen: '*'` in the support table) — this plan only ADDS a second eligible engine for five specific languages, it does not weaken the invariant that a still-unsupported language (e.g. zh/ja) keeps today's hard-fail behavior. Adds a new Qwen/Coqui **mutual-exclusion-within-a-chapter** invariant (never co-resident) enforced by explicit phase partitioning, since both engines are VRAM-heavy enough to risk exceeding an 8 GB card together (see "Invariants to preserve" #4 and the accepted limitations below).

## Architectural impact

- **New seams:** `ENGINE_LANGUAGE_SUPPORT` (`server/src/tts/voice-mapping.ts`) is the single per-engine language-capability table; `resolveEligibleEngines(bookLanguage, installedEngines)` (`server/src/tts/language.ts`) is the pure filter every enforcement site now shares. `SynthesiseChapterOpts.coquiEligible` is a new optional flag threaded alongside the existing `forbidKokoroFallback`. `eligibleTtsEngines` is a new additive `LibraryBook` field (OpenAPI → `api-types.ts`).
- **Invariants preserved:** the fs-2 never-cross-language invariant (Qwen is `'*'` — every non-English language still forces Qwen as primary); the plan-107/113 sample-rate-anchor + index-order-reassembly primitives (untouched — the new Qwen/Coqui serialization wrapper is a drop-in replacement for `synthGroupsBatched` at every dispatch site, including re-record rounds).
- **Migration story:** none — `eligibleTtsEngines` is server-computed (not persisted), and the frontend default (`['qwen', 'kokoro', 'coqui', 'gemini', 'piper']` — i.e. "assume everything eligible") matches the pre-existing "missing book data ⇒ not blocked" posture at every read site, so an old cached library payload degrades to the fully-open default rather than a false hard-block.
- **Reversibility:** flipping `ENGINE_LANGUAGE_SUPPORT.coqui` back to `[]` (or removing the key) reverts every downstream computation — the enforcement sites, the API field, and the frontend gate/banner/picker all derive from it, nothing else needs to change. `PRELOAD_KOKORO`'s default flip is a one-line revert in `registry.ts`.

## Invariants to preserve

1. `ENGINE_LANGUAGE_SUPPORT.qwen === '*'` (`server/src/tts/voice-mapping.ts:40`) — Qwen is eligible for every language the app can detect, not just the five analyze-supported ones. Never narrow this to a finite list; that would silently weaken the fs-2 never-cross-language invariant for a detected-but-unsupported language (zh/ja today).
2. `ENGINE_LANGUAGE_SUPPORT.coqui === ['en', 'ru', 'es', 'fr', 'de']` (`server/src/tts/voice-mapping.ts:41`) — deliberately scoped to the five analyze-pipeline-supported languages (fs-41/fs-50); opening further XTTS-capable languages is `fs-70` (#1303), not this plan.
3. `resolveEligibleEngines` (`server/src/tts/language.ts:59-68`) is a pure data-driven filter over `ENGINE_LANGUAGE_SUPPORT` — no per-language branching added here. Any new engine/language combination is a table edit, not a code change.
4. **Qwen and Coqui must never be resident in the sidecar at the same time within a chapter's own render.** Enforced by `synthGroupsSerialized` (`server/src/tts/synthesise-chapter.ts:1602-1624`), which partitions a mixed group list into a pre-evict phase (every non-Coqui engine, including Qwen) and a post-evict Coqui phase, calling `evictQwenForCoquiPhase` (`synthesise-chapter.ts:817-832`) between them. Applied at EVERY dispatch site (initial body + every re-record round), not just the first call — see accepted limitation #3 below for the one exemption (the chapter anchor group).
5. `applyQwenFallback` (`server/src/tts/synthesise-chapter.ts:922` onward) only substitutes Coqui for a Qwen-routed character when `forbidKokoroFallback && coquiEligible` — a still-unsupported non-English language (`coquiEligible: false`) keeps the original fail-loud `MissingDesignedVoiceError` behavior unchanged.
6. `selectHasNoFallbackEngine` (`src/store/voice-readiness-selectors.ts:66-73`) is true only when `eligibleTtsEngines` excludes BOTH `coqui` and `kokoro` — a Coqui-eligible non-English book always gets the soft-gate ("Proceed anyway"), never the hard block.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/language.test.ts` or colocated) — `resolveEligibleEngines` against every language×engine combination in `ENGINE_LANGUAGE_SUPPORT`.
- Vitest server (`server/src/tts/synthesise-chapter.test.ts`) — the Qwen→Coqui fallback branch in `applyQwenFallback` (coqui-eligible substitutes Coqui; still-unsupported keeps the throw); `synthGroupsSerialized`'s partition-then-evict-then-render sequencing, including the "coqui vs not-coqui" split (a third engine present alongside qwen+coqui is not dropped) and the zero-overhead passthrough when a group list doesn't mix qwen+coqui.
- Vitest server (`server/src/routes/generation.test.ts`, `chapter-splice.test.ts`, `chapter-qa-repair.test.ts`) — each of the three enforcement sites computes `eligibleEngines` via `resolveEligibleEngines` and threads `coquiEligible` correctly.
- Vitest server (`server/src/workspace/scan.test.ts`) — `eligibleTtsEngines` on the library-list computed field, against `installedEngines` ∩ language-eligible set.
- Pytest sidecar (`server/tts-sidecar/tests/`) — the per-request `language` param threaded through `/synthesize` for Coqui.
- Vitest frontend (`src/views/cast.test.tsx`) — the non-English banner's copy branches on `qwenOnly` (Coqui-eligible vs still-unsupported).
- Vitest frontend (`src/modals/voice-readiness-gate.test.tsx`, `src/store/voice-readiness-selectors.test.ts`) — `selectHasNoFallbackEngine`, `selectFallbackEngineName`, and `voiceReadinessGateMessage`'s three branches (English Kokoro soft-gate, Coqui-eligible soft-gate, still-unsupported hard block).
- Vitest frontend (`src/lib/voice-status.test.ts`) — the new "Fallback (Coqui)" pill parallel to "Fallback (Kokoro)".
- Vitest frontend (`src/modals/profile-drawer.test.tsx`) — `lockedToQwen` now derives from `eligibleTtsEngines.length === 1 && eligibleTtsEngines[0] === 'qwen'`.
- Playwright e2e (`e2e/generation/coqui-fallback-non-english.spec.ts`) — asserts the picker unlocks Coqui as a manually selectable engine for a Coqui-eligible non-English book, the voice-readiness gate shows the "Proceed anyway" affordance naming Coqui, and the rendered "Fallback (Coqui)" status pill — via direct redux dispatch, since mock mode can't produce a server-only render-time fallback.

**Explicitly not covered — Live-GPU acceptance is owed.** The e2e spec above is mock-mode UI-seam + pill coverage only; the real render-time Coqui fallback (the sidecar actually falling back to a Coqui voice mid-chapter, and the Qwen/Coqui evict-and-reload sequencing under real VRAM pressure) has not been exercised on an 8 GB box. This plan's status stays `active`, not `stable`, until that walkthrough runs.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) for the UI-seam parts; the render-time fallback itself needs the real sidecar (see above).

1. **Open a Russian-language book's cast view** (`#/books/<id>/cast`) with an undesigned speaking character → banner reads "Undesigned characters fall back to a generic Coqui voice" (not the old hard-block "can't be generated" copy).
2. **Open the same character's profile drawer, engine picker** → Coqui is selectable (not disabled/hidden) alongside Qwen.
3. **Navigate to the manuscript view and trigger the voice-readiness gate** on that book → modal shows "Design them now, or proceed and they'll render with a Coqui fallback voice" and a "Proceed anyway" button (not a hard block with no proceed option).
4. **Proceed anyway → generate the chapter (real sidecar required)** → the undesigned character's segment renders via Coqui; cast view shows a "Fallback (Coqui)" status pill for that character afterward.
5. **Repeat steps 1–3 on a still-unsupported non-English book (e.g. Chinese)** → banner and gate keep the original hard-block copy ("can't be generated" / no proceed button) — the Coqui-eligible language set does not leak to zh/ja.

## Out of scope

- **Kokoro non-English support** (G2P backend + non-English voice packs) — `fs-69` (#1302).
- **XTTS languages beyond the five Qwen-aligned ones** (zh-cn, ja, ko, ar, hi, nl, pl, tr, cs, hu, it, pt) — `fs-70` (#1303).
- **Cross-book/cross-language voice-identity check** (an srv-36 extension, catching a translated-edition voice drifting from its source-language counterpart) — `fs-71` (#1304).
- **Recalibrating `ENGINE_VRAM_COST`'s `qwen` weight** to reflect real batched-workload VRAM (vs. the coarse `qwen:1` concurrency-slot heuristic) — a separate, riskier change affecting every existing Qwen-concurrency decision app-wide, deliberately not attempted here (design spec §4).
- **Live-GPU acceptance** of the real render-time Coqui fallback and the Qwen/Coqui evict-and-reload sequencing on an 8 GB box — owed, tracked via this plan staying `active` and the `fs-60` BACKLOG row.

### Accepted v1 limitations (explicitly not solved by this plan)

1. **Residual cross-book Qwen+Coqui VRAM-admission risk** (design spec §4). The within-chapter partition+evict guard (invariant #4 above) only protects a single book's own chapter. It does nothing for two *concurrently-rendering* books — e.g. Book A on Qwen, Book B falling back to Coqui — where the existing GPU semaphore's abstract `ENGINE_VRAM_COST` weights (`qwen:1`+`coqui:3`=4≤4 on an 8 GB-class budget) would admit that cross-book pair as "fitting," when the measured real footprints (Qwen up to ~5.5 GB batch-dependent + Coqui ~3 GB) say it may not actually fit. Correctly closing this needs recalibrating `ENGINE_VRAM_COST`'s `qwen` weight — deliberately out of scope here (see "Out of scope" above) since that change ripples into every existing Qwen-concurrency decision in the app, not just this feature.
2. **`evictQwenForCoquiPhase` is a global sidecar unload, not per-book** (`server/src/tts/synthesise-chapter.ts:817-832`). It calls the sidecar's `/unload` for the whole process, so it can evict a DIFFERENT, concurrently-rendering book's resident Qwen — not just this chapter's own. Accepted for v1 because a per-book-scoped unload would require the sidecar to track per-book model residency, a larger change than this plan's scope.
3. **The chapter's anchor group is exempt from the Qwen/Coqui serialization guarantee.** The very first body group is rendered by a standalone `synthGroup` call (to fix the chapter's sample-rate anchor, per plan 107/113) BEFORE `synthGroupsSerialized` is ever reached (`synthesise-chapter.ts:1411-1417`, comment at `:1597-1601`). If the sole Qwen-routed speaker in a chapter happens to land at sentence index 0 and every other speaker falls back to Coqui, that anchor's Qwen render and the body's later Coqui render phase DO co-reside (the anchor call finishes and returns before the body dispatch begins, but Qwen is not explicitly evicted between the two) — a narrow, accepted gap rather than a redesign of the sample-rate-anchor mechanism.

### Other follow-ups owed (not accepted limitations — cleanup opportunities noted in review)

- The 5-engine default array (`['qwen', 'kokoro', 'coqui', 'gemini', 'piper']`) is duplicated across `src/modals/profile-drawer.tsx:243`, `src/views/cast.tsx:143`, and `src/store/voice-readiness-selectors.ts:72,89` — could hoist to one shared const.
- `selectFallbackEngineName` (`voice-readiness-selectors.ts:87-91`) copy-derives its Coqui-vs-Kokoro logic rather than sharing a helper with `selectHasNoFallbackEngine` — same book-lookup + `eligibleTtsEngines` default duplicated across both.
- `cast.tsx`'s banner assumes `!qwenOnly ⇒ Coqui-eligible` (`src/views/cast.tsx:165`) — safe today (Coqui is the only non-Qwen engine ever eligible for a non-English book), but fragile if a third non-English-capable engine is added later (fs-70 territory) without updating this assumption.
- Wiki `Advanced-Settings.md`'s `PRELOAD_KOKORO` row is now stale (still documents the old `true` default) — needs a `wiki:sync` update in the separate wiki repo; out of scope for this PR.

## Ship notes

(Filled in when status flips to `stable` — i.e. once Live-GPU acceptance runs. See the `fs-60` row in `docs/BACKLOG.md` for the tracking pointer.)
