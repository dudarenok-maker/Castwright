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
  contract now **fails a test**. Before this, all 8 endpoints could drift freely
  with every gate green — which is exactly how #1877 came to need
  `'ffmpeg-too-old'` hand-added to two files.

## What this does NOT do — read before extending

**It does not make server↔frontend divergence a compile error.** The first
revision of the plan claimed that, and it was false. The server **does not
consume `src/lib/api-types.ts`** — stated outright at
`server/src/workspace/voice-library.ts:9-10` — and `openapi.yaml` is not
generated from server types. Deleting the frontend hand-mirror on its own would
merely have **relocated** the duplicate from `src/lib/api.ts` to `openapi.yaml`.

So the copy count went from three to two, not to one:

| Copy | Where | Guarded by |
|---|---|---|
| Server unions | `server/src/routes/setup-readiness.ts` etc. | — (authoritative) |
| The contract | `openapi.yaml` | **`openapi-setup-parity.test.ts`** |
| Frontend types | `src/lib/api-types.ts` | generated — cannot drift |

The guarantee comes from the parity test, **not** from the compiler. If that
test is ever deleted or allowed to go inert, this surface silently returns to
its pre-fe-57 state.

## Invariants to preserve

1. **`openapi.yaml` is where these types are authored on the frontend side.**
   Never hand-write a `/api/setup/*` type in `src/lib/api.ts` — edit the YAML and
   run `npm run openapi:types`. `src/lib/api.ts` holds only `export type X =
   ApiComponents['schemas']['X']` aliases, deliberately keeping the original
   exported names so no consumer import churns.
2. **`openapi-setup-parity.test.ts` is load-bearing, not paperwork.** It asserts
   the contract's enums equal the server's TypeScript unions for `BlockerCause`,
   `BlockerActionKind`, `RuntimeProcessState`, `EngineHealthState`,
   `VoiceEngineId`, `VenvBootstrapState` and `VenvBootstrapJobStatus`, **and**
   that every mounted `/api/setup/*` route is described. Adding a union member
   without updating `openapi.yaml` fails it.
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
- **Mutation-verified, twice, rather than assumed:** deleting `ffmpeg-too-old`
  from `BlockerCause`'s enum fails with *"openapi.yaml's BlockerCause drifted
  from server/src/routes/setup-readiness.ts"*; deleting the
  `/api/setup/venv/detect` path fails the coverage assertion. Both reverted.
- The openapi→frontend direction was separately demonstrated by renaming
  `info.gpu` to `gpuName` in the schema and confirming `npm run typecheck` fails
  at `step-environment.tsx:24`. Reverted.
- `verify.yml`'s "OpenAPI types up to date" step regenerates and diffs
  `src/lib/api-types.ts`, so a schema edit without regeneration fails CI.

> **Deliberately not asserted:** that a *widened* `BlockerCause` breaks
> typecheck. It does not — nothing in `src/` is invariant over that union (no
> `Record<BlockerCause, …>`, no exhaustive switch), so such a test would pass
> trivially and imply a guarantee that does not exist. Invariant 2 is the real
> guard.

### Manual acceptance walkthrough

No behaviour changed, so there is nothing to click through. Confirm by
inspection that `#/setup` still renders every wizard step and `#/admin` still
renders the diagnostics board — both consume the regenerated types.

## Known limitations

- The parity test locates schemas by **string matching**, following its
  precedent. A pure reformatting of `openapi.yaml` can therefore surface as
  "schema not found" rather than a precise drift message. It fails **closed**,
  so this is a diagnostics-quality limitation, not a correctness one.
- The server's unions remain hand-maintained and are restated as arrays inside
  the parity test. That is a third copy — but it is one the test itself
  compares, so it cannot drift silently, which is the whole point.

## Ship notes

_Pending._
