# Setup checker — defense-in-depth diagnosis

_Design spec — 2026-07-03_

## Problem

The Setup Castwright checker and the top-bar Status popover both collapse real, multi-cause failures down to a flat `pass`/`fail` with no pathway for the user to actually fix anything. A live incident triggered this spec: the sidecar's `.venv` was empty (interrupted install), which cascaded into "Voice engine not running" with a bare Retry button — Retry just re-fires the Load handler, which cannot succeed against a missing venv, so the user has no way to learn what's actually wrong or what to do about it. The same flattening hides at least one real bug: when the sidecar supervisor exhausts its respawn budget after repeated crashes ("giving up respawn... restart the server to recover" — visible only in server logs), `POST /api/sidecar/restart` falls through to a generic 409 claiming "the supervisor will spawn one shortly," which is false — nothing will happen automatically, and the route has no way to actually recover that state today.

## Current state (verified against the codebase)

- `server/src/routes/setup-readiness.ts` (`buildSetupReadiness`) computes four blockers — `sidecar`, `ffmpeg`, `tts`, `analyzer` — each a bare `'pass' | 'fail'`, discarding all the cause information the underlying probes already have.
- `server/src/routes/diagnostics.ts` (`buildDiagnostics`) already computes rich per-check `detail` strings (e.g. `"reachable · kokoro package not importable — repair in Model Manager"`, `"GEMINI_API_KEY not set"`) but only surfaces them in the Admin console (`src/views/admin.tsx`) — not in the Setup checker or the Status popover.
- `src/components/setup/setup-wizard.tsx` (`buildSummaryRows`) and `src/components/setup/step-models.tsx` are "the checker" from the user's screenshot — both key off the flat `blockers.X === 'pass'` boolean and render static per-area labels ("Runtime needed" / "Voice needed"), with no per-cause remediation.
- The bespoke install widgets (`src/components/venv-bootstrap.tsx`, `qwen-install.tsx`, `kokoro-install.tsx`, `coqui-install.tsx`) already do reasonable specific-cause UI on their own, each via independent `/detect` + job-polling endpoints. They are not the problem this spec addresses and are largely left alone.
- `src/components/status-popover.tsx` renders a "Voice engines" section (`ttsControls`, built in `layout.tsx` from `ModelControlPill`), an "Analysis" section, "Design", "Generation", "Revisions" — no section reflects the ffmpeg or analyzer setup blockers at all today.
- `src/components/ModelControlPill.tsx`'s `unreachable` state shows a generic `unreachableLabel` + a "Retry" button that just re-fires the Load handler (`labelFor` / action table, `ModelControlPill.tsx:100-136`). It has no notion of *why* the model is unreachable.
- `server/src/tts/sidecar-supervisor.ts`: `onChildExit` (line 292) has two distinct give-up paths — the code-43 streak trip (`restart43Trip`, recoverable only via `clearTripAndRespawn()`) and the plain `consecutiveFailures > maxConsecutiveFailures` exhaustion (line 325-331, sets no flag, just stops respawning). Only the first is queryable (`tripEvent()`) or recoverable in-process.
- `server/src/routes/sidecar-health.ts`'s `POST /restart` (line 425) has three branches when `getActiveSupervisor()` exists but `current()` is null: tripped (honest, unrecoverable-via-this-route message), and a fallback branch (line 452) that assumes "autoStart off or booting" and claims a respawn is coming — which is also hit by the plain-exhaustion case, where that claim is false.
- `server/src/routes/qwen-install-detect.ts` (`detectQwenInstallStateOnDisk`) already distinguishes `not-installed` (package missing from venv) / `weights-missing` / `ready` — confirmed today's incident's Qwen weights (`0.6B-Base`, `1.7B-Base`, `1.7B-VoiceDesign`) were already present in the HF cache; the empty venv made `qwenPackageInstalled` report `false`, so the UI showed "not installed" despite the weights being there. This distinction already exists on disk; it just wasn't surfaced in the checker.
- `server/src/routes/ollama-health.ts` already exposes actionable job endpoints: `POST /api/ollama/install` (vendor installer) and `POST /api/ollama/pull` (pull a model tag) — both real, working, in-app recovery actions with no new server work needed to wire into this feature.

## Decisions

Resolved interactively during brainstorming:

