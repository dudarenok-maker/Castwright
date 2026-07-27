# Describe the `/api/setup/*` surface in OpenAPI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all 8 `/api/setup/*` endpoints into `openapi.yaml`, generate the frontend types, delete **both** hand-mirrored type blocks in `src/lib/api.ts`, and add a server-side parity test so a divergence between the server's unions and the contract **fails a test**.

> **Read this before starting — revision 2 corrects a false premise.**
> Revision 1 claimed that deleting the frontend hand-mirror makes server↔frontend
> divergence "a compile error". It does not. **The server does not consume
> `src/lib/api-types.ts`** — stated outright at
> `server/src/workspace/voice-library.ts:9-10` — and `openapi.yaml` is not
> derived from server types. Generating the frontend types alone therefore
> *relocates* the hand-mirror from `src/lib/api.ts` to `openapi.yaml`; a
> contributor adding a `BlockerCause` member to
> `server/src/routes/setup-readiness.ts` would get exactly the silence they get
> today. That is the #1881 incident this issue was filed about, reproduced.
>
> **Task 5 is therefore the load-bearing deliverable, not a nicety.** The
> OpenAPI work is real value — it documents the contract and removes 2 of the 3
> copies — but the *guarantee* comes from the parity test. Do not describe this
> PR, in plan 270 or the PR body, as making drift "a compile error" without it.

**Architecture:** Purely a contract-description exercise — **no runtime behaviour changes**, with one deliberate exception (the `vramTotalMb` decision in Task 4). Schemas are authored in `openapi.yaml` under `components.schemas` (line 3304) and paths under `paths:` (line 27), then `npm run openapi:types` regenerates `src/lib/api-types.ts`. Both hand-written blocks in `src/lib/api.ts` (`:7245-7280` and `:7288-7309`) are deleted last, once the generated types exist to replace them. A server-side parity test (Task 5) then pins the contract against the server's own unions — without it, the drift simply moves to `openapi.yaml`.

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
        setup UI can render a diagnosis instead of an error page. The success
        branch additionally reports the analyzer probe.
      required: [ok]
      properties:
        ok: { type: boolean }
        stage:
          type: string
          description: Which phase failed, when ok is false (e.g. `synth`).
        error: { type: string }
        url: { type: string, description: Public URL of the rendered sample. }
        durationSec: { type: number }
        analyzerOk:
          type: boolean
          description: Success branch only — whether the analyzer probe succeeded.
        analyzerDetail:
          type: string
          description: Success branch only — analyzer probe detail or error text.
```

> `analyzerOk` / `analyzerDetail` are **not optional by choice** — the handler
> returns them on the success branch (`setup-readiness.ts:216`) and omits them
> on the failure branch (`:198`). Re-derive this schema from those two lines
> before writing it; do not trust the table above.

- [ ] **Step 3: Add the three paths under `paths:`**

Match the surrounding file's style (`summary`, `operationId`, `responses`). Read two neighbouring path entries first and copy their shape.

> **No `tags:`.** `grep -cE '^      tags:' openapi.yaml` returns **0** — none of the
> 91 existing paths uses operation-level tags and there is no top-level `tags:`
> block. Adding them for 8 of 99 operations would introduce a half-applied
> convention.

```yaml
  /api/setup/readiness:
    get:
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
        modelKey:
          type: string
          enum: [kokoro-v1, qwen3-tts-0.6b, coqui-xtts-v2]
          description: |
            A three-member literal union on BOTH sides today
            (voice-engine-registry.ts:21 via VoiceEngineEntry['defaultModelKey'],
            and src/lib/api.ts:7295). `type: string` alone would silently widen it.
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
- Modify: `src/lib/api.ts` — delete **BOTH** hand-mirrored blocks and re-export from generated types:
  - `:7245-7280` (`BlockerCause` … `SetupReadiness`)
  - `:7288-7309` (`EngineHealthState`, `RuntimeProcessState`, `NeedsAnswer`, `EngineRecommendation`, `RecommendationSet`, `ModelsStatus`) — *"Mirrors ModelsStatus in server/src/tts/models-status.ts"*. **Task 2 describes these schemas; leaving this block hand-written would author `ModelsStatus` in TWO places where it is authored in one today — strictly worse than the status quo.**
