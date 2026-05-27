---
status: active
shipped: 2026-05-27
owner: null
---

# TTS load-error surfacing + orphaned-sidecar log resilience

> Status: active
> Key files: `src/components/tts-notice-banner.tsx`, `src/components/layout.tsx`, `src/views/generation.tsx`, `server/src/tts/spawn-sidecar.ts`
> URL surface: indirect — the global TTS pill in the top bar (see [30-global-model-control.md](30-global-model-control.md))
> OpenAPI ops: none (uses existing `POST /api/sidecar/load`)

## Benefit / Rationale

Fixes the reported bug "Qwen Load model keeps reverting — clicking the button
thinks, goes back to idle, never loads the actual model." Two independent
causes, both fixed here.

- **User:** a TTS Load failure (or analyzer eviction) is now *visible* from
  every stage that shows the global pill — not just the Generate view. And the
  underlying load failure (the orphaned sidecar) no longer happens after a dev
  reload.
- **Technical:** the sidecar's stdout/stderr survive the Node parent dying, so
  a model `/load` (which writes a huggingface `from_pretrained` tqdm progress
  bar) can't 500 with `OSError: [Errno 22] Invalid argument`.
- **Architectural:** locks the invariant "the one `useTtsLifecycle` notice
  state has exactly one render surface, mounted globally" and "a sidecar owns
  its log file descriptors, independent of who spawned it."

## Root cause (Layer B)

`server/src/tts/spawn-sidecar.ts` spawned the sidecar with
`stdio: ['ignore','pipe','pipe']` and piped `child.stdout/stderr` into the log
files **on the Node side**. When `tsx watch` hot-reloads the dev server, the
old Node process dies but the long-lived sidecar (powershell → python/uvicorn)
is **orphaned** — and the JS pipe's read end died with the parent. The next
sidecar write to stdout/stderr — notably the `from_pretrained` progress bar
during a model `/load` — then raised `[Errno 22] Invalid argument`, surfacing
as a `/load` 500 and a pill that reverts to idle. (Verified: a fresh sidecar
process loads Qwen Base fine; the resident orphaned one 500s.)

## Architectural impact

- **Layer A — `TtsNoticeBanner`** (`src/components/tts-notice-banner.tsx`): the
  eviction + load-error notice markup, extracted verbatim from
  `generation.tsx`. Rendered ONCE in `layout.tsx` under `<TopBar>`, gated on
  the same `showGlobalTtsPill` flag as the pill. The inline copy in
  `generation.tsx` was removed (both surfaces share the one `useTtsLifecycle`
  instance via `LayoutContext`, so keeping both would double-render).
- **Layer B — inherited log fds** (`spawn-sidecar.ts`): the log files are
  opened with `fs.openSync(path, 'a')` and their descriptors handed to the
  child as `stdio: ['ignore', outFd, errFd]`. The child inherits them as its
  own OS handles (valid regardless of the parent's lifetime); the parent closes
  its copies after spawn. EBUSY (OneDrive lock) fallback to a timestamped
  sibling is preserved; if the files can't be opened at all, stdio falls back
  to `'ignore'` (logging is non-fatal, spawn still proceeds).
- **Preserves** the dev-reload sidecar-persistence optimization (`spawnSidecar`
  still honours an existing `:9000` listener — see [43-auto-start-sidecar.md](archive/43-auto-start-sidecar.md));
  the persisted sidecar's logging now simply survives the reload.
- **Reversibility:** revert the two files; no data/format/migration change.

## Invariants to preserve

- `TtsNoticeBanner` renders nothing when both `evictionNotice` and
  `loadErrorNotice` are null (`src/components/tts-notice-banner.tsx`).
- The banner is mounted exactly once, in `layout.tsx`, gated on
  `showGlobalTtsPill` — NOT duplicated in any view.
- `spawn-sidecar.ts` passes the child raw integer fds for stdout/stderr (never
  `'pipe'`); the parent closes its fd copies after spawn.

## Test plan

### Automated coverage

- Vitest unit (`src/components/tts-notice-banner.test.tsx`) — renders-nothing
  contract; eviction info line (not an alert); load error as `role="alert"` +
  dismiss calls `onDismiss`; both-notices-together.
- Vitest unit (`src/lib/use-tts-lifecycle.test.ts`, pre-existing) — already
  pins load-error → `loadErrorNotice` (status=error and throw paths), the
  eviction banner, and `dismissNotices`. The banner is the render surface for
  that state.
- Vitest server (`server/src/tts/spawn-sidecar.test.ts`) — new case asserts
  `stdio` is `['ignore', <number>, <number>]` (inherited fds, not `'pipe'`) and
  that the log files are created under `repoRoot/logs`. Existing cases moved to
  a writable temp `repoRoot` (the eager fd-open would EACCES on `/repo` on
  Linux CI).

The layout-level integration is covered transitively (hook test sets the state,
component test renders it, the layout wiring is a single gated render). An
error-path e2e was skipped: the mock `loadSidecar` always succeeds, and the
banner only appears on error/eviction, so there is no cheap happy-path to
assert in mock mode.

### Manual acceptance walkthrough

1. With a healthy sidecar, click **Load model** on the Qwen pill in the
   Analysing top bar → pill goes amber then **green ("Qwen ready")**;
   `GET :9000/health` reports `qwen_loaded:true`.
2. Force a load failure (e.g. stop the sidecar) and click **Load model** from
   the top bar → the rose error banner appears **under the top bar** with the
   reason; the dismiss (×) clears it.
3. Edit a server file to trigger a `tsx watch` reload, then click **Load
   model** → the (persisted) sidecar still loads; no `[Errno 22]`.

## Out of scope

- Detecting/replacing a *wedged* sidecar (CUDA-poisoned torch state). The
  start.ps1 supervisor already restarts on poison exit code 42; a wedged
  orphan from before this fix still needs a manual restart.
- Cross-platform sidecar auto-spawn (`spawnSidecar` is Windows-only today —
  pre-existing).

## Ship notes

Shipped 2026-05-27 on branch `fix/frontend-qwen-load-reverts`. Two layers:
global `TtsNoticeBanner` (frontend) + inherited log fds in `spawn-sidecar.ts`
(server). Pairs with [30-global-model-control.md](30-global-model-control.md)
and [43-auto-start-sidecar.md](archive/43-auto-start-sidecar.md).