1. **Both surfaces, one diagnosis engine.** The Setup checker (onboarding) and the Status popover (mid-session drift/breakage) both consume one shared server-computed diagnosis — not two independently-derived UIs that can disagree.
2. **All four blockers get the full layered/cause-chain treatment** — sidecar, tts, ffmpeg, and analyzer all get an ordered cause chain rather than reserving multi-cause diagnosis for sidecar/tts only.
3. **Actionable where a safe automated fix exists; text-only guidance otherwise.** Each cause gets a real action button when one exists (reusing an existing endpoint, or the new supervisor-reset capability below); falls back to a text remediation line when nothing safe can be automated in-app (e.g. ffmpeg not on PATH).
4. **The sidecar-supervisor exhaustion gap is fixed as part of this feature, not deferred.** A merged `resetAndRespawn()` serves both the existing code-43 trip recovery and the new plain-exhaustion recovery — one function, not two near-duplicates — because the whole point of this feature is that "Retry"-shaped actions actually work.
5. **The Status popover's diagnosis blocks cover all four blockers**, not just sidecar/tts: sidecar/tts under the existing "Voice engines" section, analyzer under the existing "Analysis" section, and ffmpeg — which has no existing section to attach to — as a small banner at the top of the popover, shown only when the ffmpeg blocker fails.

## Design

### 1. Data model & cause taxonomy

Replace `BlockerStatus` (`'pass' | 'fail'`) with a structured diagnosis:

```ts
export type BlockerActionKind =
  | 'venv-bootstrap' | 'qwen-install' | 'kokoro-install' | 'coqui-install'
  | 'sidecar-restart' | 'ollama-install' | 'ollama-pull' | 'recheck' | 'navigate';

export interface BlockerAction {
  kind: BlockerActionKind;
  label: string;
  /** Extra data an action needs beyond its kind, e.g. { model: 'qwen3.5:9b' } for ollama-pull. */
  params?: Record<string, string>;
  /** For 'navigate' only — an in-app route (e.g. Advanced Settings). */
  href?: string;
}

export interface BlockerDiagnosis {
  status: 'pass' | 'fail';
  /** Stable cause id — the first matching layer in the chain below. */
  cause: string;
  message: string;
  remediation: string;
  /** Present when a safe automated fix exists; absent for text-only guidance.
      Every diagnosis (pass or fail) additionally supports a generic re-probe,
      handled by the frontend as an implicit 'recheck' — not listed per-cause below. */
  action?: BlockerAction;
}

export interface SetupReadiness {
  ready: boolean;
  completedAt: string | null;
  blockers: Record<'sidecar' | 'ffmpeg' | 'tts' | 'analyzer', BlockerDiagnosis>;
  info: { gpu: string };
}
```

Ordered cause chains (first matching layer wins; layers below a matched one are not evaluated):

- **sidecar**: `python-missing` (no Python 3.12 found — `findPython312()` returns null) → `venv-missing` (`!sidecarVenvPresent()`) → `supervisor-exhausted` (new — plain `consecutiveFailures` give-up) → `supervisor-tripped` (existing code-43 `tripEvent()`) → `unreachable-transient` (booting / autoStart off / genuinely-not-yet-reachable, no actionable cause) → `pass`.
- **tts**: `no-engine-installed` (`!anyTtsEnginePresent`) → `weights-missing` (an installed engine's `detectQwenInstallStateOnDisk`-style probe reports weights missing) → `package-broken` (sidecar-confirmed `kokoroPackageInstalled`/`qwenPackageInstalled === false`, reusing the exact signal `diagnostics.ts`'s `sidecar` check already computes) → `pass`.
- **ffmpeg**: `ffmpeg-missing` / `ffprobe-missing` / `both-missing` (from the existing `probeFfmpeg()`) → `pass`.
- **analyzer**: (local engine) `ollama-unreachable` → `model-not-pulled` → (gemini engine) `no-gemini-key` → `pass`.

Action mapping per cause (others are text-only remediation, no `action` field):