- Modify: consumers as the compiler demands — `src/components/setup/setup-wizard.tsx`, `step-*.tsx`, `src/components/status-popover.tsx`, and ~17 test files (see Step 2). NOT `src/views/admin.tsx` — it references none of these types.
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
Expected: **errors, and more than you might guess.** Making `info.vramTotalMb` required breaks roughly **28 literal `info: { gpu: … }` construction sites across 17 files** — both mock branches in `src/lib/api.ts` (`:7371`, `:7377`, not one), plus `layout.test.tsx`, `model-settings-form.test.tsx`, `setup-wizard.test.tsx`, `step-{analysis,defaults,environment,ffmpeg,finish,library,voice}.test.tsx`, `status-popover.test.tsx`, `use-setup-diagnosis.test.ts`, `routes/index.test.tsx`, `store/prosody-autotrigger.test.tsx`, `views/model-manager.test.tsx`, `views/setup.test.tsx`.

Each fix is mechanical — add the field the server has always sent. **Do not add new `as` casts**; a cast re-creates the hole this task closes. *Carve-out:* `step-library.test.tsx:10` (`as unknown as SetupReadiness`) and `layout.test.tsx:868` (`as never`) are **pre-existing** — leave them, don't add more.

- [ ] **Step 3: Resolve the `vramTotalMb` decision explicitly**

The server sends it (`setup-readiness.ts:80,:99`); the old frontend type dropped it; no consumer reads it. Two defensible outcomes:

- **Keep sending it** and let the frontend type carry it (schema as written above). Justification: `models-status` already exposes `vramTotalMb`, the wizard's environment step is the natural consumer, and it costs nothing.
- **Stop sending it** from `setup-readiness.ts` and drop it from the schema. Justification: nothing reads it and dead wire-fields rot.
- **Describe it but leave it out of `required`** — generates `vramTotalMb?: number | null`, documents the field, costs **zero** of the ~28 fixture edits, and touches neither server nor consumers.

**Take the first.** It matches `ModelsStatus`, it is what the server actually always sends (so it is what "the code is right" demands), and the ~28 edits are mechanical corrections to fixtures that are currently *lying about the shape* — which is exactly the class of dishonesty this issue exists to remove. The third option is the cheap escape; take it only if the fixture churn turns out to obscure review, and say so explicitly if you do. Record the choice in the regression plan either way.

- [ ] **Step 4: Verify no consumer regressed**

Run: `npm run typecheck && npx vitest run src/components/setup/ src/lib/`
Expected: clean, all pass.

- [ ] **Step 5: Demonstrate the openapi -> frontend half only**

Temporarily rename `info.gpu` to `gpuName` in `openapi.yaml`, regenerate, and confirm `npm run typecheck` **fails** in `step-environment.tsx:24` (which does read `readiness.info.gpu`). Revert.

