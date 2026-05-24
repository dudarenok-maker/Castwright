---
status: draft
shipped: null
owner: null
---

# 108 — Qwen3-TTS coexistence + per-character engine/voice + series rebaseline

> Status: draft — implemented across waves (see "Implementation waves" below). Each wave's PR flips the relevant section to `stable` and fills Ship notes.
> Key files: `server/tts-sidecar/main.py` (`QwenEngine`, inline like the other engines), `server/tts-sidecar/scripts/install-qwen3.mjs`, `server/src/tts/index.ts`, `server/src/tts/voice-mapping.ts`, `server/src/tts/synthesise-chapter.ts`, `server/src/tts/per-character-engine.ts`, `server/src/gpu/semaphore.ts`, `server/src/routes/rebaseline.ts`, `src/modals/rebaseline-modal.tsx`, `src/components/voice-engine-picker.tsx`, `src/views/account.tsx`
> URL surface: `#/cast` (per-character picker + rebaseline trigger), Account tab (dual-model flag + Qwen install), the global queue modal (engine badges)
> OpenAPI ops: `PUT /api/voices/{voiceId}/override` (+`scope`/`bookId`), new `POST /api/series/{bookId}/rebaseline/{propose,apply}`, `GET/PUT /api/user/settings` (+`dualModelEnabled`), sidecar `POST /load`,`/unload`,`/synthesize` (+`qwen` engine)

## Benefit / Rationale

- **User:** a second local TTS engine (Qwen3-TTS 0.6B) can be used _alongside_ Kokoro inside one book. A character can be moved to a different engine **and** a specific base voice from the cast view — today impossible for any character not already matched to a library voice. The change propagates across the whole book series. A new "Rebaseline the series" modal LLM-ranks the best voice across the engines the user selects for the principal cast, shows current-vs-proposed with audition, and on approval writes the changes (surfacing as drift) — the fix for "Maerin's voice isn't working, put her on a Qwen voice across her series."
- **Technical:** engine becomes a _per-character_ decision rather than one global `modelKey` per generation run. The GPU semaphore becomes VRAM-weighted so two engines never overcommit an 8 GB GPU. The queue surfaces each chapter's required engine set. Loading two engines into VRAM is gated behind a deliberate `dualModelEnabled` user setting.
- **Architectural:** establishes "add the Nth TTS engine" as a mechanical change (sidecar engine class + registry entry; preset engines add a server catalog table, bespoke engines like Qwen add a design/clone/cache path + a designed-voice library instead) and the per-engine `overrideTtsVoices` map as the durable cross-engine cast contract. Closes a long-standing drift gap: a voice change that lives in `overrideTtsVoices` (not `voiceId`) now actually trips drift detection.

## Architectural impact

### New seams / extension points

- **Sidecar engine registry** — `server/tts-sidecar/main.py` `ENGINES` dict gains `"qwen": QwenEngine()` (inline, matching the existing Coqui/Kokoro convention — NOT a separate `engines/` module as the original sketch guessed). Lazy by default (opt-in `PRELOAD_QWEN=1`). The `/synthesize` `{engine,model,voice,text}` contract is unchanged — `voice` is a designed voiceId.
- **Qwen is a BESPOKE per-character voice engine, not a preset catalog (the big pivot).** Unlike Kokoro's fixed 28 voices, a Qwen voice is **designed → cloned → cached → reused**: `generate_voice_design(instruct)` makes a reference clip from a natural-language persona → `create_voice_clone_prompt(...)` distils a reusable speaker embedding → cached to `voices/qwen/<voiceId>.pt` + a `.json` manifest → `generate_voice_clone(...)` reuses it for every sentence so the identity is identical across a book. New sidecar `POST /qwen/design-voice {voiceId, instruct, language?, calibrationText?}` designs + caches + returns an audition preview. `synthesize()` **fails fast** on an undesigned voiceId (no profile-inference fallback). Consequences for later waves: there is **NO `QWEN_PROFILE_VOICES` catalog table**; `pickVoiceForEngine('qwen', ...)` requires an explicit designed voiceId; `/speakers` lists designed voices; the cast picker (Wave 4) is a voice-DESIGN flow (persona auto-composed from the character's profile, editable, preview) not a list pick; the rebaseline LLM (Wave 5) proposes a persona per character; designed voices are **reusable library entries** (cached embedding keyed by voiceId, series-propagating). Decisions locked 2026-05-24; see `~/.claude/plans/ok-i-want-to-sparkling-acorn.md` + memory `project_qwen_tts_voice_design`.
- **Narrator stays Kokoro.** Per-character engine means the narrator keeps a Kokoro preset (no "character" to design a voice for) while speaking characters move to bespoke Qwen voices — the user's stated near-future direction (Qwen likely becomes primary, Kokoro reserved for narrator).
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

