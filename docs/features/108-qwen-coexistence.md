---
status: draft
shipped: null
owner: null
---

# 108 — Qwen3-TTS coexistence + per-character engine/voice + series rebaseline

> Status: draft — implemented across waves (see "Implementation waves" below). Each wave's PR flips the relevant section to `stable` and fills Ship notes.
> Key files: `server/tts-sidecar/engines/qwen3.py`, `server/src/tts/index.ts`, `server/src/tts/voice-mapping.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/tts/per-character-engine.ts`, `server/src/gpu/semaphore.ts`, `server/src/routes/rebaseline.ts`, `src/modals/rebaseline-modal.tsx`, `src/components/voice-engine-picker.tsx`, `src/views/account.tsx`
> URL surface: `#/cast` (per-character picker + rebaseline trigger), Account tab (dual-model flag + Qwen install), the global queue modal (engine badges)
> OpenAPI ops: `PUT /api/voices/{voiceId}/override` (+`scope`/`bookId`), new `POST /api/series/{bookId}/rebaseline/{propose,apply}`, `GET/PUT /api/user/settings` (+`dualModelEnabled`), sidecar `POST /load`,`/unload`,`/synthesize` (+`qwen` engine)

## Benefit / Rationale

- **User:** a second local TTS engine (Qwen3-TTS 0.6B) can be used _alongside_ Kokoro inside one book. A character can be moved to a different engine **and** a specific base voice from the cast view — today impossible for any character not already matched to a library voice. The change propagates across the whole book series. A new "Rebaseline the series" modal LLM-ranks the best voice across the engines the user selects for the principal cast, shows current-vs-proposed with audition, and on approval writes the changes (surfacing as drift) — the fix for "Maerin's voice isn't working, put her on a Qwen voice across her series."
- **Technical:** engine becomes a _per-character_ decision rather than one global `modelKey` per generation run. The GPU semaphore becomes VRAM-weighted so two engines never overcommit an 8 GB GPU. The queue surfaces each chapter's required engine set. Loading two engines into VRAM is gated behind a deliberate `dualModelEnabled` user setting.
- **Architectural:** establishes "add the Nth TTS engine" as a mechanical change (sidecar engine class + registry entry + server catalog table) and the per-engine `overrideTtsVoices` map as the durable cross-engine cast contract. Closes a long-standing drift gap: a voice change that lives in `overrideTtsVoices` (not `voiceId`) now actually trips drift detection.

## Architectural impact

### New seams / extension points

- **Sidecar engine registry** — `server/tts-sidecar/main.py` `ENGINES` dict gains `"qwen": QwenEngine()` (lazy, opt-in `PRELOAD_QWEN=0`). New `server/tts-sidecar/engines/qwen3.py` mirrors `KokoroEngine`. The `/synthesize` `{engine,model,voice,text}` contract is unchanged — new engines route through it transparently.
- **Per-character engine** — new optional `Character.ttsEngine?: TtsEngine`. New `server/src/tts/per-character-engine.ts#resolveCharacterEngine(c, projectDefaultEngine)`: precedence `c.ttsEngine → projectDefaultEngine`. Absent field reproduces today's behavior (back-compat).
- **VRAM-weighted semaphore** — `server/src/gpu/semaphore.ts` rewritten to a token budget (`GPU_VRAM_BUDGET`, derived from legacy `GPU_CONCURRENCY` when unset). `acquire(cost=1)` takes cost-many tokens; per-engine costs in new `server/src/tts/engine-vram-cost.ts`. `maxConcurrency`/`inFlight`/`queueDepth` getters retained so `synthesise-chapter.ts` and `gpu-queue.ts` keep working.
- **Series-scoped override write** — `PUT /api/voices/:voiceId/override` gains `scope`/`bookId` params; new `applyOverrideToSeries`. New `findAuthorSeriesForBookId` exported from `series-cast-scan.ts`.
- **Rebaseline** — new `POST /api/series/:bookId/rebaseline/{propose,apply}` (`server/src/routes/rebaseline.ts`) backed by `server/src/analyzer/rebaseline-rank.ts` (a minimal `generateJson` path through `selectAnalyzer({})` + the GPU semaphore).
- **`dualModelEnabled`** user setting (default `false`) — openapi → `user-settings.ts` zod → `account-slice.ts` → `account.tsx`.

### Invariants preserved