> **Do NOT run the "add a member to `BlockerCause` and expect typecheck to fail" experiment.** It is a guaranteed no-op: there is no `Record<BlockerCause, ...>` and no exhaustive switch anywhere in `src/`, so *widening* the union produces zero type errors. It would pass trivially and manufacture false confidence about exactly the claim this plan's header corrects. The server -> contract direction is covered by **Task 5**, not by the compiler.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/ server/
git commit -m "refactor(frontend): generate the setup readiness types instead of hand-mirroring them"
```

---

### Task 5: The parity test — the deliverable that makes the guarantee true

**Files:**
- Create: `server/src/routes/openapi-setup-parity.test.ts`

**Interfaces:**
- Consumes: the schemas from Tasks 1-3 and the TypeScript unions they describe.
- Produces: nothing downstream.

> **Why this exists.** Tasks 1-4 remove two of the three copies of these types,
> but the server keeps its own unions and never reads `api-types.ts`
> (`server/src/workspace/voice-library.ts:9-10`). Without this test, adding a
> `BlockerCause` member to `setup-readiness.ts` still passes every gate — the
> exact #1881 incident this issue was filed about. **This test is the only thing
> in the PR that prevents it.**
>
> **Precedent:** `server/src/routes/voice-library.test.ts:1761-1764` already
> reads `openapi.yaml` at runtime and asserts a route constant equals a schema
> value. Copy its mechanism exactly. `openapi.yaml` is **already** in
> `server/vitest.config.ts`'s `forceRerunTriggers` (pinned by
> `server/src/force-rerun-triggers.test.ts:108`), so the ops-30/#1848 inertness
> trap is already closed for it — no new wiring needed.

- [ ] **Step 1: Read the precedent first**

Open `server/src/routes/voice-library.test.ts` around line 1761 and see how it
loads and reads `openapi.yaml`. If it parses YAML, use the same parser; if it
string-matches, string-match. **Do not add a new dependency** — match what is
already there.

- [ ] **Step 2: Write the test**

Adapt the shape below to whatever mechanism the precedent uses.

```ts
/* fe-57 (#1883) — openapi.yaml is the published contract for /api/setup/*, but
   the server keeps its own TypeScript unions and never imports the generated
   frontend types (see workspace/voice-library.ts:9-10). Nothing else makes the
   two agree; a member added to setup-readiness.ts otherwise ships silently.

   Reads openapi.yaml at RUNTIME (no module-graph edge) — safe because
   openapi.yaml is already in vitest.config.ts's forceRerunTriggers. */
import { describe, it, expect } from 'vitest';

const schemaEnum = (name: string): string[] => { /* per the precedent */ };

/* The server-side unions restated as runtime arrays — the only hand-maintained
   duplicates left. When you add a member to the union in the cited file, add it
   here AND to openapi.yaml; this test is what tells you that you must. */
const SERVER_UNIONS = {
  BlockerCause: {
    source: 'server/src/routes/setup-readiness.ts',
    members: [
      'python-missing', 'venv-missing', 'venv-broken', 'supervisor-exhausted',
      'supervisor-tripped', 'unreachable-transient', 'unreachable-no-supervisor',
      'sidecar-blocked', 'no-engine-installed', 'weights-missing',
      'cannot-confirm-engine', 'package-broken', 'ffmpeg-missing',
      'ffprobe-missing', 'both-missing', 'ffmpeg-too-old', 'ollama-unreachable',
      'model-not-pulled', 'no-gemini-key', 'pass',
    ],
  },
  BlockerActionKind: {
    source: 'server/src/routes/setup-readiness.ts',
    members: [
      'venv-bootstrap', 'qwen-install', 'kokoro-install', 'coqui-install',
      'sidecar-restart', 'ollama-install', 'ollama-pull', 'navigate',
    ],
  },
} as const;

