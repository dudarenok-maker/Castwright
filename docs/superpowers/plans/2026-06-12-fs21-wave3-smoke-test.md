# fs-21 Wave 3 — Two-tier smoke test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Replace the Wave 2 Step-Finish "coming soon" placeholder with the real **two-tier smoke test**: (Tier 1) a light `POST /api/setup/smoke` that synthesizes a fixed sentence → ffmpeg-assembles → returns an audible clip + pings the analyzer; (Tier 2) an opt-in "Hear the demo book" affordance that reuses the shipped fs-22 sample-load + open flow so the user runs the real pipeline on The Coalfall Commission.

**Architecture:** Tier 1 mirrors the existing `voice-sample` route exactly (`selectTtsProvider(modelKey)` → `provider.synthesize({text,voiceName,modelKey})` → `encodePcmToAudio(pcm, sr)` → write a temp mp3 + return its URL) + an analyzer liveness ping (`probeOllamaHealth` for local / `getResolvedGeminiApiKey` for gemini). Synchronous endpoint (synth is seconds, no poll job), and it returns `200 { ok:false, error }` on any sidecar/ffmpeg failure — never 500. Tier 2 reuses the existing fs-22 `api.loadSample` + `openBook` flow (the demo lands in cast-confirm → the user proceeds through the normal confirm→generate→listen pipeline). The Step-Finish UI gets a "Run smoke test" button (Tier 1) + a "Hear the demo book" button (Tier 2) + the existing "Finish setup".

**Tech Stack:** Express/TS (one new route), React 18, Vitest + Playwright. Mocks behind `VITE_USE_MOCKS`.

**Spec:** `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md` · **Epic:** #474 · **Branch:** `feat/fs21-wave3-smoke-test` off `main` (worktree `C:\Claude\Projects\wt-fs21-wave3`).

> **Inherently OWED (needs real sidecar+Kokoro+ffmpeg+GPU):** the actual audible Tier 1 synth and the Tier 2 demo-book generation. **Unit-testable here (stubs):** the route wiring (stub `selectTtsProvider`+`encodePcmToAudio` like `voice-sample.test.ts`), the api mock, the Step-Finish UI (mock mode returns `stub-a.mp3`).

> **Standing rule:** adversarial plan review BEFORE any task executes.

---

## File Structure
- Modify `server/src/routes/setup-readiness.ts` — add `POST /smoke` (Tier 1). Test: extend `server/src/routes/setup-readiness.route.test.ts` (slow pool) with a stubbed-provider case.
- Modify `src/lib/api.ts` — `runSmokeTest()` real + mock (mock returns `stub-a.mp3` url) + wire into both maps.
- Modify `src/components/setup/step-finish.tsx` — replace the placeholder with Tier 1 (Run smoke test → audio player + analyzer status) + Tier 2 (Hear the demo book) + Finish.
- Modify `src/components/setup/setup-wizard.tsx` + `src/views/setup.tsx` + `src/routes/index.tsx` — thread an `onTryDemoBook` callback (reusing the fs-22 loadSample+openBook flow) down to StepFinish.
- Tests beside each + extend `e2e/setup-wizard.spec.ts`.

---

## Task S1: `POST /api/setup/smoke` (Tier 1)

**Files:** Modify `server/src/routes/setup-readiness.ts`; extend `server/src/routes/setup-readiness.route.test.ts` (slow pool).

**Step 1: READ `server/src/routes/voice-sample.ts`** (the exact synth→encode→write→url pattern + `defaultModelKeyForEngine`) and `server/src/routes/voice-sample.test.ts` (how it stubs `synthesize` with `Buffer.alloc(...)`). **READ the response shape needs:** `{ ok: boolean; url?: string; durationSec?: number; analyzerOk?: boolean; analyzerDetail?: string; stage?: 'synth'|'assemble'|'analyzer'; error?: string }`.

