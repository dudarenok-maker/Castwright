# fs-21 Wave 2 — First-run wizard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Replace the Wave 0 `SetupView` stub with the real **hybrid guided/checklist first-run wizard** (5 steps: Environment/GPU → ffmpeg → Models → Defaults → Finish), composing the install components from Waves 1/1b, and add the `POST /api/setup/complete` route + the Account "Re-run setup" entry. The Step-5 audible smoke test is Wave 3 — here it's a clearly-labeled placeholder; "Finish" marks setup complete and returns home.

**Architecture:** A `setup-wizard.tsx` orchestrator holds step state and renders **guided mode** (linear, one step + Back/Next, when `completedAt == null`) or **checklist mode** (all steps visible, on re-entry). Each step is a small sub-component under `src/components/setup/`. Steps reuse the existing self-contained install components (`VenvBootstrap`, `KokoroInstall`, `Coqui/Qwen/Whisper/OllamaInstall`, `GeminiKeyField`, `DevicePanel`). After any install completes, the wizard re-fetches `api.getSetupReadiness()` so blocker status updates live. The hard gate stays derived (Wave 0); `completedAt` only suppresses the guided re-intro.

**Tech Stack:** React 18 + Redux Toolkit + react-router (frontend), Express/TS (the one new route), Vitest + Playwright.

**Spec:** `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md` · **Epic:** #474 · **Branch:** `feat/fs21-wave2-wizard-ui` off `main` (worktree `C:\Claude\Projects\wt-fs21-wave2`).

> **Gap resolutions (from the Wave 2 Explore):** ffmpeg = instruct-card (no installer, per spec); Step 5 = placeholder + a new `POST /api/setup/complete` (the smoke synth is Wave 3); `OllamaInstall` gains an `onInstalled` prop; "Re-run setup" Account button is new; `SetupRoute` re-fetches between steps. **Deferred (noted, not built):** the layout `completedAt`-aware splash-skip optimization (the Wave 0 gate works as-is).

> **Standing rule:** adversarial plan review BEFORE any task executes.

---

## File Structure
- Create `server/src/routes/setup-complete.ts` (or extend the setup-readiness router) — `POST /api/setup/complete` → `writeSetupCompletedAt(new Date().toISOString())` → `{ completedAt }`. Test beside it.
- Modify `src/lib/api.ts` — `completeSetup()` real + mock + wire into both maps.
- Modify `src/components/ollama-install.tsx` — add optional `onInstalled?: () => void` (fires when detect/poll reports installed), matching the sibling components.
- Create `src/components/setup/setup-wizard.tsx` (orchestrator) + per-step components: `step-environment.tsx`, `step-ffmpeg.tsx`, `step-models.tsx`, `step-defaults.tsx`, `step-finish.tsx`. + tests.
- Modify `src/views/setup.tsx` — `SetupView` renders `<SetupWizard readiness={...} onRefetch={...} />` instead of the stub list.
- Modify `src/routes/index.tsx` — `SetupRoute` exposes a `refetch` (re-calls `api.getSetupReadiness`) passed to `SetupView`, and reads `completedAt` to pick guided vs checklist mode.
- Modify `src/views/account.tsx` — add a "Re-run setup" pointer card → `dispatch(uiActions.openSetup())`.
- Create `e2e/setup-wizard.spec.ts` + extend `e2e/responsive/coverage.spec.ts`.

---

## Task C1: `POST /api/setup/complete` route

**Files:** Modify `server/src/routes/setup-readiness.ts` (add the POST handler to the same `setupReadinessRouter` — already mounted at `/api/setup`, so `POST /complete` → `/api/setup/complete`); Test: extend the EXISTING slow-pool route test `server/src/routes/setup-readiness.route.test.ts` (created in Wave 0, already pinned in both vitest configs) — NOT the pure `setup-readiness.test.ts`. A supertest mount belongs in the slow pool per the documented mirror invariant.

- [ ] **Step 1: Failing test** — POST `/api/setup/complete` returns 200 `{ completedAt: <ISO string> }` and calls the settings writer. Inject/stub `writeSetupCompletedAt` if the route imports it directly (mirror how setup-readiness injects deps), else use a temp settings file + assert `getResolvedSetupCompletedAt()` is non-null after.