describe('openapi.yaml describes the /api/setup/* surface accurately', () => {
  it.each(Object.entries(SERVER_UNIONS))(
    '%s matches its TypeScript union',
    (name, { source, members }) => {
      expect(schemaEnum(name), `openapi.yaml's ${name} drifted from ${source}`)
        .toEqual([...members].sort());
    },
  );

  it('every /api/setup/* route the server mounts is described', () => {
    // Guards against a NEW endpoint shipping undescribed — the failure mode
    // that created this issue in the first place.
    expect(describedSetupPaths().sort()).toEqual([
      '/api/setup/complete',
      '/api/setup/models-status',
      '/api/setup/readiness',
      '/api/setup/smoke',
      '/api/setup/venv/bootstrap',
      '/api/setup/venv/bootstrap/{id}',
      '/api/setup/venv/bootstrap/{id}/recheck',
      '/api/setup/venv/detect',
    ]);
  });
});
```

Also add the other unions Tasks 2-3 describe — `EngineHealthState`,
`RuntimeProcessState`, `VoiceEngineId`, `VenvBootstrapState`,
`VenvBootstrapJobStatus` — with their source files cited the same way.

- [ ] **Step 3: Run it — it must PASS if Tasks 1-3 were done right**

Run: `cd server && npx vitest run src/routes/openapi-setup-parity.test.ts`
Expected: PASS. A failure means a schema from Tasks 1-3 is wrong — fix the
**schema**, never the expected array.

- [ ] **Step 4: Prove it can actually fail — do not skip this**

Two mutations, each reverted after:

1. Delete one member from `BlockerCause`'s enum in `openapi.yaml` → the test must
   fail naming the drift.
2. Delete one `/api/setup/*` path from `openapi.yaml` → the coverage test must fail.

Record both results in the commit message. This is the evidence the deleted
Task 4 Step 5 experiment could not have provided.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/openapi-setup-parity.test.ts
git commit -m "test(server): pin openapi.yaml's setup schemas against the server unions"
```

---

### Task 6: Regression plan, index, release notes

**Files:**
- Create: `docs/features/270-openapi-setup-surface.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: Write plan 270**

`status: active`. Must record: the 8 endpoints now described; that **both** hand-mirrored blocks in `src/lib/api.ts` are gone; the `vramTotalMb` decision and its reasoning; and — stated precisely — that **the server still keeps its own unions and does not consume the generated types**, so the guarantee comes from the Task 5 parity test rather than from the compiler.

**Do not write that divergence is "a compile error".** In the server -> contract direction it is not. Cite Task 5 Step 4's demonstrated failures as the evidence.

- [ ] **Step 2: Add it to `docs/features/INDEX.md`** under `### K. Cross-cutting invariants`.

> **Plan 269's Ship notes are NOT part of this branch.** They are paperwork for
> a different, already-merged plan; landing them here would breach
> "one branch = one cohesive change". They ship separately.

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

**Spec coverage.** All 8 endpoints → Tasks 1-3. Delete **both** hand-mirrors → Task 4 Step 1. `vramTotalMb` → Task 4 Step 3 (three options, with a recommendation and the reasoning for each). No new `as` casts, with a carve-out for the two pre-existing ones → Global Constraints + Task 4 Step 2. Mock satisfies the schema → Task 4 Step 2. `openapi:types` clean + CI check → Task 1 Step 4, Task 6 Step 5. **Server↔contract parity → Task 5, which is the only task that delivers the issue's stated benefit.**

**Testing discipline.** CLAUDE.md requires every PR to improve automated coverage. Tasks 1-4 add none — they are codegen and deletion, and Task 4 Step 5's demonstration is reverted. **Task 5 is what satisfies that gate**, and its Step 4 mutation-proves it can fail rather than asserting that it can.

**The ops-30/#1848 pin-inertness trap applies after all** — Task 5 reads `openapi.yaml` at runtime, outside its module graph. It is already closed for this file: `openapi.yaml` is in `server/vitest.config.ts`'s `forceRerunTriggers`, pinned by `force-rerun-triggers.test.ts:108`. No new wiring, but do not remove that entry.

**Placeholders.** Task 4 Steps 2 and 4 are compiler-driven rather than quoting the fixes, because the exact set of errors depends on generated output that doesn't exist until Task 1 runs; each states the rule to apply (satisfy the contract, never cast). Tasks 1-3 quote every schema in full.

**Type consistency.** `BlockerCause`, `BlockerActionKind`, `BlockerAction`, `BlockerDiagnosis`, `SetupReadiness` keep their exact current exported names through Task 4, so no consumer import changes. `info: { gpu, vramTotalMb }` is spelled identically in `SetupReadiness` and `ModelsStatus`. Enum members are copied from named source files with line refs in every task, and each task's Step 1 says to diff against source rather than trust the plan's transcription.