- **OpenAPI is the type source of truth** (plan 24): `ttsEngine`, `dualModelEnabled`, rebaseline shapes, override `scope` all land in `openapi.yaml` first.
- **RTK Immer drafts** (plan 26): new `rebaseline-slice` mutates drafts.
- **Mock toggle** (plan 23): new endpoints get mock implementations behind `api.*`.
- **Concurrent multi-book workflow** (project invariant): mixed-engine generation and rebaseline must not break cross-book queue dispatch; global pills stay live regardless of viewed book.
- **`GEN_CHAPTER_CONCURRENCY` stays global** (plan 87) — only the GPU semaphore becomes VRAM-weighted.
- **Single-engine behavior unchanged**: with only one engine used and `GPU_VRAM_BUDGET` unset, generation and GPU arbitration are byte-identical to today.

### Migration story

- `Character.ttsEngine` and `CharacterSnapshot.resolvedVoiceName` are additive optional fields — absence means "no signal" (same lazy-tolerance as today's optional snapshot fields). No backfill.
- `overrideTtsVoices` already migrates legacy `overrideTtsVoice` lazily at cast.json read (`normaliseCastCharacter`, `server/src/routes/voices.ts`); the new `qwen` slot is just another key.

### Reversibility

- Each wave is its own branch/PR and individually revertable. The sidecar engine is opt-in (`PRELOAD_QWEN=0`), the dual-model flag defaults off, and the semaphore falls back to count-equivalent behavior when `GPU_VRAM_BUDGET` is unset — so reverting any single wave leaves the rest functional.

## Invariants to preserve

- `server/src/gpu/semaphore.ts:96-99` reads `GPU_CONCURRENCY` at module load; the rewrite must keep a singleton, keep FIFO order, and keep `maxConcurrency`/`inFlight`/`queueDepth` getters (consumed by `server/src/tts/synthesise-chapter.ts` poolWidth default and `server/src/routes/gpu-queue.ts`).
- `server/src/routes/revisions.ts:175-179` currently has NO engine-drift factor and compares `snapshot.voiceId` vs `current.voiceId` only. A rebaseline writes `overrideTtsVoices[engine].name`, NOT `voiceId` — so without the R5 fix (snapshot + compare the _resolved_ voice name + engine) it produces zero drift. The fix must add `resolvedVoiceName` to the snapshot and a comparison here.
- `server/src/routes/generation.ts` resolves engine in three places (resolve, thread into `synthesiseChapter`, drift snapshot `voiceEngine`). All three must become per-character.
- `server/tts-sidecar/main.py` `ENGINES` registry + `/synthesize` `{engine,model,voice,text}` contract is the single seam for engine addition — do not special-case Qwen elsewhere in the sidecar.

## Implementation waves

- **Round 0 (this PR)** — docs/backlog reconciliation + this plan. No code.
- **Wave 1 (3 parallel):** `feat/sidecar-qwen3-engine` (engine + install + spike), `feat/gpu-vram-weighted-semaphore`, `feat/account-dual-model-flag`.
- **Wave 2 (sequential):** `feat/tts-qwen-engine-types` → `feat/generation-per-character-engine`.
- **Wave 3 (∥ Wave 4):** `feat/queue-multi-tts-indicators`.
- **Wave 4 (∥ Wave 3):** `feat/cast-per-character-engine-voice` (+ R5 drift fix + series-scoped write).
- **Wave 5 (last):** `feat/voice-rebaseline-series`.

Full design detail (per-wave file scopes, the engine-swap path, the LLM prompt shape, risks) lives in `~/.claude/plans/ok-i-want-to-sparkling-acorn.md`.

## Test plan

### Automated coverage

- **Sidecar pytest** `server/tts-sidecar/tests/test_qwen3.py` — `engine:"qwen"` → non-empty int16 PCM + sample-rate header; voice substitution + `substituted_from`; `/health` qwen fields. Extend `test_concurrent_synthesis.py` — Kokoro+Qwen run in parallel, no cross-bleed, no deadlock.
- **Server Vitest** `semaphore.test.ts` (weighted acquire/release, `cost>budget` clamp, FIFO, counted==weighted back-compat, no deadlock); `voice-mapping.test.ts` (Qwen catalog audit + override/inference resolve); `index.test.ts` (engineForModelKey/sidecarModelId/label); `synthesise-chapter.test.ts` (mixed-engine chapter — two providers, index-order concat, resample; no-`ttsEngine` == today); generation route (dual-model OFF mixed → `engine_swap`+`warning`, correct audio; ON → no swap); `chapter-engine-set.test.ts`; `queue.test.ts` (stamps `requiredEngines`/`multiTts`); `voices.test.ts` (`scope=series` writes only that series); `revisions.test.ts` (override/engine change → severe drift — the R5 fix); `rebaseline-rank.test.ts` + `rebaseline.test.ts`.
- **Frontend Vitest** `account-slice.test.ts` (dualModel reducer/dirty/patch); `principal-cast.test.ts` (80%-of-lines ex-narrator: narrator excluded even if top, ties, <80% edge); `profile-drawer.test.tsx` (engine+voice picker for a non-library character writes the series override); `voices-slice.test.ts`; `queue-slice.test.ts`; `rebaseline-slice.test.ts`; `rebaseline-modal.test.tsx` (default = principal cast, audition).
- **Pester** `scripts/tests/` — `install-qwen3.ps1` wrapper.
- **Playwright e2e** `account.spec.ts` (dual-model checkbox + Qwen install card), `queue.spec.ts` (engine badge + dual-model-off warning), `cast.spec.ts` (change a character to Qwen + voice, persists), `rebaseline.spec.ts` (propose → approve → drift report shows entries).

### Manual acceptance walkthrough

Run against the real backend + sidecar (this feature is sidecar-bound). Canonical manuscript: `C:\Users\dudar\Downloads\the Coalfall Commission.txt` (English, do not commit).

1. **Account tab** → Qwen install card visible → install → enable the dual-model flag (default off) → `GET /api/sidecar/health` reports `qwen_loaded` after a load.
2. **Cast view** → open a character's profile → switch engine to Qwen → pick a base voice → audition plays the Qwen voice → save → open another book in the same series → the character shows the Qwen voice (series-scoped).
3. **Generate** a chapter where two characters use different engines: dual-model ON → no engine swap; toggle OFF + re-run → inline warning recommends enabling dual-model, audio still correct.
4. **Queue modal** → enqueue one single-engine chapter and one multi-engine chapter → badges name the engines; the multi one warns when dual-model is OFF.
5. **Voice tab** → "Rebaseline the series" → principal cast (~80% of non-narrator lines) pre-selected → pick Kokoro+Qwen → review LLM proposals with current-vs-proposed audition → approve → drift report shows new severe voice/engine entries for already-generated chapters.
6. **Concurrency** → `GPU_VRAM_BUDGET=4` → mixed-engine run shows Kokoro+Qwen concurrent via `GET /api/gpu/queue` but Coqui+anything serializes; unset budget + Kokoro-only reproduces current single-engine timing.

## Out of scope

- **Multi-language / Russian** — the language half of BACKLOG Must #2 (BCP-47 `language` field, Cyrillic detection, voice-library language filtering, Cyrillic token estimator). This plan delivers only the Qwen _engine_ + coexistence. Must #2 stays on the backlog for the language work.
- **Per-segment / cross-series voice linking** — tracked separately on the backlog.

## Ship notes

(Filled per wave as each flips to `stable`.)

### Wave 1 — `feat/gpu-vram-weighted-semaphore`

- `server/src/gpu/semaphore.ts` rewritten from a flat count semaphore to a VRAM token-budget semaphore. `acquire(cost = 1)` now takes `cost` tokens; grants immediately only when no waiter is queued ahead AND `used + cost <= budget`, else queues FIFO and drains as many head-of-line waiters as fit on each release. `cost` is clamped into `[1, budget]` (a `cost > budget` runs alone instead of deadlocking; `cost < 1` floors to 1). The single-use double-release guard is preserved.
- Singleton budget resolves from new env `GPU_VRAM_BUDGET`; when unset/invalid it falls back to `GPU_CONCURRENCY` (default 1) — so a single-engine box with every caller at the default cost 1 behaves byte-identically to the old count semaphore. Retained getters: `queueDepth`, `inFlight` (holder count), `maxConcurrency` (returns budget, so `synthesise-chapter.ts`'s poolWidth default is unchanged). Added `budget` + `usedTokens`.
- New `server/src/tts/engine-vram-cost.ts`: provisional `ENGINE_VRAM_COST` (`kokoro 1, qwen 1, coqui 3, gemini 0, analyzer 4`), `costForEngine(engine)` (unknown → 1), and `DEFAULT_GPU_VRAM_BUDGET = 4`. Values are estimates — tuning tracked in BACKLOG #39.
- Acquire sites now charge per-engine cost: `sidecar.ts` → `costForEngine(this.engine)`, `ollama.ts` → `costForEngine('analyzer')`. `gpu-queue.ts` JSON gains `budget` + `usedTokens` additively (`max` still aliases the budget).
- `server/.env.example` documents `GPU_VRAM_BUDGET` with the fallback-to-`GPU_CONCURRENCY` note.
- Tests: `server/src/gpu/semaphore.test.ts` (weighted acquire/release at budget 4, `cost > budget` clamp, `cost < 1` clamp, head-of-line FIFO blocking, weighted double-release no-leak, plus the back-compat invariant that budget = N + cost 1 == old count semaphore max = N) and new `server/src/tts/engine-vram-cost.test.ts`.