```ts
// in a describe that mounts setupReadinessRouter on express + supertest
it('POST /complete stamps setupCompletedAt and returns it', async () => {
  const res = await request(app).post('/api/setup/complete');
  expect(res.status).toBe(200);
  expect(typeof res.body.completedAt).toBe('string');
  expect(new Date(res.body.completedAt).toISOString()).toBe(res.body.completedAt);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in `setup-readiness.ts`: add
```ts
import { writeSetupCompletedAt } from '../workspace/user-settings.js';
setupReadinessRouter.post('/complete', async (_req, res) => {
  const ts = new Date().toISOString();
  await writeSetupCompletedAt(ts);
  res.json({ completedAt: ts });
});
```
(Confirm `writeSetupCompletedAt` is exported from `user-settings.ts` — it is, from Wave 0.)
- [ ] **Step 4: Run → PASS + typecheck.** (If the test triggers the live-probe-heavy file, keep this POST test in the fast pool — it doesn't call buildDiagnostics.)
- [ ] **Step 5: Commit** `feat(server): POST /api/setup/complete stamps setupCompletedAt (fs-21 wave 2)`.

---

## Task C2: `api.completeSetup` client + mock

**Files:** Modify `src/lib/api.ts`; extend `src/lib/api.test.ts`.

- [ ] **Step 1: Failing test** — `mockCompleteSetup()` resolves `{ completedAt: <string> }` (test the exported mock directly, like `mockGetSetupReadiness`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** near `realGetSetupReadiness`: `realCompleteSetup()` → `POST /api/setup/complete`; `export async function mockCompleteSetup(): Promise<{ completedAt: string }> { return { completedAt: '2026-06-12T00:00:00.000Z' }; }`. Wire `completeSetup` into BOTH the real and mock `api` maps (next to `getSetupReadiness`).
- [ ] **Step 4: Run → PASS + typecheck.**
- [ ] **Step 5: Commit** `feat(frontend): api.completeSetup (fs-21 wave 2)`.

---

## Task C3: `OllamaInstall` gains `onInstalled`

**Files:** Modify `src/components/ollama-install.tsx`; extend its test (create `src/components/ollama-install.test.tsx` if absent).

- [ ] **Step 1: READ `src/components/ollama-install.tsx`** + a sibling (`kokoro-install.tsx`) for the `onInstalled` pattern. **Failing test:** `OllamaInstall` calls `onInstalled` when its detect/poll reports installed (mock fetch).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — add `{ onInstalled }: { onInstalled?: () => void } = {}` to the signature; call `onInstalled?.()` at the same point the sibling components do (when status flips to installed / detect reports installed). Keep all existing behavior — purely additive. Existing call sites (Model Manager / ModelSettingsForm) pass no prop → unaffected.
- [ ] **Step 4: Run → PASS + typecheck** (incl. the existing Model Manager tests still green).
- [ ] **Step 5: Commit** `feat(frontend): OllamaInstall onInstalled callback (fs-21 wave 2)`.

---

## Task C4: Step sub-components

**Files:** Create `src/components/setup/step-environment.tsx`, `step-ffmpeg.tsx`, `step-models.tsx`, `step-defaults.tsx`, `step-finish.tsx` + a test per non-trivial one.

Each step component takes `{ readiness: SetupReadiness; onRefetch: () => void }` (and `step-finish` also `{ onFinish: () => void }`). They are presentational + reuse existing components. **Dispatch as THREE separate subagent tasks** (per the per-group commits): C4a = Step E + Step F; C4b = Step M; C4c = Step D + Step Finish. (One task for all five is too large.)

- [ ] **Step E (environment):** `StepEnvironment` renders `<DevicePanel />` + a line showing `readiness.info.gpu`. Non-blocking; always "ok". Test: renders DevicePanel + the gpu string.
- [ ] **Step F (ffmpeg):** `StepFfmpeg` — if `readiness.blockers.ffmpeg === 'pass'` → green "ffmpeg found"; else → an instruct card with per-OS commands (`winget install ffmpeg` / `brew install ffmpeg` / `sudo apt install ffmpeg`) + a "Re-check" button calling `onRefetch`. (Mirror `venv-bootstrap.tsx`'s degrade/instruction block style.) Test: pass → green; fail → instructions + Re-check calls onRefetch.
- [ ] **Step M (models):** `StepModels` — two required sub-sections:
  - *TTS runtime + engine:* `<VenvBootstrap onBootstrapped={onRefetch} />` then `<KokoroInstall onInstalled={onRefetch} />` (with Qwen/Coqui offered as collapsible alternates). Show `readiness.blockers.tts`/`sidecar` status.
  - *Analyzer:* recommended `<GeminiKeyField status={account.apiKeyStatus} onSave={(k)=>dispatch(saveGeminiApiKey(k)).then(onRefetch)} />`; OR (collapsible "use a local analyzer") `<OllamaInstall onInstalled={onRefetch} />`. **DROP `ModelPullStatus`** (the review found its props need the inline-only `PULLABLE_MODELS` const + a parallel ollama-health probe; the `analyzer` blocker passes on a Gemini key OR Ollama-daemon-reachable, so pulling a specific tag isn't needed to clear the gate — leave model-pull to the Model Manager). Show `readiness.blockers.analyzer` status.
  Test: renders the venv + kokoro + analyzer sub-sections; install callbacks call onRefetch (mock the children or assert presence).
- [ ] **Step D (defaults):** `StepDefaults` — a 4-field inline form: default engine (`defaultTtsEngine`), default TTS model key (`defaultTtsModelKey`), default analysis model (`defaultAnalysisModel`), theme (`defaultThemePreference`). Pre-fill from the account slice; on change build a `UserSettingsPatch` and `dispatch(saveAccountSettings(patch))`. Skippable (auto-picks valid). **Field provenance (review):** engine/model option lists + the engine→model reset idiom come from `src/lib/tts-models.ts` (`TTS_ENGINES`) and are used in `src/components/model-settings-form.tsx`; analysis-model options from `MODEL_OPTION_GROUPS` in `src/lib/models.ts`; **`defaultThemePreference` is managed in `src/views/account.tsx` (a `'light'|'dark'|'system'` `ThemePreference`), NOT in model-settings-form** — read account.tsx for that one. When the user actively changes the TTS model, also send `defaultTtsModelKeyExplicit: true` (mirrors model-settings-form so a Qwen-installed box isn't silently pinned). Inline only these 4 fields (do not embed the whole form). Test: renders 4 selects, changing one dispatches saveAccountSettings with that field.
- [ ] **Step Fin (finish):** `StepFinish` — a placeholder card: "Smoke test (coming soon)" disabled affordance + copy that the full audible end-to-end test arrives next release; a **"Finish setup"** PrimaryButton calling `onFinish`. Test: renders the placeholder + Finish calls onFinish.
- [ ] **Commit per logical group** (e.g. one commit for steps E+F, one for M, one for D+Fin) with `feat(frontend): setup wizard step components (fs-21 wave 2)`. Run `npx vitest run src/components/setup/` green + typecheck before each commit.

---

## Task C5: `SetupWizard` orchestrator + `SetupView` rewrite

**Files:** Create `src/components/setup/setup-wizard.tsx` + test; modify `src/views/setup.tsx` AND `src/views/setup.test.tsx` (the Wave 0 stub test — widening `SetupView`'s props breaks it; update it to the wizard-era assertion, OR make the new props optional with defaults so it still compiles, then update its body assertion off the removed stub list).

- [ ] **Step 1: Failing test** for `SetupWizard` — props `{ readiness: SetupReadiness; mode: 'guided' | 'checklist'; onRefetch: () => void; onFinish: () => void }`:
  - guided mode: shows ONE step at a time with Back/Next + progress dots. **Next is ALWAYS enabled (simpler model, per review)** — the wizard does NOT gate Next on blocker status; the derived Wave 0 boot gate (`layout.tsx`) already keeps the app locked behind `#/setup` until all blockers pass, so in-wizard gating is redundant and bug-prone (stale-readiness traps). Each blocking step still SHOWS its `readiness.blockers` status so the user knows what's left.
  - checklist mode: all 5 steps rendered stacked, each with its status; no Back/Next.
  - both: blocker statuses come from `readiness.blockers`; `info`/defaults steps are informational.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the orchestrator: a `STEPS` array (id, title, component, `blocking: boolean`), step index state (guided), render the matching step(s), wire `onRefetch`/`onFinish` down. Use `MixedHeading`/`PrimaryButton`/`SectionLabel` primitives + the `max-w-[960px] mx-auto px-4 sm:px-6 py-10` shell (match ModelManagerView). Then rewrite `src/views/setup.tsx` `SetupView` to render `<SetupWizard readiness={readiness} mode={mode} onRefetch={onRefetch} onFinish={onFinish} />` (props threaded from SetupRoute in C6). Keep `SetupView`'s `readiness: SetupReadiness | null` prop; render a light "checking…" state when null.
