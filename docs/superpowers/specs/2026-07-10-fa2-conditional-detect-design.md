---
status: draft
---

# FA2: conditional detect + opt-in Linux install (side-21 rescope)

## Context

`server/tts-sidecar/scripts/install-qwen3.mjs` has an opt-in FlashAttention-2
installer (`--flash-attn` / `QWEN_INSTALL_FLASH_ATTN=1`). Today it only knows
one path: a pinned community wheel for Windows AMD64 + CPython 3.11 +
torch 2.6.0/cu124. Any other platform — including Linux, where FA2 is far
more commonly already present (built by the user, baked into a base image,
or installable straight from PyPI) — hits an unconditional skip:
`no pinned wheel for ${platform}; SDPA remains the default`.

Issue #1000 (side-21) originally scoped this as "fix the stale Windows pin
(cp311 → the real cp312/torch2.11/cu128 stack) + conditional auto-enable."
That Windows-specific pin fix is deferred to a future companion ticket. This
spec rescopes #1000 to the piece that matters now: **detect an
already-present FA2 on any platform, and add an opt-in Linux install
attempt** — without touching the Windows path or runtime attention-impl
selection at all.

## Goals

- If `flash_attn` is already importable in the sidecar venv (any platform),
  report it and how to activate it. Never attempt to (re)install over it.
- On Linux, when not already importable and the installer is opted in, try
  `pip install flash-attn` (unpinned — straight from PyPI, no community
  wheel/supply-chain concern like the Windows wheel). Non-fatal on failure.
- Preserve today's Windows behavior and today's runtime default (SDPA)
  exactly. Activation is always a manual, separate step via the existing
  `QWEN_ATTN_IMPL` env var — the installer never sets it, on any platform.
- No change to `main.py` runtime attention-impl selection (already correct:
  `QWEN_ATTN_IMPL` defaults to `"sdpa"`, `server/tts-sidecar/main.py:2022`).

## Non-goals

- The Windows stale cp311 pin / cp312-real-stack fix — separate future issue.
- macOS support — no CUDA, a `pip install flash-attn` attempt there is pure
  busywork (guaranteed to fail); leave it on the existing generic skip path.
- Any new CLI flag or env var. The existing `--flash-attn` /
  `QWEN_INSTALL_FLASH_ATTN=1` opt-in gates everything in this spec.
- Auto-activating FA2 at runtime once installed/detected — stays manual.

## Design

### New I/O probe

Add `flashAttnImportable(python)` in `install-qwen3.mjs`, sibling to the
existing `venvPyTag(python)` helper: `spawnSync(python, ['-c', 'import
flash_attn'])`, returns `true` on exit code 0, else `false`.

### `resolveFlashAttnInstall()` — extended decision table

The function stays pure (no I/O) and testable without a venv. It gains one
new input, `alreadyImportable`, and one new platform branch:

```
resolveFlashAttnInstall({ enabled, platform, pyTag, profile, alreadyImportable })
```

Decision order:

1. `!enabled` → `{ action: 'skip', reason: 'not requested' }` (unchanged)
2. `profile === 'amd'` → `{ action: 'skip', reason: '...no ROCm wheel...' }` (unchanged)
3. `alreadyImportable` → **new**: `{ action: 'already-installed', reason:
   'flash_attn is already importable in this venv — set
   QWEN_ATTN_IMPL=flash_attention_2 to use it (SDPA stays the default until
   you opt in)' }`. Checked before any platform branch — on any OS, if it's
   already there, nothing else runs.
4. `platform === 'win32'` → unchanged cp311-pin logic (`pyTag !== 'cp311'` →
   skip; else `{ action: 'install', url: FLASH_ATTN_WHEEL_URL }`)
5. `platform === 'linux'` → **new**: `{ action: 'install-pip', package:
   'flash-attn' }`
6. else (e.g. `darwin`) → unchanged: `{ action: 'skip', reason: 'no pinned
   wheel for ${platform}; SDPA remains the default' }`

### `installFlashAttn()` — orchestration changes

- Compute `alreadyImportable = flashAttnImportable(python)` before calling
  `resolveFlashAttnInstall()`.
- `action: 'already-installed'` → log the reason, return. No pip call.
- `action: 'install-pip'` → log a heads-up that this is an unpinned PyPI
  install with no prebuilt CUDA wheel (can be a long compile — no time
  estimate promised, just a clear warning), then `pip install flash-attn`
  via the existing `run()` helper. On non-zero exit: warn and continue on
  SDPA (same pattern as the Windows wheel-download-failure path). On
  success: verify with `import flash_attn` (same as Windows), then print
  the same manual-activation instruction as Windows — never set
  `QWEN_ATTN_IMPL` itself.
- `action: 'install'` (win32) and `action: 'skip'` paths: untouched.

### Comment/docstring updates

Update the module-level comment (lines ~19–23) and the `FLASH_ATTN_WHEEL_URL`
doc comment (lines ~81–88) to reflect that Windows is one of now two install
paths, not the only one.

## Testing

`scripts/tests/install-qwen3-flash-attn.test.mjs`:

- Split the existing combined `darwin`+`linux` "non-Windows → skip" test:
  `darwin` keeps the skip assertion; `linux` moves to new cases.
- New: `linux`, `alreadyImportable: true` → `action: 'already-installed'`,
  no `package`/`url` on the result.
- New: `linux`, `alreadyImportable: false` → `action: 'install-pip'`,
  `package: 'flash-attn'`.
- New: any platform, `alreadyImportable: true` → `already-installed`, even
  `win32` (already-present short-circuits before the pin-check branch).
- Existing win32/cp311, win32/cp312, not-opted-in, wheel-URL-shape tests:
  unchanged, still pass (all pass `alreadyImportable: false` implicitly or
  explicitly).

No venv/CUDA-dependent test is added or needed — `flashAttnImportable()`
itself (the I/O half) isn't unit-tested directly, matching the existing
precedent (`venvPyTag()` also isn't unit-tested — it's a thin venv-python
wrapper exercised only by hand/on-box, not in CI).

## Acceptance

- On the current dev stack (Windows, no FA2 wheel available for the actual
  cp312/torch2.11/cu128 combo): unchanged — installer reports the existing
  cp311-only skip reason, stays on SDPA.
- On a Linux box with `flash_attn` already importable: installer reports it,
  attempts no install, SDPA remains the runtime default until the operator
  sets `QWEN_ATTN_IMPL=flash_attention_2` by hand.
- On a Linux box without `flash_attn`, opted in: installer attempts `pip
  install flash-attn`, warns about compile time, succeeds or fails
  non-fatally, never sets the runtime knob itself.
- `npm run test:hooks` (or the equivalent script test runner) green with the
  updated + new cases.

## Handoff

Single-scope `chore(sidecar)` change. Next step is `writing-plans`, which
produces the implementation plan and the issue-handoff comment. As part of
that handoff: repurpose #1000's title/body to this scope, and file a new
companion issue for the deferred Windows cp311→cp312 pin fix.
