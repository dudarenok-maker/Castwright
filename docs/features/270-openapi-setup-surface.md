---
status: active
shipped: null
owner: null
---

# 270 — the `/api/setup/*` surface in OpenAPI

> Status: active
> Key files: `openapi.yaml` (8 new paths + 14 new schemas),
> `src/lib/api-types.ts` (generated), `src/lib/api.ts` (both hand-mirrored
> blocks deleted, replaced by generated aliases),
> `server/src/routes/openapi-setup-parity.test.ts` (**the guard**)
> URL surface: none directly — the Setup Wizard (`#/setup`) and admin
> diagnostics (`#/admin`) consume these types
> OpenAPI ops: `GET /api/setup/readiness`, `POST /api/setup/complete`,
> `POST /api/setup/smoke`, `GET /api/setup/models-status`,
> `GET /api/setup/venv/detect`, `POST /api/setup/venv/bootstrap`,
> `GET /api/setup/venv/bootstrap/{id}`, `POST /api/setup/venv/bootstrap/{id}/recheck`

Implementation plan: [`docs/superpowers/plans/2026-07-27-openapi-setup-surface.md`](../superpowers/plans/2026-07-27-openapi-setup-surface.md) (revision 2)
Discovered by: [`269-ffmpeg-version-floor.md`](269-ffmpeg-version-floor.md) invariant 9 · fe-57 · [#1883](https://github.com/dudarenok-maker/Castwright/issues/1883)

## Benefit / Rationale

- **User:** none. This is internal type safety with no user-visible delta.
- **Technical:** the last undescribed API surface is now in the contract, and
  the repo's largest hand-mirrored type block is gone. A `/api/setup/*` response
  shape is authored once.
- **Architectural:** a divergence between the server's unions and the published
  contract now **fails `npm run typecheck`**. Before this, all 8 endpoints could
  drift freely with every gate green — which is exactly how #1877 came to need
  `'ffmpeg-too-old'` hand-added to two files.
- **Found a live bug on the way:** `src/components/venv-bootstrap.tsx` declared
  `status: 'installing'`, a value this endpoint never emits, so its progress
  card never rendered during a real bootstrap. See "The bug this surfaced".

## What this does NOT do — read before extending

**Generating the frontend types does not, on its own, guard anything.** The
first revision of the plan claimed it made server↔frontend divergence a compile
error. It did not: the server **does not consume `src/lib/api-types.ts`** —
stated outright at `server/src/workspace/voice-library.ts:9-10` — and
`openapi.yaml` is not generated from server types. Deleting the frontend
hand-mirror on its own would merely have **relocated** the duplicate from
`src/lib/api.ts` to `openapi.yaml`.

What closes the loop is the parity test's `satisfies Record<Union, 1>` maps
(invariant 2), which re-introduce the missing compile-time dependency on the
server's unions from inside a test file. Without them the surface has three
independently-editable copies and no guard at all.

So the copy count went from three to two, not to one:

| Copy | Where | Guarded by |
|---|---|---|
| Server unions | `server/src/routes/setup-readiness.ts` etc. | **`satisfies Record<Union, 1>` in the parity test — a member added here fails `npm run typecheck`** |
| The contract | `openapi.yaml` | the parity test's runtime assertion |
| Frontend types | `src/lib/api-types.ts` | generated — cannot drift |

The guarantee is the parity test — half compile-time (`satisfies`, catching a
server-union edit) and half runtime (`toEqual`, catching an `openapi.yaml`
edit). Delete that file, or weaken its `satisfies` maps to plain arrays, and
this surface silently returns to its pre-fe-57 state with every gate still
green.

## Invariants to preserve

1. **`openapi.yaml` is where these types are authored on the frontend side.**
   Never hand-write a `/api/setup/*` type in `src/lib/api.ts` — edit the YAML and
   run `npm run openapi:types`. `src/lib/api.ts` holds only `export type X =
   ApiComponents['schemas']['X']` aliases, deliberately keeping the original
   exported names so no consumer import churns.
2. **`openapi-setup-parity.test.ts` is load-bearing, and the `satisfies` is the
   load-bearing part of it.** Each union's member list is
   `satisfies Record<TheServerUnion, 1>` over a type-only import, so the chain is:
   *server union → (compile time) → the test's map → (runtime) → `openapi.yaml`
   → (codegen) → `api-types.ts`*. Adding a member to the server union fails
   `npm run typecheck` **inside this test file** with a missing key; removing one
   fails with an excess key.

   **A bare array of strings here would guard nothing** — it would only pin
   `openapi.yaml` against a third hardcoded literal, so editing the server union
   alone would still pass, which is precisely the #1877/#1881 forget-mode this
   issue exists to close. The first draft of this test did exactly that and was
   caught at PR review. If you ever replace `satisfies Record<…>` with a plain
   array, you have silently removed the guarantee.
3. **It reads `openapi.yaml` at runtime**, outside its module graph — so it
   depends on `openapi.yaml` staying in `server/vitest.config.ts`'s
   `forceRerunTriggers` (pinned by `force-rerun-triggers.test.ts:108`). Remove
   that entry and the guard goes inert under `vitest --changed` — the ops-30 /
   [#1848](https://github.com/dudarenok-maker/Castwright/issues/1848) trap.
4. **`NeedsAnswer` stays hand-written** (`src/lib/api.ts`). It is the wizard's
   guided-question answer key (`'expressive-or-multilingual' | 'simple-english'`),
   never a field on any response body, so it has no schema to alias to. Do not
   invent one for symmetry.
5. **`info.vramTotalMb` is required** on both `SetupReadiness` and
   `ModelsStatus`. The server always sends it (`setup-readiness.ts:99`, sourced
   from `models.info.vramTotalMb`); the old frontend type dropped it, which is
   the drift that surfaced this issue. Keeping it required is what forced the 18
   fixtures that were misrepresenting the shape to start telling the truth.
6. **No `as` casts to bridge a schema mismatch.** A cast re-creates the hole this
   plan closes. Two pre-existing casts (`step-library.test.tsx:10`,
   `layout.test.tsx:868`) predate this work and were deliberately left alone.
7. **No operation-level `tags:`.** None of the other 91 paths uses them; adding
   them for 8 operations would half-apply an undeclared convention.

## Test plan

### Automated coverage

- `server/src/routes/openapi-setup-parity.test.ts` — 8 assertions (7 union
  parities + route coverage). Mechanism copied from
  `voice-library.test.ts:1761`: reads `openapi.yaml` at runtime and
  string-matches, **no YAML parser, no new dependency**.
- **Mutation-verified in the direction that matters.** Adding `'invented-drift'`
  to `BlockerCause` in `setup-readiness.ts` **alone** fails `npm run typecheck`:
  `error TS1360: … does not satisfy the expected type 'Record<BlockerCause, 1>'`.
  This is the mutation the first draft never ran — both of its mutations edited
  `openapi.yaml`, which is why it shipped a guard that missed the server-only
  case entirely. Deleting an enum member or a path from `openapi.yaml` fails the
  runtime assertions. All reverted.
- The openapi→frontend direction was separately demonstrated by renaming
  `info.gpu` to `gpuName` in the schema and confirming `npm run typecheck` fails
  at `step-environment.tsx:24`. Reverted.
- `verify.yml`'s "OpenAPI types up to date" step regenerates and diffs
  `src/lib/api-types.ts`, so a schema edit without regeneration fails CI.

> **Note on where the exhaustiveness lives.** Nothing in `src/` is invariant
> over `BlockerCause` — no `Record<BlockerCause, …>`, no exhaustive switch — so
> widening the union breaks no *frontend* code, and a test asserting that it
> does would pass trivially. The parity test supplies that invariance itself,
> deliberately, via `satisfies Record<BlockerCause, 1>`. That is why invariant 2
> insists the `satisfies` stays.

### Manual acceptance walkthrough

No behaviour changed, so there is nothing to click through. Confirm by
inspection that `#/setup` still renders every wizard step and `#/admin` still
renders the diagnostics board — both consume the regenerated types.

## The bug this surfaced

`src/components/venv-bootstrap.tsx` hand-declared its own `VenvBootstrapJob`
with `status: 'installing' | 'installed' | 'error'`. The venv bootstrapper emits
`'detecting' | 'bootstrapping' | 'installed' | 'error'`
(`server/src/tts/venv-bootstrap.ts:43`, transitions at `:128`/`:158`);
`'installing'` is the **sibling** ollama/coqui/kokoro bootstrappers' vocabulary,
copied here by mistake.

So `if (job && job.status === 'installing')` was dead in production: during a
real multi-minute venv bootstrap the job sits in `'bootstrapping'`, the progress
card — spinner, "Setting up the voice engine runtime…", the live `job.step`
line — never rendered, and the user saw the idle "Set up" button the whole time.
The suite stayed green because the component's own tests mocked
`status: 'installing'` too — a placebo over a wire value the server cannot
produce.

Fixed by aliasing the component's type to the generated one (so the dead branch
became a compile error) and branching on both real pre-terminal states. Pinned
by an `it.each(['detecting', 'bootstrapping'])` regression test.

This is the single best illustration of why the issue was worth doing: the
drift was invisible, tested, and shipping.

## Known limitations

- **The route-coverage assertion is a literal, not derived from the routers.**
  It catches a path being removed from `openapi.yaml`, but a brand-new route
  mounted without a description would still pass. Deriving the expected set by
  scanning `app.ts`'s mounts is the honest fix; recorded here rather than
  overclaimed in the test.
- **Three enums in the described schemas are unpinned**: `BlockerDiagnosis.status`
  (`pass`/`warn`/`fail`), `EngineRecommendation.modelKey`, and
  `EngineRecommendation.alternate` (a second copy of `VoiceEngineId`). Adding a
  member to `VoiceEngineId` would be caught on `EngineRecommendation.engine` but
  not on `alternate`, `modelKey`, or `ModelsStatus.engines`' key set.
- `SetupReadiness.info` and `ModelsStatus.info` are byte-identical inline
  objects rather than a shared `$ref`'d schema, so a future field must be added
  twice — the drift class this plan otherwise fights.
- The parity test locates schemas by **string matching**, following its
  precedent. A pure reformatting of `openapi.yaml` can therefore surface as
  "schema not found" rather than a precise drift message. It fails **closed**,
  so this is a diagnostics-quality limitation, not a correctness one.
- The server's unions remain hand-maintained and are restated as arrays inside
  the parity test. That is a third copy — but it is one the test itself
  compares, so it cannot drift silently, which is the whole point.

## Ship notes

_Pending._
