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

- **sidecar**: venv check — if `!sidecarVenvPresent()`, additionally probe `findPython312()`; report `python-missing` if no interpreter is found, else `venv-missing` — → `supervisor-exhausted` (new — plain `consecutiveFailures` give-up) → `supervisor-tripped` (existing code-43 `tripEvent()`) → `unreachable-transient` (booting / autoStart off / genuinely-not-yet-reachable, no actionable cause) → `pass`. **`python-missing` is deliberately nested inside the venv check, not a standalone first layer evaluated on every poll** — see Design §2 (round-1 adversarial review finding 3: probing for Python is a subprocess spawn via `spawnSync`, not a filesystem stat, and must not run on every poll while the venv is already present and healthy).
- **tts**: **`sidecar-blocked`** (new first layer — fires whenever the just-computed `sidecar` diagnosis for this same request is `status: 'fail'`, for *any* sidecar cause) → `no-engine-installed` (`!anyTtsEnginePresent`) → `weights-missing` (an installed engine's `detectQwenInstallStateOnDisk`-style probe reports weights missing) → `package-broken` (sidecar-confirmed `kokoroPackageInstalled`/`qwenPackageInstalled === false`) → `pass`. **The `sidecar-blocked` gate is load-bearing, not cosmetic** (round-1 review findings 1 & 2, both `Critical`+`Contradicted`): without it, an empty venv makes `anyTtsEnginePresent()` false → tts reports `no-engine-installed` → offers `kokoro-install`, which fails against the same missing venv the sidecar blocker is simultaneously reporting — reproducing the exact dead-end this spec exists to fix. It also closes a false-pass: `kokoroPackageInstalled`/`qwenPackageInstalled` come from the sidecar's live `/health` payload and are `undefined` (not `false`) whenever `sidecar.status !== 'reachable'` (`diagnostics.ts:129-135`), so `package-broken` can never match while the sidecar is down. Gating the whole tts chain behind `sidecar.status === 'pass'` means `package-broken` is only ever evaluated once that signal is a real boolean — closing the false-pass gap by construction instead of adding a second special case for "sidecar down."
- **ffmpeg**: `ffmpeg-missing` / `ffprobe-missing` / `both-missing` (from the existing `probeFfmpeg()`) → `pass`. Independent of the sidecar/venv — ffmpeg is a system binary the Node process shells out to directly — so it needs no `sidecar-blocked`-style gate.
- **analyzer**: (local engine) `ollama-unreachable` → `model-not-pulled` → (gemini engine) `no-gemini-key` → `pass`. Independent of the sidecar (Ollama is a separate daemon) — no gate needed.

**Diagnosis order is fixed, not parallel**: `buildSetupReadiness` must call `diagnoseSidecar()` first and pass its resulting `BlockerDiagnosis` into `diagnoseTts(sidecarDiagnosis)` — the tts chain cannot be computed independently.

**Answering "does it matter whether a missing venv makes the sidecar crash-loop-to-exhaustion or benign-no-op?" (round-1 review question 2): no.** Because `venv-missing`/`python-missing` are checked before any supervisor-state layer in the sidecar chain, a genuinely missing venv is always reported as `venv-missing` regardless of what the supervisor does internally underneath it — the supervisor-state layers are only reached once the venv is confirmed present. The chain's ordering makes the empirical spawn-behavior question operationally moot for diagnosis purposes, so this spec does not need to pin down (or test against) `spawnSidecar`'s exact behavior against a missing venv.

Action mapping per cause (others are text-only remediation, no `action` field):

| Cause | Action kind | Notes |
|---|---|---|
| `venv-missing` | `venv-bootstrap` | Reuses existing `POST /api/setup/venv/bootstrap` job — no new server work. |
| `python-missing` | none (text) | Nothing safe to auto-install; remediation text points at `node server/tts-sidecar/scripts/ensure-python312.mjs` (existing `NO_PYTHON_INSTRUCTIONS` copy in `venv-bootstrap.ts`). |
| `supervisor-exhausted` | `sidecar-restart` | New: calls the merged `resetAndRespawn()` via `POST /api/sidecar/restart`'s new branch (Design §2). |
| `supervisor-tripped` | `sidecar-restart` | Same route/action kind — the merged `resetAndRespawn()` now also clears this case (already existed as `clearTripAndRespawn`, just not reachable from this route before). |
| `sidecar-blocked` | none (text) | "Fix the voice engine above first" — no independent action; the sidecar card's own action is the actual fix. |
| `no-engine-installed` | `kokoro-install` | Kokoro is the always-available fallback — reuses its existing install job. |
| `weights-missing` | `qwen-install` or `coqui-install` | Whichever engine reported weights-missing; reuses its existing install job. |
| `package-broken` | none (text) | "Repair in Model Manager" — matches the existing `diagnostics.ts` copy; no new one-click repair exists today. |
| `ffmpeg-missing` / `ffprobe-missing` / `both-missing` | none (text) | Nothing in-app can safely install/PATH-edit these. |
| `ollama-unreachable` | `ollama-install` | Reuses existing `POST /api/ollama/install`. |
| `model-not-pulled` | `ollama-pull` **only if** `expectedModel` is in the `pullable` allowlist | `POST /api/ollama/pull` 400s for a model outside `pullBootstrap`'s allowlist (`ollama-health.ts:417-428`) — `diagnoseAnalyzer()` checks `expectedModel` against the same `pullable` list `probeOllamaHealth()` already returns (round-1 review finding 7) before attaching the action; otherwise falls back to text ("pull it via terminal: `ollama pull <model>`"). |
| `no-gemini-key` | `navigate` | Links to Advanced Settings' Gemini key field; nothing safe to automate (entering a secret). |

Every blocker, pass or fail, also gets an implicit `recheck` action in the UI (re-fetch `/api/setup/readiness`) — not modeled as a per-cause `action`, just a standing control the frontend always renders.

### 2. Server changes

New module `server/src/routes/setup-diagnosis.ts` (thin, mirrors `setup-readiness.ts`'s existing style): exports `diagnoseSidecar()`, `diagnoseTts(sidecarDiagnosis)`, `diagnoseFfmpeg()`, `diagnoseAnalyzer()`, each walking its cause chain against the existing probes named above plus one new one (supervisor exhaustion, below). `diagnoseSidecar()` reads the `supervisor-exhausted`/`supervisor-tripped` layers via `getActiveSupervisor()?.exhaustedEvent()` / `.tripEvent()`; **only `tripEvent()` exists on `SidecarSupervisor` today — `exhaustedEvent()` is net-new** (corrected from round-1 review finding 5, which caught this section's earlier draft claiming both were "already module-exported," directly contradicted by the interface at `sidecar-supervisor.ts:103-131` and by the very next bullet, which says to add it). When there is no active supervisor (autoStart off) neither layer can match and the chain falls through to `unreachable-transient`. `buildSetupReadiness` in `setup-readiness.ts` calls these — `diagnoseSidecar()` first, its result passed into `diagnoseTts()` — instead of the current boolean `checkOk` folding; `GET /api/setup/readiness` becomes the single endpoint polled by both the Setup checker and the Status popover.

**`python-missing`'s subprocess cost** (round-1 review finding 3): `findPython312()` runs `spawnSync` against up to three interpreter candidates (`python-discovery.ts:15-35`) — real process spawns, not filesystem stats. It is only invoked when `!sidecarVenvPresent()` (i.e. already inside the rare, already-degraded "venv missing" branch, not on every poll of a healthy system), and its result is cached with a short TTL (10s) independent of the poll interval, so repeated automatic polls during an active stuck-venv incident don't repeatedly spawn interpreter probes.

**Sidecar-supervisor exhaustion fix** (`sidecar-supervisor.ts`):
- Add `exhaustedEvent(): boolean` on the `SidecarSupervisor` interface — true once `consecutiveFailures > maxConsecutiveFailures` and no respawn is pending, cleared by recovery.
- Merge `clearTripAndRespawn()` into a single `resetAndRespawn()` that resets **both** `restart43Trip`/`restart43Timestamps` (existing) **and** `consecutiveFailures` (new), then calls `spawnOnce()`. Keeps the existing "safe to call when not tripped" idempotency guarantee for the exhaustion case too. All existing call sites of `clearTripAndRespawn` (Plan 2's auto-revert route) are updated to call `resetAndRespawn()`.
- **Double-spawn guard (round-1 review finding 4, `Significant`+`Asserted`/partially `Contradicted`):** the plain-exhaustion backoff respawn (`onChildExit`, `sidecar-supervisor.ts:338-346`) is a detached `await delayFn(delayMs)` inside an async IIFE with no cancellation handle. A `resetAndRespawn()` call landing *during* that backoff window (a stale diagnosis click racing a respawn already in flight) would otherwise call `spawnOnce()` a second time, racing two children for the same port. Fix: an internal `respawnEpoch` counter, incremented on every `spawnOnce()` call (including from `resetAndRespawn()`); the backoff continuation captures the epoch before its `delayFn` await and checks it's unchanged before calling `spawnOnce()`, no-opping if a newer respawn already superseded it. This avoids adding cancellation semantics to the injectable `delayFn` (which tests rely on).

**`POST /api/sidecar/restart`** (`sidecar-health.ts:425`): the branch at line 452 (today's misleading "will spawn shortly" for a null-current, non-tripped supervisor) splits into: tripped → existing message, unchanged; **exhausted → calls `resetAndRespawn()` and polls `/health` the same way the normal restart path already does**, returning `{ ok: true }` on recovery; neither → existing generic "autoStart off or booting" message, unchanged.

**Honest limitation, not a fix: a persistent root cause re-exhausts.** If `resetAndRespawn()` is clicked and the underlying fault is still present (e.g. a hardware/GPU issue unrelated to the venv), the supervisor will simply crash-loop back to `supervisor-exhausted` again. This mirrors real operator behavior today (manual retry after checking logs) — this spec does not attempt root-cause diagnosis beyond the causes explicitly enumerated in the chain, and the fix button remains clickable for another attempt rather than locking out after one failed retry.

### 3. Frontend changes

**Full migration surface (round-1 review finding 6, `Significant`+`Contradicted` — the original list was incomplete):**
- `src/lib/api.ts` (line ~6367-6386): its own mirrored `BlockerStatus`/`SetupReadiness` types change to match the server shape; `mockGetSetupReadiness()` (used by every frontend test and mock-mode e2e) updated to emit `BlockerDiagnosis` objects instead of bare strings.
- `setup-wizard.tsx` (`buildSummaryRows`, 5 call sites: lines 243, 255-256, 269-270): reads `blockers.X.status` (was `blockers.X === 'pass'`) and shows `blockers.X.message` as the detail line instead of the current hardcoded per-area strings.
- `step-models.tsx` (3 call sites: lines 85, 89, 131): badges take `blockers.X.status` / `.message`, gain a remediation line + (when present) a fix-action button directly under each badge. This is the direct fix for the screenshot's flat "Runtime needed."
- **`step-ffmpeg.tsx` (line 14: `readiness.blockers.ffmpeg === 'pass'`) — missed in the original draft.** Under the new object type this comparison is always `false`, permanently showing "not passed" — a typecheck-passing but silently-wrong regression, not a build break, so it wouldn't be caught without this fix. Updated to `readiness.blockers.ffmpeg.status === 'pass'`.
- New shared `useSetupDiagnosis()` hook: polls `GET /api/setup/readiness` (same interval the popover already uses for `ttsControls`), returns the typed `SetupReadiness`. Both the Setup wizard and the Status popover use it — no duplicated polling/parsing logic.
- New `<BlockerFixAction diagnosis={BlockerDiagnosis} onDone={() => void}>` component: maps `action.kind` to its mutation (`venv-bootstrap`/`qwen-install`/`kokoro-install`/`coqui-install`/`ollama-install`/`ollama-pull` → their respective existing job-start endpoints, polling to completion; `sidecar-restart` → `POST /api/sidecar/restart`; `recheck` → refetch readiness; `navigate` → an in-app link). Owns its own loading/error state so callers don't hand-roll button wiring. On completion (success or error) it calls `onDone`, which triggers a `useSetupDiagnosis()` refetch — never trusts the diagnosis it was rendered from as still current (race safety, Design §4).
- `status-popover.tsx`: renders the sidecar/tts diagnosis under "Voice engines" (only when failing), the analyzer diagnosis under "Analysis" (only when failing), and a new top-of-panel ffmpeg banner (only when failing).
- **`ModelControlPill.tsx` gains one small additive prop, `suppressUnreachableAction?: boolean`** (default `false`, all existing call sites unaffected) — when `true`, the `unreachable` state still renders its label but omits the "Retry" button. `status-popover.tsx` passes `true` on the TTS pill whenever a specific `BlockerDiagnosis` with its own action is about to render alongside it. This directly resolves a contradiction the round-1 review flagged: the Problem section indicts Retry as "cannot succeed against a missing venv," but the original draft's Out-of-scope line left it rendered right next to the new, correct action — a confusing "two buttons, one wrong" state. The prop is additive and doesn't change `ModelControlPill`'s state machine or its other call sites (the analyzer pills in `generation.tsx`/`layout.tsx` never pass it, so they're unaffected).

### 4. Error handling & edge cases

- **Stale diagnosis after a fix action.** `BlockerFixAction` always triggers a `useSetupDiagnosis()` refetch after its mutation settles rather than trusting the diagnosis object it was rendered from — covers both "the fix worked" and "something else changed the state while the action was in flight."
- **Action failure.** Surfaced inline via the job's existing `{status: 'error', error}` shape (`VenvBootstrap`, `QwenInstallBootstrap`, the Ollama bootstraps) — no new error-handling pattern needed.
- **`resetAndRespawn()` called when nothing is wrong** (double-click, or the sidecar already self-recovered). Must remain a safe no-op-then-respawn, matching the existing `clearTripAndRespawn` doc comment ("safe to call when not tripped").
- **Diagnosis computed mid-transition** (backoff window between respawn attempts). `unreachable-transient` is the deliberate catch-all so an ordinary backoff-and-retry never flashes a "click to fix" action for a state about to resolve itself in a couple seconds.
- **Polling cost.** `/api/setup/readiness` is now polled by the popover in addition to the wizard. Most underlying probes are cheap (filesystem existence checks, or the one `/health` fetch `diagnostics.ts`'s `sidecar` check already reuses); the one exception, `findPython312()`'s subprocess spawns, is gated to only run inside the already-rare venv-missing branch and TTL-cached (Design §2) — corrected from the original draft's blanket "every probe is cheap" claim (round-1 review finding 3).
- **A venv fix can immediately surface a second, different cause — this is expected, not a bug.** If the sidecar had already crash-looped to `supervisor-exhausted` against a broken venv, clicking `venv-bootstrap`'s fix only repairs the venv — it does not itself reset/respawn the supervisor. After the post-fix refetch, the sidecar diagnosis can transition from `venv-missing` to `supervisor-exhausted`, now offering a *different* action (`sidecar-restart`). The UI handles this correctly by construction (each refetch renders whatever the current diagnosis and action actually are) — but a user may see two sequential fix-clicks rather than one, and that sequencing is not itself surfaced as a "you'll need to do this twice" hint anywhere. Documented here as an accepted v1 gap, not fixed.

## Out of scope

- Changing `ModelControlPill.tsx`'s state machine or type contract — it gains exactly one additive, default-`false` prop (`suppressUnreachableAction`, Design §3) to resolve the redundant-Retry contradiction; its existing behavior for every other caller is unchanged.
- A one-click fix for `package-broken` (package not importable in an otherwise-present venv) — stays text-only ("repair in Model Manager"); building an automated repair for that state is a separate, larger piece of work.
- Any change to the Admin console (`src/views/admin.tsx`) — it already surfaces `diagnostics.ts`'s technical detail directly and is unaffected by this spec.
- A one-click fix for `ffmpeg-missing`/`ffprobe-missing` or `no-gemini-key` — neither has a safe in-app automation (PATH editing, secret entry), so both stay text-only by design (Decision 3), not as a deferred gap.
- Sequencing multi-step recoveries into a single guided flow (e.g. auto-chaining "rebuild venv" → "restart voice engine" when both are needed) — each cause's action is independent and correct on its own; chaining them into one guided wizard step is future work, not this spec (Design §4).
- Preventing an infinite retry loop against a persistent, unenumerated fault — `resetAndRespawn()` will re-exhaust if the real cause isn't one of this spec's causes; this mirrors today's manual-retry behavior and is not a regression this spec introduces (Design §2).

## Adversarial review outcomes

The spec was attacked against the live code (Opus tier, a real `assumption-checker` invocation, per this project's mandatory-review-gate policy) after the first draft.

**Round 1** found 2 `Critical`+`Contradicted`, 3 `Significant` (2 `Contradicted`, 1 `Asserted`/partially `Contradicted`), and 2 `Minor`+`Contradicted` findings:

1. **tts fix-actions presuppose a working venv (Critical → fixed).** An empty venv makes `anyTtsEnginePresent()` false, so the original tts chain offered `kokoro-install` — which fails against the same missing venv, reproducing the spec's own motivating dead-end. Resolved by Decision-level addition: a new `sidecar-blocked` first layer in the tts chain, gated on the already-computed sidecar diagnosis (Design §1).
2. **`package-broken` can silently false-pass while the sidecar is down (Critical → fixed).** `kokoroPackageInstalled`/`qwenPackageInstalled` are `undefined` (not `false`) whenever the sidecar is unreachable, so that layer could never match in the most common failure mode, letting the chain fall through to `pass`. The same `sidecar-blocked` gate from finding 1 closes this by construction — `package-broken` is now only reachable once the sidecar is confirmed `pass`.
3. **The polling-cost claim was wrong for one probe (Significant → fixed).** `findPython312()` spawns subprocesses, not filesystem stats. Resolved by nesting the probe inside the already-rare venv-missing branch plus a short TTL cache (Design §2), rather than claiming (as the original draft did) that every probe is equally cheap.
4. **A user-triggered `resetAndRespawn()` could race an in-flight backoff respawn (Significant → fixed).** Neither the existing `clearTripAndRespawn` nor the merge as originally specified had a guard against a manual reset landing mid-backoff. Resolved with a `respawnEpoch` counter so a stale backoff continuation no-ops once a newer respawn has started (Design §2).
5. **"Both already module-exported" was self-contradicting (Minor → fixed).** The original §2 draft claimed `exhaustedEvent()` already existed on `SidecarSupervisor`, directly contradicted by the interface listing and by the very next bullet, which says to add it. Corrected to state plainly that only `tripEvent()` exists today.
6. **The frontend migration list was incomplete (Significant → fixed).** `step-ffmpeg.tsx`'s `readiness.blockers.ffmpeg === 'pass'` comparison — a typecheck-passing, silently-always-false regression under the new object type — was absent from the original file list, as was `src/lib/api.ts`'s own mirrored `SetupReadiness` type and `mockGetSetupReadiness()`. All three are now in Design §3's migration surface and the test plan.
7. **`ollama-pull`'s action can target a disallowed model (Minor → fixed).** `POST /api/ollama/pull` 400s for any model outside `pullBootstrap`'s allowlist; the action mapping now conditions the `ollama-pull` action on the expected model actually being in the `pullable` list, falling back to text otherwise.

The review also surfaced two contradictions folded into the design rather than treated as discrete numbered findings: the Problem section indicts `ModelControlPill`'s Retry button by name, but the original Out-of-scope section left it rendered unchanged right next to the new, correct fix action — resolved via the additive `suppressUnreachableAction` prop (Design §3); and a venv fix alone doesn't reset an already-exhausted supervisor, so a single incident can require two sequential fix-clicks — documented as an accepted, expected v1 behavior rather than silently implied to be one click (Design §4).

Round 1 tripped the mandatory re-review threshold (2 `Critical`+`Contradicted`, plus 2 more `Significant`+`Contradicted`) — per this project's review-gate policy, a round-2 pass against this now-revised spec is required, not optional, regardless of whether round 1's findings were disputed.

## Test plan

**Unit (Vitest, server):**
- `setup-diagnosis.test.ts` — one case per cause per blocker; a case asserting first-match-wins within the sidecar chain when both `venv-missing` and `python-missing`'s underlying conditions hold (reports `python-missing`). **New, from round-1 review:** a case asserting `diagnoseTts()` reports `sidecar-blocked` (not `no-engine-installed`) whenever the passed-in sidecar diagnosis is `fail`, regardless of tts-specific disk state; a case asserting `package-broken` is never returned while `sidecar.status !== 'reachable'` (only reachable via the `sidecar-blocked` gate in that state); a case for `model-not-pulled`'s action being omitted when `expectedModel` isn't in the `pullable` allowlist.
- `sidecar-supervisor.test.ts` — new cases for `exhaustedEvent()` and the merged `resetAndRespawn()` covering both the code-43-trip and plain-exhaustion paths, plus the not-tripped/not-exhausted no-op case. **New, from round-1 review:** a case asserting `resetAndRespawn()` called during an in-flight backoff window does not double-spawn (the stale backoff continuation's epoch check no-ops).
- `sidecar-health.test.ts` — new case for `/restart`'s exhausted branch (calls `resetAndRespawn`, polls health, returns `{ok:true}`).
- `python-discovery.test.ts` — case asserting the `findPython312()` probe used by the venv-missing sub-check is only invoked when the venv is absent, and is TTL-cached across rapid repeated calls (round-1 review finding 3).

**Unit (Vitest, frontend):**
- `setup-wizard.test.tsx` / `step-models.test.tsx` — extend existing `notReadyReadiness`/`readyReadiness` fixtures to the new `BlockerDiagnosis` shape; assert message/remediation/action render per cause.
- **`step-ffmpeg.test.tsx` (missed in the original draft, round-1 review finding 6)** — update its `makeReadiness('pass'|'fail')` helper to the new shape; assert the step still reads `passed` correctly (regression-locks the exact silent-break the review caught).
- `status-popover.test.tsx` — new cases per diagnosis block (sidecar/tts/analyzer/ffmpeg) appearing only when failing; a case asserting the TTS `ModelControlPill`'s Retry is suppressed (`suppressUnreachableAction`) precisely when a specific diagnosis+action is rendered alongside it.
- `BlockerFixAction.test.tsx` — one case per `action.kind` mapping to its mutation; error-path rendering; `onDone` fires and triggers a refetch.
- `api.test.ts` — `mockGetSetupReadiness()` emits the new `BlockerDiagnosis` shape (existing test at `api.test.ts:32` — `expect(first.blockers.tts).toBe('fail')` — updates to `.status`).

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
