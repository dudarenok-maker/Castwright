# Describe the `/api/setup/*` surface in OpenAPI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all 8 `/api/setup/*` endpoints into `openapi.yaml`, generate the frontend types, and delete the hand-mirrored type block in `src/lib/api.ts` so server↔frontend divergence becomes a compile error.

**Architecture:** Purely a contract-description exercise — **no runtime behaviour changes**, with one deliberate exception (the `vramTotalMb` decision in Task 4). Schemas are authored in `openapi.yaml` under `components.schemas` (line 3304) and paths under `paths:` (line 27), then `npm run openapi:types` regenerates `src/lib/api-types.ts`. The hand-written block at `src/lib/api.ts:7247-7280` is deleted last, once the generated types exist to replace it.

**Tech Stack:** OpenAPI 3.x (`openapi.yaml`), `openapi-typescript` via `npm run openapi:types`, TypeScript, Vitest.

**Issue:** [fe-57 / #1883](https://github.com/dudarenok-maker/Castwright/issues/1883)

## Global Constraints

- **No behaviour changes.** Do not alter what any handler returns, or how `readiness.ready` is computed. If a schema and the code disagree, the **code is right** — describe what it actually returns, then note the discrepancy for the human. The one sanctioned change is Task 4's `vramTotalMb` decision.
- **`openapi.yaml` is the type source of truth** (CLAUDE.md). Never hand-write a type in `src/lib/api.ts` that OpenAPI could generate.
- **`npm run openapi:types` must be run and its output committed.** `verify.yml:204` has an "OpenAPI types up to date" check that fails the PR otherwise.
- **No `as` casts to bridge a mismatch.** If a consumer doesn't compile against the generated type, the schema is wrong — fix the schema, don't cast.
- **Enum values must match the TypeScript unions exactly.** Copy them; do not retype from memory. Authoritative sources are listed per task.
- Commit convention: `<type>(<scope>): <subject>`. Scopes here: `openapi`, `frontend`, `docs`.

## The 8 endpoints

| Route | Handler | Response |
|---|---|---|
| `GET /api/setup/readiness` | `setup-readiness.ts:111` | `SetupReadiness` |
| `POST /api/setup/complete` | `setup-readiness.ts:105` | `{ completedAt: string }` |
| `POST /api/setup/smoke` | `setup-readiness.ts:180` | `{ ok, stage?, error?, url?, durationSec? }` |
| `GET /api/setup/models-status` | `models-status.ts:95` | `ModelsStatus` |
| `GET /api/setup/venv/detect` | `venv-bootstrap.ts:34` | `{ state, venvPresent, pythonFound, installed }` |
| `POST /api/setup/venv/bootstrap` | `venv-bootstrap.ts:38` | `202` + `VenvBootstrapJob` |
| `GET /api/setup/venv/bootstrap/:id` | `venv-bootstrap.ts:43` | `VenvBootstrapJob` or `404 { error }` |
| `POST /api/setup/venv/bootstrap/:id/recheck` | `venv-bootstrap.ts:51` | `VenvBootstrapJob` or `404 { error }` |

---

### Task 1: Readiness schemas + the three `setup-readiness` paths

**Files:**
- Modify: `openapi.yaml` (`components.schemas` from line 3304; `paths:` from line 27)

**Interfaces:**
- Produces schemas `BlockerCause`, `BlockerActionKind`, `BlockerAction`, `BlockerDiagnosis`, `SetupReadiness`, `SetupCompleteResponse`, `SetupSmokeResponse`. Tasks 2-4 reference these by `$ref`.

- [ ] **Step 1: Copy the enum values from source — do not retype**

Authoritative: `server/src/routes/setup-readiness.ts` `BlockerCause` (~:39-50) and `BlockerActionKind` (~:52-54). Read them first. As of this writing `BlockerCause` is:

`python-missing`, `venv-missing`, `venv-broken`, `supervisor-exhausted`, `supervisor-tripped`, `unreachable-transient`, `unreachable-no-supervisor`, `sidecar-blocked`, `no-engine-installed`, `weights-missing`, `cannot-confirm-engine`, `package-broken`, `ffmpeg-missing`, `ffprobe-missing`, `both-missing`, `ffmpeg-too-old`, `ollama-unreachable`, `model-not-pulled`, `no-gemini-key`, `pass`

and `BlockerActionKind` is: `venv-bootstrap`, `qwen-install`, `kokoro-install`, `coqui-install`, `sidecar-restart`, `ollama-install`, `ollama-pull`, `navigate`.

**Verify by diffing** — if the file has more members than listed, the file wins.

- [ ] **Step 2: Add the schemas under `components.schemas`**

```yaml
    BlockerCause:
      type: string
      description: |
        Terminal reason a setup blocker is in its current state. `pass` is the
        shared healthy value. Mirrors BlockerCause in
        server/src/routes/setup-readiness.ts — keep them in lockstep.
      enum: [python-missing, venv-missing, venv-broken, supervisor-exhausted,
             supervisor-tripped, unreachable-transient, unreachable-no-supervisor,
             sidecar-blocked, no-engine-installed, weights-missing,
             cannot-confirm-engine, package-broken, ffmpeg-missing,
             ffprobe-missing, both-missing, ffmpeg-too-old, ollama-unreachable,
             model-not-pulled, no-gemini-key, pass]

    BlockerActionKind:
      type: string
      enum: [venv-bootstrap, qwen-install, kokoro-install, coqui-install,
             sidecar-restart, ollama-install, ollama-pull, navigate]

    BlockerAction:
      type: object
      description: A safe automated fix offered alongside a diagnosis.
      required: [kind, label]
      properties:
        kind: { $ref: '#/components/schemas/BlockerActionKind' }
        label: { type: string }
        params:
          type: object
          additionalProperties: { type: string }
          description: Extra data the action needs, e.g. `{ model: 'qwen3.5:9b' }`.
        href:
          type: string
          description: For `navigate` only — an in-app hash route (e.g. `#/models`).

    BlockerDiagnosis:
      type: object
      required: [status, cause, message, remediation]
      properties:
        status:
          type: string
          enum: [pass, warn, fail]
          description: |
            `warn` does NOT block: GET /api/setup/readiness computes `ready` as
            every blocker being `pass` OR `warn`.
        cause: { $ref: '#/components/schemas/BlockerCause' }
        message: { type: string }
        remediation: { type: string }
        action: { $ref: '#/components/schemas/BlockerAction' }

    SetupReadiness:
      type: object
      required: [ready, completedAt, blockers, info]
      properties:
        ready:
          type: boolean
          description: True when every blocker is `pass` or `warn`.
        completedAt:
          type: string
          nullable: true
          description: ISO-8601 timestamp the wizard was completed, or null.
        blockers:
          type: object
          required: [sidecar, ffmpeg, tts, analyzer]
          properties:
            sidecar: { $ref: '#/components/schemas/BlockerDiagnosis' }
            ffmpeg: { $ref: '#/components/schemas/BlockerDiagnosis' }
            tts: { $ref: '#/components/schemas/BlockerDiagnosis' }
            analyzer: { $ref: '#/components/schemas/BlockerDiagnosis' }
        info:
          type: object
          required: [gpu, vramTotalMb]
          properties:
            gpu: { type: string }
            vramTotalMb: { type: integer, nullable: true }

    SetupCompleteResponse:
      type: object
      required: [completedAt]
      properties:
        completedAt: { type: string, description: ISO-8601 timestamp just written. }

    SetupSmokeResponse:
      type: object
      description: |
        End-to-end synth check. Returns ok:false (never 5xx) on failure so the
        setup UI can render a diagnosis instead of an error page.
      required: [ok]
      properties:
        ok: { type: boolean }
        stage:
          type: string
          description: Which phase failed, when ok is false (e.g. `synth`).
        error: { type: string }
        url: { type: string, description: Public URL of the rendered sample. }
        durationSec: { type: number }
```

- [ ] **Step 3: Add the three paths under `paths:`**

Match the surrounding file's style (`tags`, `summary`, `operationId`, `responses`). Read two neighbouring path entries first and copy their shape.

```yaml
  /api/setup/readiness:
    get:
      tags: [setup]
      summary: First-run readiness probe
      operationId: getSetupReadiness
      responses:
        '200':
          description: Readiness snapshot across sidecar, ffmpeg, voice engine and analyzer.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SetupReadiness' }

  /api/setup/complete:
    post:
      tags: [setup]
      summary: Mark the setup wizard complete
      operationId: completeSetup
      responses:
        '200':
          description: The timestamp written.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SetupCompleteResponse' }

  /api/setup/smoke:
    post:
      tags: [setup]
      summary: End-to-end synth smoke check
      operationId: runSetupSmoke
      responses:
        '200':
          description: Result. `ok:false` carries the failing stage — never a 5xx.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SetupSmokeResponse' }
```

- [ ] **Step 4: Regenerate and verify the YAML parses**

Run: `npm run openapi:types`
Expected: exits 0; `src/lib/api-types.ts` gains `SetupReadiness` etc. under `components['schemas']`. If the generator errors, the YAML is malformed — fix before continuing.

- [ ] **Step 5: Confirm the generated shape matches the server type**

Run: `npm run typecheck`
Expected: clean (nothing consumes the new types yet — this only proves the generated file compiles).

- [ ] **Step 6: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(openapi): describe the setup readiness, complete and smoke endpoints"
```

---

### Task 2: `models-status` schemas + path

**Files:**
- Modify: `openapi.yaml`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `RuntimeStatus`, `EngineStatus`, `EngineRecommendation`, `RecommendationSet`, `ModelsStatus`.

- [ ] **Step 1: Copy the unions from source**

Authoritative: `server/src/tts/models-status.ts:12-38`, `server/src/tts/engine-health.ts:8-13`, `server/src/tts/engine-recommendation.ts:15-26`, `server/src/tts/voice-engine-registry.ts:16`.

- `RuntimeProcessState` = `ready | starting | down | crashed`
- `EngineHealthState` = `ready | package-missing | weights-missing | not-installed | loaded`
- `VoiceEngineId` = `kokoro | qwen | coqui`

- [ ] **Step 2: Add the schemas**

```yaml
    RuntimeStatus:
      type: object
      required: [installedOnDisk, pythonFound, process]
      properties:
        installedOnDisk: { type: boolean }
        pythonFound: { type: boolean }
        process:
          type: string
          enum: [ready, starting, down, crashed]

    EngineStatus:
      type: object
      required: [state, packageBroken]
      properties:
        state:
          type: string
          enum: [ready, package-missing, weights-missing, not-installed, loaded]
        packageBroken:
          type: boolean
          description: |
            Package present on disk but fails to IMPORT in the sidecar.
            Sidecar-up-only — false when the sidecar is down, which is NOT a
            first-run "fine" guarantee.

    EngineRecommendation:
      type: object
      required: [engine, modelKey, reason, caveat, alternate]
      properties:
        engine: { type: string, enum: [kokoro, qwen, coqui] }
        modelKey: { type: string }
        reason: { type: string }
        caveat: { type: string, nullable: true }
        alternate: { type: string, enum: [kokoro, qwen, coqui], nullable: true }

    RecommendationSet:
      type: object
      description: fe-51 — precomputed recommendation for both answers to the wizard's guided question.
      required: [expressiveOrMultilingual, simpleEnglish]
      properties:
        expressiveOrMultilingual: { $ref: '#/components/schemas/EngineRecommendation' }
        simpleEnglish: { $ref: '#/components/schemas/EngineRecommendation' }

    ModelsStatus:
      type: object
      required: [runtime, engines, info, recommendation]
      properties:
        runtime: { $ref: '#/components/schemas/RuntimeStatus' }
        engines:
          type: object
          description: Keyed by VoiceEngineId.
          required: [kokoro, qwen, coqui]
          properties:
            kokoro: { $ref: '#/components/schemas/EngineStatus' }
            qwen: { $ref: '#/components/schemas/EngineStatus' }
            coqui: { $ref: '#/components/schemas/EngineStatus' }
        info:
          type: object
          required: [gpu, vramTotalMb]
          properties:
            gpu: { type: string }
            vramTotalMb: { type: integer, nullable: true }
        recommendation: { $ref: '#/components/schemas/RecommendationSet' }
```

> `engines` is spelled out per-key rather than as `additionalProperties`, so a
> new `VoiceEngineId` becomes a visible schema change instead of silently
> type-checking. If `VoiceEngineId` has gained a member, add it here.

- [ ] **Step 3: Add the path**

```yaml
  /api/setup/models-status:
    get:
      tags: [setup]
      summary: Canonical voice-engine status payload
      operationId: getModelsStatus
      responses:
        '200':
          description: Runtime, per-engine health, GPU info and the engine recommendation.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ModelsStatus' }
```

- [ ] **Step 4: Regenerate + typecheck**

Run: `npm run openapi:types && npm run typecheck`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(openapi): describe the setup models-status endpoint"
```

---

### Task 3: venv-bootstrap schemas + four paths

**Files:**
- Modify: `openapi.yaml`

**Interfaces:**
- Produces: `VenvDetectResult`, `VenvBootstrapJob`.

- [ ] **Step 1: Copy from source**

Authoritative: `server/src/tts/venv-bootstrap.ts:41-53` and the `detect()` return at `:102`.

- `VenvBootstrapState` = `present | absent`
- `VenvBootstrapJobStatus` = `detecting | bootstrapping | installed | error`
- `detect()` returns `{ state, venvPresent, pythonFound, installed }`

- [ ] **Step 2: Add the schemas**

```yaml
    VenvDetectResult:
      type: object
      required: [state, venvPresent, pythonFound, installed]
      properties:
        state: { type: string, enum: [present, absent] }
        venvPresent: { type: boolean }
        pythonFound: { type: boolean, description: A Python 3.12 interpreter was found. }
        installed: { type: boolean }

    VenvBootstrapJob:
      type: object
      required: [id, status, step, error, startedAt, updatedAt]
      properties:
        id: { type: string }
        status: { type: string, enum: [detecting, bootstrapping, installed, error] }
        step:
          type: string
          nullable: true
          description: Latest `[bootstrap-venv]` step line, surfaced as UI status text.
        error: { type: string, nullable: true }
        startedAt: { type: integer, description: Epoch ms. }
        updatedAt: { type: integer, description: Epoch ms. }
```

- [ ] **Step 3: Add the four paths**

Note the verb is `/bootstrap`, not `/install` — the venv is a runtime environment, not model weights.

```yaml
  /api/setup/venv/detect:
    get:
      tags: [setup]
      summary: Probe the Python venv and interpreter
      operationId: detectVenv
      responses:
        '200':
          description: Venv + Python probe. No job is started.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/VenvDetectResult' }

  /api/setup/venv/bootstrap:
    post:
      tags: [setup]
      summary: Start a venv bootstrap job
      operationId: startVenvBootstrap
      responses:
        '202':
          description: Job accepted and started.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/VenvBootstrapJob' }

  /api/setup/venv/bootstrap/{id}:
    get:
      tags: [setup]
      summary: Poll a venv bootstrap job
      operationId: getVenvBootstrapJob
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Current job state.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/VenvBootstrapJob' }
        '404':
          description: No such job.
          content:
            application/json:
              schema:
                type: object
                required: [error]
                properties:
                  error: { type: string }

  /api/setup/venv/bootstrap/{id}/recheck:
    post:
      tags: [setup]
      summary: Re-probe venv state for a job
      operationId: recheckVenvBootstrapJob
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: Updated job state.
          content:
            application/json:
              schema: { $ref: '#/components/schemas/VenvBootstrapJob' }
        '404':
          description: No such job.
          content:
            application/json:
              schema:
                type: object
                required: [error]
                properties:
                  error: { type: string }
```

> If the file already defines a shared error schema for 404s, `$ref` that
> instead of inlining — check `components.schemas` before adding a duplicate.

- [ ] **Step 4: Regenerate + typecheck**

Run: `npm run openapi:types && npm run typecheck`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add openapi.yaml src/lib/api-types.ts
git commit -m "feat(openapi): describe the venv-bootstrap endpoints"
```

---

### Task 4: Delete the hand-mirror and repoint consumers

**Files:**
- Modify: `src/lib/api.ts:7247-7280` (delete the block; re-export from generated types)
- Modify: consumers as the compiler demands — `src/components/setup/setup-wizard.tsx`, `step-*.tsx`, `src/components/status-popover.tsx`, `src/views/admin.tsx`
- Modify: `server/src/routes/setup-readiness.ts` **or** the frontend, for the `vramTotalMb` decision

**Interfaces:**
- Consumes: every schema from Tasks 1-3.
- Produces: `BlockerCause`, `BlockerDiagnosis`, `BlockerAction`, `BlockerActionKind`, `SetupReadiness` re-exported from `src/lib/api.ts` with **identical names**, so no consumer import changes.

- [ ] **Step 1: Replace the hand-written block with generated aliases**

Keep the exported names identical so consumer imports don't churn:

```ts
/* fs-21 — first-run readiness. Generated from openapi.yaml (fe-57 / #1883):
   these were hand-mirrored from server/src/routes/setup-readiness.ts until the
   /api/setup/* surface was described in the contract. Do NOT hand-edit —
   change openapi.yaml and run `npm run openapi:types`. */
import type { components } from './api-types';

export type BlockerCause = components['schemas']['BlockerCause'];
export type BlockerActionKind = components['schemas']['BlockerActionKind'];
export type BlockerAction = components['schemas']['BlockerAction'];
export type BlockerDiagnosis = components['schemas']['BlockerDiagnosis'];
export type SetupReadiness = components['schemas']['SetupReadiness'];
```

Check how `src/lib/api.ts` already imports generated types near the top — if it has an existing `components` import, reuse it rather than adding a second.

- [ ] **Step 2: Run the typecheck and let it drive the work**

Run: `npm run typecheck`
Expected: **errors** — this is the point. The generated `info` now requires `vramTotalMb`, so the mock readiness payload in `src/lib/api.ts` (~`:7367`) and any test fixture will fail.

Fix each by making the data satisfy the real contract. **Do not add `as` casts** — a cast here re-creates the exact hole this task closes.

- [ ] **Step 3: Resolve the `vramTotalMb` decision explicitly**

The server sends it (`setup-readiness.ts:80,:99`); the old frontend type dropped it; no consumer reads it. Two defensible outcomes:

- **Keep sending it** and let the frontend type carry it (schema as written above). Justification: `models-status` already exposes `vramTotalMb`, the wizard's environment step is the natural consumer, and it costs nothing.
- **Stop sending it** from `setup-readiness.ts` and drop it from the schema. Justification: nothing reads it and dead wire-fields rot.

**Take the first** unless something surfaces against it — it matches `ModelsStatus`, and removing a field other clients may already read is the riskier change. Record the choice in the regression plan either way.

- [ ] **Step 4: Verify no consumer regressed**

Run: `npm run typecheck && npx vitest run src/components/setup/ src/lib/`
Expected: clean, all pass.

- [ ] **Step 5: Prove the guard now works**

This is the whole point of the task — verify it rather than assume it. Temporarily add a member to `BlockerCause` in `openapi.yaml`, regenerate, and confirm `npm run typecheck` **fails** where the server union doesn't match... then revert.

More practically: temporarily change `info.gpu` to `gpuName` in `openapi.yaml`, regenerate, and confirm `typecheck` fails in `step-environment.tsx`. Revert. Record the result in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/ server/
git commit -m "refactor(frontend): generate the setup readiness types instead of hand-mirroring them"
```

---

### Task 5: Regression plan, index, release notes

**Files:**
- Create: `docs/features/270-openapi-setup-surface.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`
- Modify: `docs/features/269-ffmpeg-version-floor.md` (Ship notes — see below)

- [ ] **Step 1: Write plan 270**

`status: active`. Must record: the 8 endpoints now described; that `src/lib/api.ts` no longer hand-mirrors; the `vramTotalMb` decision and its reasoning; and the invariant that **`openapi.yaml` is the only place these types are authored** — a future contributor adding a `BlockerCause` edits the YAML and regenerates, never `api.ts`. Cite the Task 4 Step 5 verification as evidence the guard is real.

- [ ] **Step 2: Add it to `docs/features/INDEX.md`** under `### K. Cross-cutting invariants`.

- [ ] **Step 3: Fill plan 269's Ship notes**

`docs/features/269-ffmpeg-version-floor.md` still says `_Pending._`. ops-35 shipped in PR #1881 (merge commit `c7ceee9b`, 2026-07-27). Fill the date + SHA. Leave `status: active` — its on-box acceptance (register row E6) is still owed, so it is not `stable` yet and does **not** move to `archive/`.

- [ ] **Step 4: Release notes**

`docs/release-notes-next.md` — technical entry. `RELEASE_NOTES.md` — this is an internal type-safety change with **no user-visible delta**, so per the Before-shipping checklist say so explicitly rather than inventing a user-facing line. Add the technical entry only, and note the omission in the PR body.

- [ ] **Step 5: Full battery**

Run: `npm run verify:fast:branch`
Expected: green, including the "OpenAPI types up to date" check.

- [ ] **Step 6: Commit**

```bash
git add docs/ RELEASE_NOTES.md
git commit -m "docs(docs): add plan 270 and fill plan 269 ship notes"
```

---

## Self-review

**Spec coverage.** All 8 endpoints → Tasks 1-3. Delete the hand-mirror → Task 4 Step 1. `vramTotalMb` → Task 4 Step 3 (with a recommendation and both justifications). No `as` casts → Global Constraints + Task 4 Step 2. Mock satisfies the schema → Task 4 Step 2. `openapi:types` clean + CI check → Task 1 Step 4, Task 5 Step 5. The ops-30/#1848 pin-inertness warning in the issue is moot under this approach — there is no runtime-read pin; the guard is the compiler.

**Placeholders.** Task 4 Steps 2 and 4 are compiler-driven rather than quoting the fixes, because the exact set of errors depends on generated output that doesn't exist until Task 1 runs; each states the rule to apply (satisfy the contract, never cast). Tasks 1-3 quote every schema in full.

**Type consistency.** `BlockerCause`, `BlockerActionKind`, `BlockerAction`, `BlockerDiagnosis`, `SetupReadiness` keep their exact current exported names through Task 4, so no consumer import changes. `info: { gpu, vramTotalMb }` is spelled identically in `SetupReadiness` and `ModelsStatus`. Enum members are copied from named source files with line refs in every task, and each task's Step 1 says to diff against source rather than trust the plan's transcription.