- [ ] **Step 4: Run → PASS + typecheck.**
- [ ] **Step 5: Commit** `feat(frontend): SetupWizard orchestrator + SetupView rewrite (fs-21 wave 2)`.

---

## Task C6: `SetupRoute` re-fetch + mode + Account entry

**Files:** Modify `src/routes/index.tsx`, `src/views/account.tsx`.

- [ ] **Step 1:** In `SetupRoute`: keep the initial `getSetupReadiness` fetch; add a `refetch()` (re-calls it + setReadiness) passed as `onRefetch`; derive `mode = readiness?.completedAt ? 'checklist' : 'guided'`; `onFinish = async () => { await api.completeSetup(); navigate('/'); }`. Pass `mode`/`onRefetch`/`onFinish` to `SetupView` (widen `SetupView` props accordingly — coordinate with C5's prop list).
- [ ] **Step 2:** In `src/views/account.tsx`, add a "Re-run setup" pointer card mirroring the "Open Model Manager →" button (lines ~445-452): `onClick={() => dispatch(uiActions.openSetup())}`, `data-testid="account-rerun-setup"`. Extend `src/views/account.test.tsx` to assert the button dispatches `openSetup` (mirror the model-manager-pointer test).
- [ ] **Step 3:** `npm run typecheck` + `npx vitest run src/views/account.test.tsx src/routes` green.
- [ ] **Step 4: Commit** `feat(frontend): setup re-fetch + guided/checklist mode + Account re-run entry (fs-21 wave 2)`.

---

## Task C7: e2e

**Files:** Create `e2e/setup-wizard.spec.ts`; extend `e2e/responsive/coverage.spec.ts`.

- [ ] **Step 1:** `setup-wizard.spec.ts` (mock mode): navigate `/#/?setup=notready` → the wizard renders with step UI (heading "Set up Castwright", step navigation visible); assert the ffmpeg/models steps show status from the mock readiness (tts/analyzer `fail` → "needs attention"-style status text). Do NOT assert Next-gating (the simpler model always allows Next). Then a ready-mock path: navigate `/#/` (ready) → no redirect (gate stays out). Keep assertions resilient (role/text), not pixel.
- [ ] **Step 2:** Update the `e2e/responsive/coverage.spec.ts` setup case if the heading/layout changed (it shouldn't — heading stays "Set up Castwright").
- [ ] **Step 3:** `npm run test:e2e -- setup` → PASS.
- [ ] **Step 4: Commit** `test(e2e): setup wizard step flow (fs-21 wave 2)`.

---

## Task C8: Full verify + draft PR

- [ ] **Step 1:** `npm run verify` green (cache-aware retry for the `test:server` contention flake).
- [ ] **Step 2:** `gh pr create --draft --title "feat(server,frontend): fs-21 wave 2 — first-run wizard UI" --body "... Refs #474. Step 5 audible smoke test lands in Wave 3 (here it's a placeholder + the /api/setup/complete route)."` → `gh pr ready` once green.

---

## Self-Review
- 5-step coverage: env (DevicePanel) / ffmpeg (instruct) / models (compose installers) / defaults (4-field) / finish (placeholder + complete route). Guided vs checklist via `completedAt`. Hard gate stays derived (Wave 0 untouched).
- **Open questions for the adversarial review:** (1) confirm `OllamaInstall`'s current internal state machine has a clean point to fire `onInstalled` (or whether polling readiness is safer); (2) confirm `ModelPullStatus`'s exact props (the Explore gave `health` + `pullableModels` — verify before Step M wires it, or drop the model-pull sub-step to keep Step M to engine+key); (3) confirm the `saveAccountSettings` patch field names + option lists in `model-settings-form.tsx` for the 4 defaults; (4) does widening `SetupView`'s props break the Wave 0 `setup.test.tsx`? (update it); (5) is the guided-mode "Next gated on blocking step" logic worth the complexity, or should guided mode simply always allow Next and rely on the derived gate to keep the app locked until blockers pass? (simpler); (6) Step M is large — should it split into Step-TTS + Step-Analyzer for clarity?