**Add a failing test** to `setup-readiness.route.test.ts`. Use **`vi.mock` (NOT an injection seam — that's over-engineering; voice-sample.test.ts proves vi.mock works against a router)**: `vi.mock('../tts/index.js', async (importOriginal) => ({ ...(await importOriginal()), selectTtsProvider: vi.fn(() => ({ synthesize: vi.fn().mockResolvedValue({ pcm: Buffer.alloc(24000*2*0.3, 0), sampleRate: 24000, mimeType: 'audio/L16' }) })) }))` and `vi.mock('../tts/mp3.js', () => ({ encodePcmToAudio: vi.fn().mockResolvedValue(Buffer.from([0xff])) }))`. **In `beforeAll`, set `process.env.VOICE_SAMPLE_AUDIO_DIR` to a tempdir** (mirror `voice-sample.test.ts` exactly) so the real `writeFile` doesn't litter `server/audio/voices/`. Assert: `POST /api/setup/smoke` → 200 `{ ok: true, url: <string>, analyzerOk: <bool> }`. Second case: make `synthesize` reject → 200 `{ ok: false, stage: 'synth', error }` (NOT 500).

**Step 2: Run → FAIL** (`cd server && npx vitest run --config vitest.config.slow.ts src/routes/setup-readiness.route.test.ts`).

**Step 3: Implement** `setupReadinessRouter.post('/smoke', ...)`:
- Hard-code Kokoro for the smoke: `modelKey = 'kokoro-v1'`, `voiceName = 'af_heart'`, `text = 'The lighthouse keeper watched the grey sea roll in.'` (a known-good Kokoro normalization sentence).
- `try { const provider = selectTtsProvider(modelKey); const { pcm, sampleRate } = await provider.synthesize({ text, voiceName, modelKey }); const mp3 = await encodePcmToAudio(pcm, sampleRate); await mkdir(voiceSampleAudioDir(), { recursive: true }); await writeFile(voiceSampleFilePath('setup-smoke.mp3'), mp3); url = voiceSamplePublicUrl('setup-smoke.mp3'); } catch (e) { return res.json({ ok: false, stage: 'synth', error: (e as Error).message }); }` — use a **FIXED filename `setup-smoke.mp3`** (overwrite each run — no caching/accumulation). **Import the real helpers** `voiceSampleAudioDir`, `voiceSampleFilePath`, `voiceSamplePublicUrl` from `../tts/voice-sample-cache.js` (voice-sample.ts imports them from there — there is NO inline helper). The `await mkdir(voiceSampleAudioDir(), { recursive: true })` is REQUIRED (a fresh workspace has no `audio/voices` dir → write throws otherwise). `selectTtsProvider('kokoro-v1')` does not throw (only the Gemini-no-key path throws); the throw surface is `synthesize()` (sidecar unreachable) — caught here → `ok:false`, never 500.
- Analyzer ping: `const engine = getResolvedAnalysisEngine(); let analyzerOk, analyzerDetail; if (engine==='gemini') { analyzerOk = getResolvedGeminiApiKey()!=null; analyzerDetail = analyzerOk?'API key set':'no key'; } else { const o = await probeOllamaHealth(); analyzerOk = o.status==='reachable'; analyzerDetail = o.error ?? (o.modelPulled?'model pulled':'reachable'); }` (probeOllamaHealth has its own 2s timeout). Never let the analyzer ping fail the whole request — wrap in try/catch.
- Return `res.json({ ok: true, url, durationSec, analyzerOk, analyzerDetail })`.
- Imports: `selectTtsProvider` from `../tts/index.js`, `encodePcmToAudio` from `../tts/mp3.js`, `probeOllamaHealth` from `./ollama-health.js`, `getResolvedAnalysisEngine`/`getResolvedGeminiApiKey` from `../workspace/user-settings.js` (some already imported).

**Step 4: Run → PASS** (the slow-pool route test) + `npm run typecheck`.

**Step 5: Commit** `feat(server): POST /api/setup/smoke light Tier-1 smoke test (fs-21 wave 3)` (add the route + the slow-pool test).

---

## Task S2: `api.runSmokeTest` client + mock

**Files:** Modify `src/lib/api.ts`; extend `src/lib/api.test.ts`.

- [ ] **Step 1: Failing test** — `mockRunSmokeTest()` resolves `{ ok: true, url: <string>, analyzerOk: true }` (test the exported mock directly).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** near `realCompleteSetup` (Wave 2): `SmokeTestResult` interface mirroring the server; `realRunSmokeTest()` → `POST /api/setup/smoke`; `export async function mockRunSmokeTest(): Promise<SmokeTestResult> { await wait(800); return { ok: true, url: stubAudioA, durationSec: 3.2, analyzerOk: true, analyzerDetail: '(mock)' }; }` (use the already-imported `stubAudioA` mp3 url — search `stub-a` in api.ts). Wire `runSmokeTest` into BOTH api maps.
- [ ] **Step 4: Run → PASS + typecheck.**
- [ ] **Step 5: Commit** `feat(frontend): api.runSmokeTest (fs-21 wave 3)`.

---

## Task S3: Step-Finish smoke UI (Tier 1) + demo-book affordance (Tier 2)

**Files:** Modify `src/components/setup/step-finish.tsx`; extend `src/components/setup/step-finish.test.tsx`. Widen `StepFinish` props to `{ readiness; onFinish; onTryDemoBook?: () => void }`.

- [ ] **Step 1: READ the current `step-finish.tsx`** (placeholder block + Finish button) AND `step-finish.test.tsx` (it has 2 placeholder-specific tests — the "arrives in the next release" copy + the "disabled smoke-test affordance" — that WILL fail once the placeholder becomes an enabled button; **you must update/replace those two assertions**, not just add new ones). **Failing tests** (mock `api`): clicking "Run smoke test" calls `api.runSmokeTest` and, on `ok:true`, renders an `<audio>` player with the returned `url` + an analyzer-status line; on `ok:false`, renders the error + stage. "Hear the demo book" calls `onTryDemoBook`. "Finish setup" calls `onFinish`. Keep `data-testid="smoke-test-placeholder"` on the (now-enabled) Run-smoke-test button so e2e can target it. **The smoke button is ALWAYS ENABLED** — do NOT gate it on `readiness.ready` (the e2e reaches the Finish step via `?setup=notready` → `readiness.ready === false`; gating would make the button un-clickable and break S5). `readiness` stays unused (`_readiness`) in StepFinish.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — replace the disabled placeholder with: a "Run smoke test" button (enabled) that calls `api.runSmokeTest()`, shows a spinner while pending, then on success an `<audio controls src={url}>` + "Analyzer: {analyzerDetail}", on failure the error + stage; a secondary "Hear the demo book" button calling `onTryDemoBook?.()` (with copy: generates the bundled demo audiobook end-to-end); keep the "Finish setup" PrimaryButton. Design tokens, no hex. Lint-clean.
- [ ] **Step 4: Run → PASS + typecheck + eslint.**
- [ ] **Step 5: Commit** `feat(frontend): Step-Finish two-tier smoke test UI (fs-21 wave 3)`.

---

## Task S4: thread `onTryDemoBook` through the wizard

**Files:** Modify `src/components/setup/setup-wizard.tsx`, `src/views/setup.tsx`, `src/routes/index.tsx`.

- [ ] **Step 1: Thread `onTryDemoBook` through FIVE edit points** (the prop must reach StepFinish): `SetupView` props → `SetupWizard` props → `renderStep(...)` signature → BOTH `GuidedWizard` and `ChecklistWizard` prop types + their `renderStep(...)` call sites → `case 'finish': <StepFinish ... onTryDemoBook={onTryDemoBook} />`. (Optional prop, so other steps/tests are unaffected.) In `SetupRoute`, implement `onTryDemoBook` as a **toast-free INLINE** sequence — do NOT reuse `BooksRoute.onTrySample` (it depends on `useOutletContext`'s `showError`/`showInfo`/`pushToast`, which `SetupRoute` is NOT inside the Outlet for → would not compile). Inline: `api.loadSample('the-coalfall-commission')` → `api.getLibrary()` → `dispatch(libraryActions.hydrate(res))` → find the book → `dispatch(uiActions.openBook({ id, status, manuscriptId }))`, `.catch(() => {})` (swallow locally). **Add the imports SetupRoute lacks today:** `useAppDispatch` (from `../store`), `libraryActions` (from `../store/library-slice`), `uiActions` (already imported). After `openBook`, the user leaves `#/setup` for the normal pipeline (demo lands in cast-confirm → confirm → generate → listen) — expected; the "full run" rides the shipped pipeline.
- [ ] **Step 2:** Update `setup-wizard.test.tsx` / `setup.test.tsx` if the prop addition needs it (optional prop → existing tests unaffected; add a case if useful).
- [ ] **Step 3: Run → PASS + typecheck + eslint** (`npx vitest run src/components/setup src/views/setup.test.tsx src/routes` + tsc + eslint).
- [ ] **Step 4: Commit** `feat(frontend): wire demo-book smoke (Tier 2) through the wizard (fs-21 wave 3)`.

---

## Task S5: e2e + verify + PR

- [ ] **Step 1:** Extend `e2e/setup-wizard.spec.ts`: navigate to the Finish step (or render it), click "Run smoke test" (`data-testid=smoke-test-placeholder`) → in mock mode `mockRunSmokeTest` returns `stub-a.mp3` → assert an `<audio>`/result appears; assert "Finish setup" present. (Reaching the Finish step in guided mode = click Next 4×; keep it resilient.)
- [ ] **Step 2:** `npm run verify` green (cache-aware retry for the `test:server` contention flake).
- [ ] **Step 3:** `gh pr create --draft --title "feat(server,frontend): fs-21 wave 3 — two-tier smoke test" --body "... Refs #474. OWED: real audible Tier-1 synth + Tier-2 demo-book generation (need a live sidecar+Kokoro+ffmpeg+GPU); route wiring + mock + UI tested here."` → `gh pr ready` once green.

---

## Self-Review
- Tier 1 (light, auto-offered on the Finish step) = synth+assemble+analyzer-ping via a synchronous `/api/setup/smoke`, mirroring voice-sample; returns ok:false (never 500) on failure. Tier 2 (opt-in full run) reuses the shipped fs-22 demo-book flow. The Step-5 placeholder is replaced.
- **Open questions for the adversarial review:** (1) confirm `voice-sample.ts`'s public-file-write/url helper is reusable (or whether the smoke endpoint should write to the same public dir); (2) confirm `selectTtsProvider` + `encodePcmToAudio` exact import paths + that `'kokoro-v1'`/`'af_heart'` are valid `TtsModelKey`/voice; (3) confirm the route test can stub these (does setup-readiness.ts need a `__setSmokeDeps` injection seam, or is `vi.mock('../tts/index.js')` cleaner given the slow-pool supertest already imports the module graph); (4) is reusing `onTrySample`'s body cleanly extractable, or should `onTryDemoBook` just inline it; (5) does the smoke endpoint's temp/public mp3 write need cleanup, and is writing to the voice-sample public dir acceptable; (6) is hard-coding Kokoro right even if the user's default engine is Qwen (recommend: smoke the user's DEFAULT engine, falling back to Kokoro — confirm how to resolve the default engine/voice cheaply).
