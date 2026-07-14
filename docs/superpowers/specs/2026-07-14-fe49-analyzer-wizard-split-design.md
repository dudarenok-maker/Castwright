# fe-49 — First-run wizard: split analyzer/voice, close the local-Ollama loop, and add a primary/backup analyzer signal

**Issue:** [#1610](https://github.com/dudarenok-maker/Castwright/issues/1610) (`fe-49`, `area:fe`, `moscow:must`, `type:chore`, `feedback`)
**Date:** 2026-07-14
**Status:** draft
**Pairs with:** ops-28 (#1609) and the other 1.14 startup-wizard changes.

## Problem

From beta-user setup feedback (2026-07-14):

1. **The local-analyzer path dead-ends.** Ollama can be installed and detected in
   the wizard, but there's nowhere to pull an analyzer model or make it usable —
   `OllamaInstall` shows "Ollama is installed" and stops (`ollama-install.tsx:138`).
   Users give up or wrongly conclude they still need a Gemini key. Local-only
   setup is not a real guided path.

2. **Voice and analyzer setup are mushed together.** Today's single **Models**
   step stacks the voice/TTS-sidecar section and the analyzer section in one long
   scroll (`step-models.tsx`), and inside the analyzer section the Gemini key is
   the headline while the local option is buried in a collapsible *"Use a local
   analyzer instead"*. Reads as confusing and Gemini-first, contrary to the
   product's local-first stance.

Two further gaps surfaced during design:

3. **Choosing a local model doesn't switch the engine.** The Defaults step's
   analysis-model picker saves `defaultAnalysisModel` only; `analysisEngine` is a
   separate field that `getResolvedAnalysisEngine()` reads directly
   (`user-settings.ts:573`). So picking a local tag there is a silent no-op for
   routing.

4. **Readiness can't express "no backup."** `diagnoseAnalyzer` returns a binary
   pass/fail for the resolved engine (`setup-diagnosis.ts:226`). The product wants
   a primary/backup signal on top of "will it run": green when both a local model
   and a Gemini key are present, yellow (no backup, non-blocking) when only one is.

## Goals

- Present analyzer setup and voice setup as **two distinct wizard steps**, with
  **Analysis first** (it precedes voice generation in the app flow).
- In the analysis step, present **two options** — **Local via Ollama** (first,
  primary) and **Online via Gemini** (second) — as distinct cards; no buried
  "instead" link. Close the Ollama dead-end by reusing the admin Model-Manager
  machinery to **list all pulled models and pull the suggested one**.
- Add a **primary/backup refinement** on top of today's (correct, engine-aware)
  pass/fail: **green** when the resolved analyzer will run AND a second analyzer
  is provisioned as backup; **yellow/non-blocking** when it will run but has no
  backup; **red/blocking** when it won't run (unchanged from today).
- Make choosing a local model in the **Defaults** step actually switch the
  engine, so generation routes to the chosen analyzer.

## Non-goals

- **Setting the analyzer default (active engine) in the analysis step.** Choosing
  which analyzer *runs* is owned by the **Defaults** step's model dropdown. The
  analysis step only makes analyzers *available*.
- **Forcing our recommended model.** Any pulled **analyzer-capable** Ollama model
  counts (see §5) — the suggested tag is a convenience, not a requirement.
- **Reworking `saveGeminiApiKey`.** It stays key-only (`account-slice.ts:63`);
  Gemini availability is read from whether a key is set.
- **Runtime analyzer fallback changes.** The existing local→gemini fallback
  (`user-settings.ts:132-135`) is unchanged; we do NOT add a gemini→local one.
- **Admin-screen disentanglement** — a follow-up (see §7).

## Key correction vs earlier drafts (why the gate stays engine-aware)

An earlier draft made readiness "availability-based, independent of the active
engine." Adversarial review killed that: the client boot gate is
`layout.tsx:529-532`, which force-navigates to `/setup` whenever the server's
`readiness.ready` is false, and `ready` is `every(blocker.status === 'pass')`
(`setup-readiness.ts:104`). Making "one analyzer provisioned" non-blocking
**regardless of engine** would let a user who pulled an Ollama model but left the
engine at its `gemini` default with **no key** (`user-settings.ts:263`) pass the
gate — then fail at generation, because the gemini→local fallback does not exist
(fallback is local→gemini only, `user-settings.ts:132-135`). Today that state is
correctly **blocked**. So: **the pass/fail gate stays engine-aware** (fail = the
resolved engine won't run, including its fallback); the primary/backup green-vs-
yellow distinction is the only new, availability-based layer.

## Design decisions

| Decision | Choice |
|---|---|
| Voice vs analyzer | **Two separate wizard steps.** |
| Step order | **Analysis first, then Voice.** |
| Analyzer options | Two cards; **Ollama first** (local-first), Gemini second. |
| Ollama section content | Render like admin `ModelsCardBody`: `OllamaInstall` + `ModelPullStatus`. |
| "Ollama available" (backup label) | Daemon reachable + **≥1 pulled analyzer-capable model** (curated-family match, not any `/api/tags` entry). |
| Who sets the active engine | The **Defaults step** dropdown, via `':'` auto-derive. |
| Gate (pass/fail) | **Byte-identical to today** — fail iff the *resolved* engine+model won't run (gemini: no key; local: daemon unreachable OR resolved model not pulled). Fallback NOT modeled in the gate (matches today). |
| Green vs yellow | **green** = will run AND a backup analyzer is provisioned; **yellow/`warn`** (non-blocking) = will run, no backup. Adds a `warn` state to `BlockerDiagnosis`. |
| Admin screens | **Follow-up** issue to mirror this design (not shared control). |

## Section 1 — Wizard structure

Split the combined **Models** step (`step-models.tsx`, stepIndex 2) into two and
reorder:

| # | Step | Change |
|---|---|---|
| 0 | Environment | — |
| 1 | ffmpeg | — |
| **2** | **Analysis** | NEW — reworked analyzer half (§2) |
| **3** | **Voice** | NEW — voice-engines half, lifted verbatim |
| 4 | Defaults | engine auto-derive added (§4) |
| 5 | LAN access | — |
| 6 | Finish | — |

Step count 6 → 7.

**Files**
- New `src/components/setup/step-analysis.tsx` (+ `step-analysis.test.tsx`).
- New `src/components/setup/step-voice.tsx` (+ `step-voice.test.tsx`).
- Delete `src/components/setup/step-models.tsx` and `step-models.test.tsx`.

**`setup-wizard.tsx`**
- Extend `StepId` + `STEPS`: replace `models` with `analysis` then `voice`.
- Add `renderStep` cases for `analysis` and `voice` (both `{ readiness, onRefetch }`).
- `buildSummaryRows` (`setup-wizard.tsx:246-296`): the **Analyzer** row moves to
  `stepIndex: 2`, ordered **before** the **Voice engines** row (`stepIndex: 3`);
  `defaults` → `4`, `lanCert` → `5`. Progress dots + "Step N of 7" derive from
  `STEPS.length`. `SummaryStatus` gains `warn` (yellow dot) so the analyzer row
  can render the new state (§5).

**Voice step is a pure lift** — `VenvBootstrap`, `KokoroInstall`, the "More voice
engines" `<details>` (`QwenInstall` + `CoquiInstall`), and the `blockers.sidecar`
/ `blockers.tts` badges.

## Section 2 — The analysis step

Two distinct bordered-card sections, local-first order.

**① Local via Ollama** (first)
- Render **unconditionally, like admin's `ModelsCardBody`** (`model-settings-form.tsx`):
  `OllamaInstall` (unchanged) then `ModelPullStatus` (`model-pull-status.tsx`,
  reused as-is) — it lists pulled tags ∪ curated `pullable[]`, offers **Pull**
  with progress, and shows its own amber "daemon unreachable" banner. We do not
  gate its render on `OllamaInstall`'s detect state (which it doesn't expose).
- Wiring: fetch `api.getOllamaHealth()` for the `health` prop; read
  `account.pullableModels` (dispatch `fetchAnalyzerModels` on mount). On a
  terminal pull, `onPulled` → `onRefetch` **and** re-dispatch `fetchAnalyzerModels`
  so the tag reaches the Defaults dropdown.
- **No set-as-default action here.** Once an analyzer-capable model is pulled,
  show a bridge line: *"✓ Local analyzer available — pick it in the Defaults step
  to use it."* (Provisioning ≠ activation; see below.)

**② Online via Gemini** (second)
- `GeminiKeyField` → `saveGeminiApiKey` + `onRefetch` (unchanged), as the second card.

**Badge behavior (honest, engine-aware).** The step shows the analyzer
`BlockerBadge` at the top with the tri-state (§5), rendered **message-only, no
`BlockerFixAction`** here (remedies are the two cards below; the old fix action
navigates to `#/advanced`, out of the wizard — `setup-diagnosis.ts:233`).

Because the gate is engine-aware, the badge is honest about *what will run*, and
the two provisioning actions do **not** move it symmetrically:
- Default engine is `gemini`, so **saving a Gemini key flips the badge in-step**
  (gemini becomes usable immediately).
- **Pulling an Ollama model does not, on its own**, turn the badge green/yellow
  unless the user also makes local the engine (Defaults) OR already has a Gemini
  key (then Ollama is the *backup* → green). Until then the Ollama card's bridge
  line points the user to Defaults. This asymmetry is inherent to "Defaults owns
  the active engine" and is the honest behavior — the badge never claims an
  analyzer is ready when the resolved engine can't run it.

## Section 3 — Reused components (no new picker)

- `ModelPullStatus` (`src/components/model-pull-status.tsx`) — pure UI, no redux;
  `{ health, pullableModels, onPulled }`. Owns pull + progress + "Refresh".
- `OllamaInstall` (`src/components/ollama-install.tsx`) — unchanged.
- `api.getOllamaHealth()` → `GET /api/ollama/health` (`models[]`, `pullable[]`,
  `expectedModel`, `modelPulled`).
- `fetchAnalyzerModels` (`account-slice.ts:74`) → `localAnalyzerModels` +
  `pullableModels`.

We do **not** lift `ModelsCardBody` into a shared component; the analysis step
composes the leaf controls directly (a shared wrapper can come with the admin
follow-up).

## Section 4 — Defaults step: engine auto-derive (routing)

`step-defaults.tsx`'s `handleAnalysisModelChange` saves `defaultAnalysisModel`
only. Change it to also save an auto-derived `analysisEngine`:

```
const engine = next.includes(':') ? 'local' : 'gemini';
dispatch(saveAccountSettings({ defaultAnalysisModel: next, analysisEngine: engine }));
```

`':'` matches the exact heuristic `getResolvedOllamaModel()` uses
(`user-settings.ts:566`). This is what routes generation to the chosen analyzer.
The derive fires only on a change event, so a pre-existing mismatched
`analysisEngine`/`defaultAnalysisModel` pair self-heals only when the user
re-selects — acceptable for v1.

## Section 5 — Primary/backup analyzer signal (server leg)

**Extend, don't replace, today's engine-aware `diagnoseAnalyzer`.** The current
pass/fail logic (`setup-diagnosis.ts:226-258`) is correct and stays; we add a
`warn` refinement and feed it both engines' availability.

**Tri-state.** Extend `BlockerDiagnosis.status` from `'pass' | 'fail'` to
`'pass' | 'warn' | 'fail'`. **The type is hand-written in TWO places** — the
client `src/lib/api.ts:7129` and the server's diagnosis type — updated in
lockstep (NOT generated from `openapi.yaml`).

**`diagnoseAnalyzer` logic — `warn` is a pure additive label over today's PASS
set; the pass/fail gate is byte-identical to today (never more lenient).** This
matters: `FallbackAnalyzer` (`index.ts:235-249`) falls back to Gemini **only** on
`LocalUnreachableError` (daemon unreachable) — a reachable daemon missing the
resolved model hard-fails. So the gate must **not** credit the Gemini key as
rescuing local, and today's `diagnoseAnalyzer` (`setup-diagnosis.ts:238-256`)
correctly doesn't. We keep that.

Inputs: `engine`, `geminiKeySet`, `ollamaReachable`, `resolvedModelPulled`,
`anyAnalyzerModelPulled`, `expectedModel`, `pullable`. Two distinct ollama facts:
- **`resolvedModelPulled`** — is `getResolvedOllamaModel()` pulled? (today's
  `ollama.modelPulled`; drives the **gate**, model-specific).
- **`anyAnalyzerModelPulled`** — is *any* analyzer-capable tag pulled? (a pulled
  tag prefix-matching the curated catalog `pullable` ∪ known local `MODEL_OPTIONS`
  via the existing `isPrefixMatch`; **not** bare `models.length > 0`, so an
  embedding-only install like `nomic-embed-text` doesn't count; drives only the
  **backup label**).

Gate (`activeUsable`) — **exactly today's pass condition**, engine-aware,
resolved-model-specific, fallback NOT modeled:
- `engine === 'gemini'` → `geminiKeySet`
- `engine === 'local'`  → `ollamaReachable && resolvedModelPulled`

Backup label (only splits green vs yellow — never gates):
- `geminiBackup = geminiKeySet`
- `localBackup  = ollamaReachable && anyAnalyzerModelPulled`

Then:
- `!activeUsable` → **`fail`** (blocking) — **byte-identical to today's branch and
  remedies** (gemini→no-key; local→`ollama-unreachable`/`model-not-pulled` with the
  `ollama-install`/`ollama-pull` actions). No remedy is dropped, because this
  branch *is* today's.
- `activeUsable && geminiBackup && localBackup` → **`pass`** "Analyzer ready."
- `activeUsable` otherwise → **`warn`** "Analyzer ready — no backup analyzer
  configured." (non-blocking; carries a light navigate remedy for out-of-wizard
  consumers).

(Since `engine==='local'` pass ⇒ `resolvedModelPulled` ⇒ `localBackup`, green for
local reduces to "also has a Gemini key"; for gemini pass, green reduces to "also
has a local analyzer model." Exactly the intended primary/backup semantics.)

**`setup-readiness.ts:194-212`.** Probe **both** unconditionally: compute
`geminiKeySet` from `getResolvedGeminiApiKey()` and always `probeOllamaHealth()`
(needed for the backup determination even when `engine === 'gemini'`); still read
`getResolvedAnalysisEngine()` for the gate. Pass all into `diagnoseAnalyzer`.

**Boot gate.** `buildSetupReadiness` (`setup-readiness.ts:104`):
`ready: Object.values(blockers).every(b => b.status === 'pass')` →
`... every(b => b.status === 'pass' || b.status === 'warn')`. This is the only
gate — the client obeys `readiness.ready` (`layout.tsx:532`), it does not
re-derive.

**Full `warn` consumer surface** (the binary assumption is scattered — the plan
carries a mechanical *"find every `BlockerDiagnosis.status` consumer"* sweep):
- **Type:** `src/lib/api.ts:7129` (client) + server diagnosis type.
- **Mock:** `src/lib/api.ts` `mockBlocker(status: 'pass' | 'fail')` and
  `mockGetSetupReadiness` (computes `ready`; drives e2e + unit; asserted in
  `api.test.ts:45,51`).
- **Badge:** new `step-analysis.tsx` `BlockerBadge` — green/yellow/red.
- **Summary:** `buildSummaryRows` (`setup-wizard.tsx:277-278`) + `SummaryStatus`.
- **`blocker-fix-action.tsx`:** the badge renders it whenever `!isPass`; a `warn`
  must NOT surface a spurious fix button — gate on `status === 'fail'`.
- **`status-popover.tsx:181`** `DiagnosisBlock`: returns null only on `'pass'`;
  give `warn` an explicit (non-alarming) render, not the red problem block.
- **Existing test factories** hard-coding the binary union (`setup.test.tsx`,
  `status-popover.test.tsx`, `layout.test.tsx`, `use-setup-diagnosis.test.ts`,
  `prosody-autotrigger.test.tsx`, `routes/index.test.tsx`) widen to the tri-state.

## Section 6 — Ollama pull path (verify)

Confirmed working: `POST /api/ollama/pull` is allowlist-gated
(`pull-bootstrap.ts:87`); the suggested `expectedModel` resolves to `qwen3.5:4b`,
which is in `DEFAULT_ALLOWED_MODELS` (`pull-bootstrap.ts:64`), so the suggested
pull is offered and permitted.

## Section 7 — Admin screens (follow-up)

`model-settings-form.tsx` / `model-manager.tsx` carry the same voice/analyzer
entanglement, but they are **distinct components** that only reuse the leaf
controls (`OllamaInstall`, `ModelPullStatus`) — **not shared control**. So the
admin disentanglement (and adopting the tri-state badge there) is a separate
follow-up issue to mirror this design once fe-49 lands. File it during shipping +
add the thin `docs/BACKLOG.md` row.

## Testing

- **`step-analysis.test.tsx`** — renders `OllamaInstall` + `ModelPullStatus`;
  pull path lists/pulls (mock **both** `api.getOllamaHealth` and global `fetch` —
  the leaf controls use raw `fetch`); Gemini key saves; bridge line appears when
  an analyzer-capable model is pulled; badge message-only (no fix action).
- **`step-voice.test.tsx`** — voice-engine controls render (lift regression).
- **`setup-wizard.test.tsx`** — 7 steps; "Step N of 7"; summary rows: Analyzer
  before Voice; analyzer row renders the yellow `warn` state.
- **`step-defaults.test.tsx`** — `':'` tag → saves `analysisEngine:'local'`;
  Gemini id → `'gemini'`.
- **`setup-diagnosis.test.ts`** — the full matrix: engine=gemini {no key → fail;
  key only → warn; key + local analyzer model → pass}; engine=local {resolved
  model not pulled → fail; resolved model pulled, no key → warn; resolved model
  pulled + key → pass}; **regression guards:** (a) engine=gemini + no key + Ollama
  model pulled → still `fail`; (b) engine=local + resolved model NOT pulled + key
  set → still `fail` (fallback is unreachable-only, not model-missing) — neither
  may go warn/pass.
- **`setup-readiness` route test** — probes both engines; `ready` true when the
  only non-pass blocker is analyzer `warn`; false on analyzer `fail`.
- **Mock parity** — `mockGetSetupReadiness`/`mockBlocker` learn the tri-state; a
  mock scenario exercises `warn`.
- **e2e** — update `e2e/setup-wizard.spec.ts` for the new order/count; drive the
  Ollama pull path with mocked `GET/POST /api/ollama/*`.

## Acceptance criteria

- [ ] Wizard has separate **Analysis** (step 2) and **Voice** (step 3) steps;
      Analysis first; "Step N of 7"; summary board reordered, analyzer row can
      render yellow.
- [ ] Analysis step shows **Local via Ollama** first and **Online via Gemini**
      second as distinct cards; Ollama section lists pulled models + offers the
      suggested pull — no dead-end; bridge line on a pulled analyzer model.
- [ ] Gemini key set → analyzer badge usable in-step. Ollama model pulled while a
      Gemini key exists → **green** (backup present). Ollama pulled with **no**
      key and engine still `gemini` → **red/blocking** (regression guard).
- [ ] **Gate never more lenient than today:** `engine=local` with the *resolved*
      model not pulled → **red/blocking even when a Gemini key exists** (the
      fallback covers only an unreachable daemon, not a missing model).
- [ ] `activeUsable` (green or yellow) → non-blocking (`ready` true); `fail` →
      blocking (`ready` false). Green vs yellow is a label over today's PASS set,
      not a change to what passes.
- [ ] Defaults: picking a `':'` tag sets `analysisEngine:'local'`; a Gemini id
      sets `'gemini'`.
- [ ] "Ollama available" ignores non-analyzer tags (embedding-only install does
      not read as ready).
- [ ] Voice step is behavior-identical to today's voice section.
- [ ] Paired tests incl. the engine-aware matrix + regression guard; e2e updated.
- [ ] Admin follow-up issue filed + `docs/BACKLOG.md` row added.

## Resolve during planning

- **`ollamaHasAnalyzerModel` predicate** — the exact curated-family match, and
  whether a user-selected non-curated local tag should also satisfy it.
- **`warn` remedy action** for out-of-wizard consumers (status-popover) now that
  the diagnosis carries a `warn` — what it navigates to.
- **Whether the Ollama bridge line** should also offer a shortcut that jumps to
  the Defaults step (vs. plain guidance text).

## Key files

- `src/components/setup/setup-wizard.tsx` (steps, renderStep, summary + `warn`)
- `src/components/setup/step-analysis.tsx` (new), `step-voice.tsx` (new),
  `step-models.tsx` (delete)
- `src/components/setup/step-defaults.tsx` (engine auto-derive)
- `src/components/status-popover.tsx`, `src/components/blocker-fix-action.tsx`
  (tri-state render)
- `src/lib/api.ts` (`BlockerDiagnosis` type + `mockBlocker` + `mockGetSetupReadiness`)
- `server/src/routes/setup-diagnosis.ts` (`diagnoseAnalyzer` + `warn`),
  `server/src/routes/setup-readiness.ts` (probe both + `ready` gate) + server type
- Reuse: `src/components/ollama-install.tsx`, `src/components/model-pull-status.tsx`,
  `src/store/account-slice.ts`

## Ship notes

_(filled at ship time)_