| Cause | Action kind | Notes |
|---|---|---|
| `venv-missing` | `venv-bootstrap` | Reuses existing `POST /api/setup/venv/bootstrap` job — no new server work. |
| `python-missing` | none (text) | Nothing safe to auto-install; remediation text points at `node server/tts-sidecar/scripts/ensure-python312.mjs` (existing `NO_PYTHON_INSTRUCTIONS` copy in `venv-bootstrap.ts`). |
| `supervisor-exhausted` | `sidecar-restart` | New: calls the merged `resetAndRespawn()` via `POST /api/sidecar/restart`'s new branch (Design §2). |
| `supervisor-tripped` | `sidecar-restart` | Same route/action kind — the merged `resetAndRespawn()` now also clears this case (already existed as `clearTripAndRespawn`, just not reachable from this route before). |
| `no-engine-installed` | `kokoro-install` | Kokoro is the always-available fallback — reuses its existing install job. |
| `weights-missing` | `qwen-install` or `coqui-install` | Whichever engine reported weights-missing; reuses its existing install job. |
| `package-broken` | none (text) | "Repair in Model Manager" — matches the existing `diagnostics.ts` copy; no new one-click repair exists today. |
| `ffmpeg-missing` / `ffprobe-missing` / `both-missing` | none (text) | Nothing in-app can safely install/PATH-edit these. |
| `ollama-unreachable` | `ollama-install` | Reuses existing `POST /api/ollama/install`. |
| `model-not-pulled` | `ollama-pull` | Reuses existing `POST /api/ollama/pull`, `params: { model: expectedModel }`. |
| `no-gemini-key` | `navigate` | Links to Advanced Settings' Gemini key field; nothing safe to automate (entering a secret). |

Every blocker, pass or fail, also gets an implicit `recheck` action in the UI (re-fetch `/api/setup/readiness`) — not modeled as a per-cause `action`, just a standing control the frontend always renders.

### 2. Server changes

