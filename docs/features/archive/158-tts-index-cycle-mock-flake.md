---
status: stable
shipped: 2026-06-01
owner: null
---

# 158 — Break the tts/index ↔ provider cycle (partial-mock release-gate flake)

> Status: stable
> Key files: `server/src/tts/model-keys.ts` (new leaf), `server/src/tts/index.ts`, `server/src/tts/gemini.ts`, `server/src/tts/sidecar.ts`, `server/src/tts/index.test.ts`
> URL surface: none (server module structure / test reliability)
> OpenAPI ops: none

## Benefit / Rationale

- **Technical:** removes the intermittent `[vitest] No "isTtsModelKey" export is defined on the "../tts/index.js" mock` failure that took down the **cross-OS release gate** (`cross-os.yml`, both Windows + macOS) during the v1.5.1 cut attempt. The flake also masquerades as the `tinypool` / `importOriginal` family in `MEMORY.md` and previously forced "just re-run the gate."
- **Architectural:** establishes a clean leaf module for the pure TTS model-key helpers, so the provider classes never import their own barrel — a small invariant that keeps `importOriginal('../tts/index.js')` reliably complete.

## Root cause

`server/src/tts/index.ts` imported the `GeminiTtsProvider` / `SidecarTtsProvider` classes, and those provider modules imported pure helpers (`resolveGeminiModelId`, `sidecarModelId`) **back from `./index.js`** — a runtime import cycle (`index → gemini/sidecar → index`). When a route test does `vi.mock('../tts/index.js', async (importOriginal) => ({ ...await importOriginal(), selectTtsProvider: … }))`, `importOriginal()` resolves `index.js` while it is still mid-cycle-evaluation. Under the **parallel** `test:server` pool (where `qwen-voice.test.ts` runs) the returned namespace was occasionally partial, so the `{...actual}` spread dropped an export (e.g. `isTtsModelKey`) → the route's `import { isTtsModelKey } from '../tts/index.js'` threw "No export defined on the mock". Seven route test files share this mock shape, so any of them could trip it.

(The sibling `toVoiceLike` / `../tts/synthesise-chapter.js` log line is a *different* mechanism — `synthesise-chapter` has no cycle — and is already suppressed on CI because the `generation*.test.ts` files run single-fork under `test:server-slow`. Out of scope here.)

## Fix

Move the pure, provider-independent declarations (`TtsEngine`, `TtsModelKey`, `TTS_MODEL_LABELS`, `resolveGeminiModelId`, `isTtsModelKey`, `engineForModelKey`, `sidecarModelId`) into a new **leaf** module `server/src/tts/model-keys.ts` (imports nothing). Then:

- `gemini.ts` / `sidecar.ts` import their helper from `./model-keys.js` (not `./index.js`) — the runtime back-edge to `index` is gone.
- `index.ts` re-exports the leaf (`export * from './model-keys.js'`) so the public `tts/index.js` surface is byte-for-byte unchanged for every existing importer; it imports `engineForModelKey` from the leaf for `selectTtsProvider`.

Runtime graph after: `index → {gemini, sidecar, model-keys, user-settings}`, `gemini → model-keys`, `sidecar → model-keys`. No cycle, so `importOriginal('../tts/index.js')` is always complete.

## Invariants to preserve

- The pure model-key helpers live in `server/src/tts/model-keys.ts` and are **re-exported** by `index.ts`, never re-declared there (re-declaring would reintroduce the cycle). Pinned by the identity test below.
- `gemini.ts` / `sidecar.ts` import value helpers from `./model-keys.js`, and only `import type` from `./index.js`.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/index.test.ts`) — existing helper-behaviour cases still pass through the `index.js` re-export (proves the public API is unchanged), plus a new **cycle-break guard**: `indexModule.isTtsModelKey === modelKeysModule.isTtsModelKey` (and the other four helpers) — asserts `index` re-exports the *same references* as the leaf, so a future edit can't move a helper back into `index` and silently re-form the cycle.
- The seven route tests that `vi.mock('../tts/index.js')` (`qwen-voice`, `voice-sample`, `generation`, `generation-fallback-gate`, `generation-orphan-recovery`, `generation-recycle-recovery`, `generation-resume-from`) stay green.

### Manual acceptance walkthrough

1. `npm run test:server` (parallel pool) → no `No "isTtsModelKey" export is defined on the mock` failures across repeated runs.
2. `npm run typecheck` clean — the re-export keeps every existing `import { … } from '../tts/index.js'` resolving.

## Out of scope

- The `toVoiceLike` / `synthesise-chapter.js` log line (different mechanism, single-forked on CI).
- A general lint rule against barrel self-import cycles — could be a follow-up if more of these surface.

## Ship notes

Shipped 2026-06-01 on branch `fix/server-tts-mock-cycle`. Behaviour-neutral module split (pure helper relocation + re-export). Caught while triaging the v1.5.1 cross-OS gate failure.