- **Sidecar pytest** `server/tts-sidecar/tests/test_qwen3.py` (shipped, 12 cases, stubs `qwen_tts`+`torch` like `test_kokoro.py`) — registration; `/health` qwen fields; `/speakers` lists designed voices; `design_voice` caches `.pt`+`.json` and returns preview PCM; `synthesize` reuses the cached embedding; **fail-fast on an undesigned voice**; the `/qwen/design-voice` + `/synthesize` HTTP surface; missing-`qwen-tts` install hint; unload idempotency. Real-model voice-CONSISTENCY across calls is the separate empirical step (owned by `install-qwen3.mjs` + a GPU). Later: extend `test_concurrent_synthesis.py` — Kokoro+Qwen run in parallel, no cross-bleed, no deadlock.
- **Server Vitest** `semaphore.test.ts` (weighted acquire/release, `cost>budget` clamp, FIFO, counted==weighted back-compat, no deadlock); `voice-mapping.test.ts` (Qwen resolves ONLY via an explicit designed voiceId — no profile-inference fallback, unlike the preset engines; preset engines still audit their catalog); `index.test.ts` (engineForModelKey/sidecarModelId/label); `synthesise-chapter.test.ts` (mixed-engine chapter — two providers, index-order concat, resample; no-`ttsEngine` == today); generation route (dual-model OFF mixed → `engine_swap`+`warning`, correct audio; ON → no swap); `chapter-engine-set.test.ts`; `queue.test.ts` (stamps `requiredEngines`/`multiTts`); `voices.test.ts` (`scope=series` writes only that series); `revisions.test.ts` (override/engine change → severe drift — the R5 fix); `rebaseline-rank.test.ts` + `rebaseline.test.ts`.
- **Frontend Vitest** `account-slice.test.ts` (dualModel reducer/dirty/patch); `principal-cast.test.ts` (80%-of-lines ex-narrator: narrator excluded even if top, ties, <80% edge); `profile-drawer.test.tsx` (engine+voice picker for a non-library character writes the series override); `voices-slice.test.ts`; `queue-slice.test.ts`; `rebaseline-slice.test.ts`; `rebaseline-modal.test.tsx` (default = principal cast, audition).
- **Pester** `scripts/tests/` — `install-qwen3.ps1` wrapper.
- **Playwright e2e** `account.spec.ts` (dual-model checkbox + Qwen install card), `queue.spec.ts` (engine badge + dual-model-off warning), `cast.spec.ts` (change a character to Qwen + voice, persists), `rebaseline.spec.ts` (propose → approve → drift report shows entries).

### Manual acceptance walkthrough

Run against the real backend + sidecar (this feature is sidecar-bound). Canonical manuscript: `C:\Users\dudar\Downloads\the Coalfall Commission.txt` (English, do not commit).