New module `server/src/routes/setup-diagnosis.ts` (thin, mirrors `setup-readiness.ts`'s existing style): exports `diagnoseSidecar()`, `diagnoseTts()`, `diagnoseFfmpeg()`, `diagnoseAnalyzer()`, each walking its cause chain against the existing probes named above plus one new one (supervisor exhaustion, below). `diagnoseSidecar()` reads the `supervisor-exhausted`/`supervisor-tripped` layers via `getActiveSupervisor()?.exhaustedEvent()` / `.tripEvent()` (both already module-exported from `sidecar-supervisor.ts`); when there is no active supervisor (autoStart off) neither layer can match and the chain falls through to `unreachable-transient`. `buildSetupReadiness` in `setup-readiness.ts` calls these instead of the current boolean `checkOk` folding; `GET /api/setup/readiness` becomes the single endpoint polled by both the Setup checker and the Status popover.

**Sidecar-supervisor exhaustion fix** (`sidecar-supervisor.ts`):
- Add `exhaustedEvent(): boolean` on the `SidecarSupervisor` interface — true once `consecutiveFailures > maxConsecutiveFailures` and no respawn is pending, cleared by recovery.
- Merge `clearTripAndRespawn()` into a single `resetAndRespawn()` that resets **both** `restart43Trip`/`restart43Timestamps` (existing) **and** `consecutiveFailures` (new), then calls `spawnOnce()`. Keeps the existing "safe to call when not tripped" idempotency guarantee for the exhaustion case too. All existing call sites of `clearTripAndRespawn` (Plan 2's auto-revert route) are updated to call `resetAndRespawn()`.

**`POST /api/sidecar/restart`** (`sidecar-health.ts:425`): the branch at line 452 (today's misleading "will spawn shortly" for a null-current, non-tripped supervisor) splits into: tripped → existing message, unchanged; **exhausted → calls `resetAndRespawn()` and polls `/health` the same way the normal restart path already does**, returning `{ ok: true }` on recovery; neither → existing generic "autoStart off or booting" message, unchanged.

### 3. Frontend changes

- `setup-wizard.tsx` (`buildSummaryRows`): reads `blockers.X.status` (was `blockers.X === 'pass'`) and shows `blockers.X.message` as the detail line instead of the current hardcoded per-area strings.
- `step-models.tsx`: badges take `blockers.sidecar.status` / `.message`, gain a remediation line + (when present) a fix-action button directly under each badge. This is the direct fix for the screenshot's flat "Runtime needed."
- New shared `useSetupDiagnosis()` hook: polls `GET /api/setup/readiness` (same interval the popover already uses for `ttsControls`), returns the typed `SetupReadiness`. Both the Setup wizard and the Status popover use it — no duplicated polling/parsing logic.
- New `<BlockerFixAction diagnosis={BlockerDiagnosis} onDone={() => void}>` component: maps `action.kind` to its mutation (`venv-bootstrap`/`qwen-install`/`kokoro-install`/`coqui-install`/`ollama-install`/`ollama-pull` → their respective existing job-start endpoints, polling to completion; `sidecar-restart` → `POST /api/sidecar/restart`; `recheck` → refetch readiness; `navigate` → an in-app link). Owns its own loading/error state so callers don't hand-roll button wiring. On completion (success or error) it calls `onDone`, which triggers a `useSetupDiagnosis()` refetch — never trusts the diagnosis it was rendered from as still current (race safety, Design §4).
- `status-popover.tsx`: renders the sidecar/tts diagnosis under "Voice engines" (only when failing), the analyzer diagnosis under "Analysis" (only when failing), and a new top-of-panel ffmpeg banner (only when failing). `ModelControlPill.tsx` itself is untouched — the diagnosis renders as a separate block alongside `ttsControls`, so none of its other call sites (analyzer pills in `generation.tsx`/`layout.tsx`) are affected.

### 4. Error handling & edge cases

- **Stale diagnosis after a fix action.** `BlockerFixAction` always triggers a `useSetupDiagnosis()` refetch after its mutation settles rather than trusting the diagnosis object it was rendered from — covers both "the fix worked" and "something else changed the state while the action was in flight."
- **Action failure.** Surfaced inline via the job's existing `{status: 'error', error}` shape (`VenvBootstrap`, `QwenInstallBootstrap`, the Ollama bootstraps) — no new error-handling pattern needed.
- **`resetAndRespawn()` called when nothing is wrong** (double-click, or the sidecar already self-recovered). Must remain a safe no-op-then-respawn, matching the existing `clearTripAndRespawn` doc comment ("safe to call when not tripped").
- **Diagnosis computed mid-transition** (backoff window between respawn attempts). `unreachable-transient` is the deliberate catch-all so an ordinary backoff-and-retry never flashes a "click to fix" action for a state about to resolve itself in a couple seconds.
- **Polling cost.** `/api/setup/readiness` is now polled by the popover in addition to the wizard. Every underlying probe is already cheap (filesystem existence checks, or the one `/health` fetch `diagnostics.ts`'s `sidecar` check already reuses) — no new caching/debouncing needed beyond whatever interval the popover already polls `ttsControls` at.

## Out of scope

- Changing `ModelControlPill.tsx`'s own `unreachable` state/props — the diagnosis renders as an adjacent block, not a change to that shared component's contract.
- A one-click fix for `package-broken` (package not importable in an otherwise-present venv) — stays text-only ("repair in Model Manager"); building an automated repair for that state is a separate, larger piece of work.
- Any change to the Admin console (`src/views/admin.tsx`) — it already surfaces `diagnostics.ts`'s technical detail directly and is unaffected by this spec.
- A one-click fix for `ffmpeg-missing`/`ffprobe-missing` or `no-gemini-key` — neither has a safe in-app automation (PATH editing, secret entry), so both stay text-only by design (Decision 3), not as a deferred gap.

## Test plan

**Unit (Vitest, server):**
- `setup-diagnosis.test.ts` — one case per cause per blocker; a case asserting first-match-wins when multiple layers are simultaneously true (e.g. `python-missing` AND `venv-missing` both true → reports `python-missing`).
- `sidecar-supervisor.test.ts` — new cases for `exhaustedEvent()` and the merged `resetAndRespawn()` covering both the code-43-trip and plain-exhaustion paths, plus the not-tripped/not-exhausted no-op case.
- `sidecar-health.test.ts` — new case for `/restart`'s exhausted branch (calls `resetAndRespawn`, polls health, returns `{ok:true}`).

**Unit (Vitest, frontend):**
- `setup-wizard.test.tsx` / `step-models.test.tsx` — extend existing `notReadyReadiness`/`readyReadiness` fixtures to the new `BlockerDiagnosis` shape; assert message/remediation/action render per cause.
- `status-popover.test.tsx` — new cases per diagnosis block (sidecar/tts/analyzer/ffmpeg) appearing only when failing.
- `BlockerFixAction.test.tsx` — one case per `action.kind` mapping to its mutation; error-path rendering; `onDone` fires and triggers a refetch.

**E2E (Playwright, mock mode):**
- `setup-checker-venv-fix.spec.ts` — venv-missing diagnosis → click "Rebuild venv" → mocked job completes → badge flips to pass, end to end.

**Verification commands:**
- `npm run typecheck`
- `cd server && npm run test -- setup-diagnosis.test.ts sidecar-supervisor.test.ts sidecar-health.test.ts`
- `npm run test -- setup-wizard.test.tsx step-models.test.tsx status-popover.test.tsx`
- `npm run test:e2e -- e2e/setup-checker-venv-fix.spec.ts`
- `npm run verify` (full battery)

## Shipping checklist

- New `docs/features/` regression plan + GH issue (`type:feature`, `area:fe`/`area:srv` as applicable).
- `docs/features/INDEX.md` entry.
- `npm run verify` green.
- End-of-turn summary names the user-visible delta (checker shows real causes + working fix buttons) and the locking tests.