1. **Account tab** → Qwen install card visible → install → enable the dual-model flag (default off) → `GET /api/sidecar/health` reports `qwen_loaded` after a load.
2. **Cast view** → open a character's profile → switch engine to Qwen → either pick an existing designed voice OR design a new one (persona auto-composed from the profile, editable) → audition plays the designed Qwen voice → save → open another book in the same series → the character shows the same Qwen voice (series-scoped, reusable library entry).
3. **Generate** a chapter where two characters use different engines: dual-model ON → no engine swap; toggle OFF + re-run → inline warning recommends enabling dual-model, audio still correct.
4. **Queue modal** → enqueue one single-engine chapter and one multi-engine chapter → badges name the engines; the multi one warns when dual-model is OFF.
5. **Voice tab** → "Rebaseline the series" → principal cast (~80% of non-narrator lines) pre-selected → pick Kokoro+Qwen → review LLM proposals with current-vs-proposed audition → approve → drift report shows new severe voice/engine entries for already-generated chapters.
6. **Concurrency** → `GPU_VRAM_BUDGET=4` → mixed-engine run shows Kokoro+Qwen concurrent via `GET /api/gpu/queue` but Coqui+anything serializes; unset budget + Kokoro-only reproduces current single-engine timing.

## Out of scope

- **Multi-language / Russian** — the language half of BACKLOG Must #2 (BCP-47 `language` field, Cyrillic detection, voice-library language filtering, Cyrillic token estimator). This plan delivers only the Qwen _engine_ + coexistence. Must #2 stays on the backlog for the language work.
- **Per-quote emotion / intonation control (DEFERRED).** Qwen ignores per-utterance `instruct` on cloned/designed voices today (confirmed in the Qwen team's own discussion — only the built-in CustomVoice speakers or a fine-tune honor emotion instruct; their unreleased VoiceEditing model is the intended fix). We bake the character's dominant emotional register into the designed persona and keep the analyzer's per-sentence emotion tags detected + wired but UNUSED at synth, ready to switch on when VoiceEditing ships. File the switch-on as a follow-up when that model lands.
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

### Wave 1 — `feat/sidecar-qwen3-engine`

- New `QwenEngine` (inline in `server/tts-sidecar/main.py`, matching the Coqui/Kokoro convention — the original sketch's separate `engines/qwen3.py` would have forced a circular import with the in-`main` `Engine`/`SynthResult`/`_float_audio_to_int16_le`). Implements the design → clone → cache → reuse model: `design_voice(voiceId, instruct, language, calibrationText)` loads the VoiceDesign model transiently → `generate_voice_design` → `create_voice_clone_prompt` on the resident Base model → caches the prompt to `voices/qwen/<voiceId>.pt` + a `<voiceId>.json` manifest → returns an audition preview; `synthesize(model, voice, text)` loads the cached prompt and `generate_voice_clone`s, **failing fast** if the voice was never designed (no catalog fallback). The `qwen_tts` API coupling is isolated to `_load_qwen_model` / the `_qwen_*` calls so a signature drift is a one-place fix.
- Wired into `ENGINES`, `/load` + `/unload` (warms/drops the resident Base; VoiceDesign stays transient), `/health` (`qwen_loaded` / `qwen_loading`, same pattern as Kokoro), `/speakers` (lists designed voiceIds from the manifests, available even unloaded), and the `/synthesize` router. New `POST /qwen/design-voice` route. Lazy by default; opt-in `PRELOAD_QWEN=1` eager-warms the Base model.
- Cross-platform `scripts/install-qwen3.mjs` (Node ESM) pip-installs `qwen-tts` and pre-fetches the Base + VoiceDesign weights into the default Hugging Face cache (where the engine's `from_pretrained` looks); thin `scripts/install-qwen3.ps1` wrapper forwards to it. `requirements.txt` documents `qwen-tts` (commented — may pull a `transformers` newer than coqui-tts's `<5.0` cap; the installer resolves it; verified empirically at download).
- Tests: `server/tts-sidecar/tests/test_qwen3.py` (12 cases, all green, stubs `qwen_tts`+`torch`). **Empirical verification DONE (2026-05-24, `fix/sidecar-qwen-torch-load`):** ran the real model end-to-end (design `smoke-Maerin` from a persona → cache → synth two lines reusing the cached embedding → fail-fast on undesigned). Confirmed the `qwen_tts` signatures match. Two real-world fixes landed: (1) `torch.load(weights_only=False)` — PyTorch 2.6+ rejects the `qwen_tts` `VoiceClonePromptItem` under the default safe-unpickler; (2) the installer now prefetches into the default HF cache instead of `voices/qwen/hf` (the engine didn't set `HF_HOME`, so it ignored that copy and re-downloaded Base on first use — a ~6-min cold stall). Open: `flash-attn` not installed → manual PyTorch path (~11–15 s/line); install it for speed.
- Voice model decisions (locked 2026-05-24): Qwen-only now (Kokoro keeps presets, reserved for narrator); persona auto-composed from the character profile + editable; reusable library voice entries; per-quote emotion deferred. See the "Sidecar engine registry" / "BESPOKE" bullets above + the Out-of-scope emotion note.

### Wave 1 — `feat/account-dual-model-flag`

- Added the `dualModelEnabled` user setting (default `false`) end-to-end — `openapi.yaml` `UserSettings` + `UserSettingsPatch` (regenerated `src/lib/api-types.ts`), `server/src/workspace/user-settings.ts` zod schema + `DEFAULT_USER_SETTINGS`, `src/lib/account-defaults.ts`, `src/store/account-slice.ts` (`setDualModelEnabled` reducer), and the Account-view checkbox in the TTS-sidecar card (no restart badge — takes effect on the next generation run). Also added the Qwen3-TTS install-command card (`account-qwen-install-cmd`) alongside the Coqui block in `<ModelsCard>`. Mock `putUserSettings` echoes the new field so the e2e round-trip works. Tests: `account-slice.test.ts` (reducer/hydrate/save patch), `account.test.tsx` (checkbox + Qwen card), server `user-settings.test.ts` (schema accept/reject/optional/round-trip), e2e `account-dual-model.spec.ts`. The sidecar-side enforcement of dual-residency (the `feat/sidecar-qwen3-engine` engine + Wave 2 generation wiring) reads this flag at generation time; this slice only persists the preference.

### Wave 2b — `feat/server-per-character-engine`

- Engine is now a PER-CHARACTER decision. New `server/src/tts/per-character-engine.ts#resolveCharacterEngine(c, defaultEngine)` (`c.ttsEngine ?? default`); new optional `CastCharacter.ttsEngine`. `synthesise-chapter.ts` gains an optional `resolveForEngine(engine) => { provider, modelKey }` callback + a `routeFor(character)` helper used by every body group AND the title beat; absent the callback (or with no per-character `ttsEngine`), everything uses the run default — byte-identical to pre-108. The existing index-order concat + `resamplePcm16` reassembles a mixed-engine chapter cleanly (per-engine sample-rate differences resample to the anchor). `toVoiceLike` exported for reuse.
- `generation.ts`: builds a per-engine provider cache (`resolveForEngine`; default engine reuses the request's provider/modelKey, others via `selectTtsProvider(canonicalModelKeyForEngine(e))`), threads it into `synthesiseChapter`, and stamps the drift snapshot per-character — `voiceEngine: resolveCharacterEngine(c, engine)` (was the global engine) plus the new `resolvedVoiceName` (the actual `pickVoiceForEngine` output, so an override-only change is detectable). Dual-model advisory: when the cast mixes engines and `dualModelEnabled` is off, emits a `warning` SSE (`code: 'dual_model_off_multi_engine'`) + server log; the run proceeds (sidecar lazy-loads each engine).
- The R5 drift **comparison** half (engine + resolved-name diff in `revisions.ts`) lands in Wave 4 with the override-editing UI that creates such changes; this wave only captures the snapshot data.
- Tests: `per-character-engine.test.ts`; `synthesise-chapter.test.ts` mixed-engine routing (narrator→Kokoro + Maerin→Qwen with her designed voiceId, narrative-order reassembly, 16k→24k resample to anchor) + the no-`ttsEngine`/no-`resolveForEngine` == pre-108 case. typecheck clean (the `'qwen'` union member stays total); 32 server tests green.
