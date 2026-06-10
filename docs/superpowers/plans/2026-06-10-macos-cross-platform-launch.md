# macOS / Cross-Platform Launch Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each Task is scoped to a non-overlapping set of files so Tasks 1–5 can run as parallel agents in isolated worktrees; Task 6 (vite) is investigation-led; Task 7 (docs) is independent.

**Goal:** Make Castwright install and launch cleanly on macOS (Apple Silicon) and Linux from a release zip, without hand-editing machine-local config — by fixing the five real launch blockers the alpha tester hit, plus the cross-platform launch commands.

**Architecture:** Five independent code fixes + one investigation + one docs update. Device selection and onnxruntime variant become **auto-detected by platform** (no `.env` edits). The sidecar launcher and the `npm start` / `tts:sidecar` commands gain a POSIX path alongside the existing PowerShell one. The release zip gains the `skills/` prompt directory it always omitted.

**Tech Stack:** Node/TypeScript server, Python (FastAPI) TTS sidecar, Vite 8 / Rolldown frontend, bash launcher, PEP 508 dependency markers.

**Branch / worktree:** `fix/macos-launch-cross-platform`, worktree `C:\Claude\wt-macos-launch` (off local `main` @ 25154763).

**Source of truth for root cause:** alpha tester notes (`INSTALL-MACOS-NOTES.md`, v1.3.1) re-verified against current code in this session. Several v1.3.1 items are already fixed; only the items below are still real.

**User decisions (locked):**
- (a) Qwen device default = `auto → cuda:0 → mps → cpu` (mps preferred over cpu on Apple Silicon), with `PYTORCH_ENABLE_MPS_FALLBACK=1`.
- (b) Launch commands cross-platform **by design** (`npm start`, `tts:sidecar`).
- (c) The vite "blank page" chunk bug must be **confirmed on a built bundle** before `vite.config.ts` is touched (Rolldown chunks differently than the Rollup version the bug was filed against).

---

## Verification reality check (read first)

This is macOS-targeted work being authored on Windows. **Unit tests verify the branching logic; they cannot verify the real Mac runtime** (bash spawn, mps tensors, the macOS onnxruntime wheel). The authoritative acceptance is the alpha tester re-running the install. Task 8 produces the tester checklist. Do not claim "verified on macOS" — claim "unit-verified; pending Mac acceptance."

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/build-release-zip.mjs` | add `skills/**` to MANIFEST include | 1 |
| `scripts/tests/release-manifest.test.mjs` | assert skill prompts ship | 1 |
| `server/tts-sidecar/requirements.txt` | onnxruntime variant via `kokoro-onnx[gpu]` extra | 2 |
| `server/tts-sidecar/tests/test_requirements.py` | lock the dep intent | 2 |
| `server/tts-sidecar/main.py` | Qwen `auto`→cuda/mps/cpu resolver + MPS fallback | 3 |
| `server/tts-sidecar/tests/test_qwen_device.py` | resolver unit test | 3 |
| `server/src/config/registry.ts` | `tts.qwen.device` default `auto` (keep string type) | 3 |
| `server/.env.example` | regenerated via `npm run config:sync` | 3 |
| `server/tts-sidecar/start.sh` | **new** POSIX sidecar launcher (mirror of start.ps1) | 4 |
| `server/src/tts/spawn-sidecar.ts` | platform-aware spawn + `error` handler + POSIX group-kill | 4 |
| `server/src/tts/spawn-sidecar.test.ts` | platform-branch + error-handler tests | 4 |
| `scripts/launch-sidecar.mjs` | **new** cross-platform `tts:sidecar` dispatcher | 5 |
| `scripts/start-app.mjs` | **new** cross-platform `npm start` dispatcher | 5 |
| `package.json` | point `start` / `tts:sidecar` at the dispatchers | 5 |
| `vite.config.ts` | (conditional) add `@dnd-kit`/`@tanstack` to react chunk | 6 |
| `INSTALL.md` | ollama persistence + drop now-unneeded device `.env` step | 7 |

---

## Task 1: Ship `skills/` in the release zip (highest blast radius)

**Why:** `server/src/config/prompts.ts:73` (`readPrompt`) does `readFile(<root>/skills/<id>.md)` with **no inlined fallback**; the manifest never included `skills/**`, so **every zip install — Windows included — ENOENTs on the first analysis**. The Mac tester worked around it by hand-creating the files.

**Files:**
- Modify: `scripts/build-release-zip.mjs` (MANIFEST.include array, ~line 80)
- Test: `scripts/tests/release-manifest.test.mjs`

- [ ] **Step 1: Write the failing test** — append to `release-manifest.test.mjs`:

```js
it('ships the analyzer skill prompts (read at runtime from <root>/skills)', () => {
  expect(matchesManifest('skills/audiobook-sentence-attribution.md')).toBe(true);
  expect(matchesManifest('skills/audiobook-character-detection-per-chapter.md')).toBe(true);
  expect(matchesManifest('skills/audiobook-voice-style.md')).toBe(true);
});
```

- [ ] **Step 2: Run, verify it fails** — `npm run test:scripts` (or `node --test scripts/tests/release-manifest.test.mjs`). Expected: FAIL (skills not matched).

- [ ] **Step 3: Implement** — in `scripts/build-release-zip.mjs`, add to the `include` array (e.g. directly after the `'server/tts-sidecar/**',` line and its comment):

```js
    // Analyzer skill prompts — read fresh off disk at runtime by
    // server/src/config/prompts.ts (readPrompt) + analyzer/gemini.ts +
    // analyzer/voice-style.ts. Omitting these ENOENTs every analysis on a
    // zip install (all platforms). See docs/superpowers/plans/2026-06-10-macos-cross-platform-launch.md.
    'skills/**',
```

- [ ] **Step 4: Run, verify it passes** — `npm run test:scripts`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "fix(release): ship skills/ prompts in the release zip"`

---

## Task 2: onnxruntime variant by platform (mac `pip install`)

**Why:** `requirements.txt:38` hard-pins unmarked `onnxruntime-gpu`, which has **no macOS wheel** → `pip install` aborts. `kokoro-onnx`'s own metadata already encodes the correct platform logic: core requires plain `onnxruntime`; the `[gpu]` extra adds `onnxruntime-gpu` **only on `platform_machine=='x86_64' and sys_platform!='darwin'`**. So delegating to the extra is the DRY fix.

**Files:**
- Modify: `server/tts-sidecar/requirements.txt` (lines 31–38, the Kokoro block)
- Test: `server/tts-sidecar/tests/test_requirements.py` (new)

- [ ] **Step 1: Write the failing test** — create `server/tts-sidecar/tests/test_requirements.py`:

```python
"""Lock the onnxruntime dependency strategy: the GPU runtime must be pulled via
kokoro-onnx's platform-gated [gpu] extra, NOT a bare unmarked onnxruntime-gpu
line (which has no macOS wheel and aborts `pip install` on Apple Silicon)."""
from pathlib import Path

REQ = Path(__file__).resolve().parent.parent / "requirements.txt"


def _lines():
    return [l.strip() for l in REQ.read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.strip().startswith("#")]


def test_kokoro_uses_gpu_extra():
    assert any(l.startswith("kokoro-onnx[gpu]") for l in _lines()), \
        "expected kokoro-onnx[gpu] so onnxruntime-gpu is platform-gated by the extra"


def test_no_bare_unmarked_onnxruntime_gpu():
    for l in _lines():
        if l.startswith("onnxruntime-gpu") and ";" not in l:
            raise AssertionError(
                f"bare unmarked onnxruntime-gpu line will break macOS pip install: {l!r}")
```

- [ ] **Step 2: Run, verify it fails** — `cd server/tts-sidecar && ./.venv/Scripts/python.exe -m pytest tests/test_requirements.py -v` (or `npm run test:sidecar`). Expected: FAIL on `test_kokoro_uses_gpu_extra` (currently `kokoro-onnx>=…` without extra) and `test_no_bare_unmarked_onnxruntime_gpu` (the `onnxruntime-gpu>=1.20.0,<2.0.0` line).

- [ ] **Step 3: Implement** — in `requirements.txt`, replace the two Kokoro lines:

```
kokoro-onnx>=0.4.0,<0.5.0
onnxruntime-gpu>=1.20.0,<2.0.0
```

with (update the surrounding comment too):

```
# Kokoro v1 — quality-tuned local TTS engine, eagerly loaded at sidecar startup.
# The [gpu] extra pulls onnxruntime-gpu ONLY on x86_64 non-macOS (kokoro-onnx's
# own marker); plain onnxruntime always comes from the core dep, so macOS /
# Apple Silicon installs the CPU/CoreML runtime and `pip install` succeeds.
# Run scripts/install-kokoro.{ps1,sh} once to fetch the model + voices (~330 MB).
kokoro-onnx[gpu]>=0.4.0,<0.5.0
```

- [ ] **Step 4: Run, verify it passes** — re-run the pytest from Step 2. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "fix(sidecar): onnxruntime via kokoro-onnx[gpu] extra so macOS pip install works"`

---

## Task 3: Qwen device auto-detect (cuda → mps → cpu)

**Why:** `main.py:981` hard-defaults `QWEN_DEVICE=cuda:0` and uses it directly in `.to(...)` → crashes on any box without CUDA. Coqui already auto-detects (`COQUI_DEVICE=auto`), so **only Qwen** needs the fix. The registry knob default + generated `.env.example` must move in lockstep (`config:check` enforces it). Keep the knob a **free-text string** so multi-GPU users can still pin `cuda:1`.

**Files:**
- Modify: `server/tts-sidecar/main.py` (QwenEngine.__init__ ~line 981; `_ensure_base_loaded` device resolution ~line 1042–1119; add a module-level resolver near the other module helpers)
- Test: `server/tts-sidecar/tests/test_qwen_device.py` (new)
- Modify: `server/src/config/registry.ts` (`tts.qwen.device`, ~line 327)
- Modify: `server/.env.example` (regenerated, do not hand-edit)

- [ ] **Step 1: Write the failing test** — create `server/tts-sidecar/tests/test_qwen_device.py`:

```python
"""Qwen device resolver: 'auto' picks cuda:0 → mps → cpu; explicit values pass through."""
import types
import pytest
from main import _resolve_torch_device


def _torch(cuda: bool, mps: bool):
    t = types.SimpleNamespace()
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps))
    return t


def test_auto_prefers_cuda():
    assert _resolve_torch_device("auto", _torch(cuda=True, mps=True)) == "cuda:0"


def test_auto_falls_to_mps_when_no_cuda():
    assert _resolve_torch_device("auto", _torch(cuda=False, mps=True)) == "mps"


def test_auto_falls_to_cpu_when_neither():
    assert _resolve_torch_device("auto", _torch(cuda=False, mps=False)) == "cpu"


@pytest.mark.parametrize("explicit", ["cuda:1", "cpu", "mps"])
def test_explicit_passes_through(explicit):
    assert _resolve_torch_device(explicit, _torch(cuda=True, mps=True)) == explicit
```

- [ ] **Step 2: Run, verify it fails** — `npm run test:sidecar` (or pytest the one file). Expected: FAIL (`_resolve_torch_device` not defined).

- [ ] **Step 3a: Add the resolver** — in `main.py`, near the other module-level helpers (e.g. above `QwenEngine`), add:

```python
def _resolve_torch_device(pref: str, torch_module: Any) -> str:
    """Resolve a QWEN_DEVICE preference to a concrete torch device string.

    'auto' (the default) picks cuda:0 → mps (Apple Silicon) → cpu by
    availability. An explicit value (e.g. 'cuda:1', 'cpu', 'mps') is returned
    unchanged so multi-GPU pins and forced devices are respected."""
    p = (pref or "auto").strip().lower()
    if p != "auto":
        return pref
    if torch_module.cuda.is_available():
        return "cuda:0"
    backends = getattr(torch_module, "backends", None)
    mps = getattr(backends, "mps", None) if backends is not None else None
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"
```

- [ ] **Step 3b: Wire it into QwenEngine.__init__** — replace `self._device = os.environ.get("QWEN_DEVICE", "cuda:0")` (line ~981) with:

```python
        self._device_pref = os.environ.get("QWEN_DEVICE", "auto")
        # PYTORCH_ENABLE_MPS_FALLBACK lets unsupported mps ops fall back to CPU
        # instead of raising. Set early (read per-op at dispatch) whenever mps is
        # in play so the Apple-Silicon path is robust. Concrete device resolved
        # lazily at load (torch isn't imported yet here).
        if self._device_pref.strip().lower() in ("auto", "mps") or "mps" in self._device_pref.lower():
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        self._device = self._device_pref
```

- [ ] **Step 3c: Resolve at load time** — read `_ensure_base_loaded` (around line 1042). Immediately after `torch` is imported there and BEFORE the first use of `self._device` in any `.to(...)`, insert:

```python
            # Resolve 'auto' to a concrete device now that torch is importable.
            self._device = _resolve_torch_device(self._device_pref, torch)
```

(Confirm by reading the function that `self._device` is not consumed before this line within `_ensure_base_loaded`; if a log line prints it earlier, move the resolution above it.)

- [ ] **Step 4: Run, verify it passes** — `npm run test:sidecar`. Expected: PASS for `test_qwen_device.py`; existing sidecar tests still green.

- [ ] **Step 5a: Update the registry knob** — in `server/src/config/registry.ts`, the `tts.qwen.device` entry becomes:

```ts
  {
    key: 'tts.qwen.device',
    env: 'QWEN_DEVICE',
    group: 'tts-engine',
    label: 'Qwen device',
    help: 'PyTorch device for Qwen3-TTS. "auto" (default) picks cuda:0 → mps (Apple Silicon) → cpu. Pin a specific GPU with "cuda:1", or force "cpu" / "mps". Changing this requires a sidecar restart.',
    type: 'string',
    default: 'auto', // ← QWEN_DEVICE resolver in tts-sidecar/main.py (_resolve_torch_device)
    apply: 'restart-sidecar', risk: 'high',
  },
```

- [ ] **Step 5b: Check for tests pinning the old default** — `grep -rn "cuda:0" server/src` and the sidecar-env / registry tests; update any assertion that expected `QWEN_DEVICE`/`tts.qwen.device` default `cuda:0` to `auto`.

- [ ] **Step 5c: Regenerate `.env.example`** — `npm run config:sync` (writes `QWEN_DEVICE=auto` into the managed block). Then `npm run config:check` must pass.

- [ ] **Step 6: Run server unit tests** — `npm run test:server` (registry/resolver/config). Expected: PASS.

- [ ] **Step 7: Commit** — `git commit -am "fix(sidecar,server): Qwen device auto-detect (cuda→mps→cpu); default auto"`

---

## Task 4: Cross-platform sidecar spawn (server stops crashing on boot)

**Why:** `spawn-sidecar.ts:602` always spawns `powershell.exe start.ps1`. On macOS that emits an **async `error` event** (no `child.once('error')` handler exists) → crashes the Node server — exactly the tester's symptom. Fix = POSIX launcher + platform branch + an `error` handler (defense-in-depth) + correct process-group teardown so `bash start.sh`'s uvicorn grandchild isn't orphaned.

**Files:**
- Create: `server/tts-sidecar/start.sh`
- Modify: `server/src/tts/spawn-sidecar.ts` (spawn block ~600–610; `killTree` ~362)
- Test: `server/src/tts/spawn-sidecar.test.ts`

- [ ] **Step 1: Create `server/tts-sidecar/start.sh`** (POSIX mirror of start.ps1; restart on exit 42/43):

```bash
#!/usr/bin/env bash
# POSIX (macOS/Linux) counterpart of start.ps1 — launch the TTS sidecar via the
# venv python with a supervisor loop that restarts on the recoverable exit codes
# 42 (CUDA poison) and 43 (planned memory recycle). See start.ps1 for the Windows
# version and the rationale behind each block. Kept POSIX-sh-friendly (macOS bash 3.2).
set -u
here="$(cd "$(dirname "$0")" && pwd)"

# venv defaults to .venv next to this script; SIDECAR_VENV_DIR overrides it so a
# versioned-dir install (fs-1) shares one venv across releases.
venv_dir="${SIDECAR_VENV_DIR:-$here/.venv}"
venv_python="$venv_dir/bin/python"
if [ ! -x "$venv_python" ]; then
  echo "Local TTS sidecar venv not found at $venv_python." >&2
  echo "Run the one-time setup first (see server/tts-sidecar/README.md):" >&2
  echo "  cd server/tts-sidecar && python3.11 -m venv .venv && ./.venv/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi

# Source sidecar-relevant keys from server/.env (whitelist COQUI_*, PRELOAD_COQUI,
# LOCAL_TTS_*) without clobbering an explicit shell export. Mirrors start.ps1.
env_file="$(cd "$here/.." && pwd)/.env"
if [ -f "$env_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(printf '%s' "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; \'*\') val="${val#\'}"; val="${val%\'}" ;; esac
    case "$key" in
      COQUI_*|PRELOAD_COQUI|LOCAL_TTS_*)
        eval "cur=\${$key:-}"
        [ -z "$cur" ] && export "$key=$val"
        ;;
    esac
  done < "$env_file"
fi

# Pre-accept the Coqui TOS so the first download doesn't prompt via input()
# (EOFError under non-interactive spawn). Local/personal-use only.
: "${COQUI_TOS_AGREED:=1}"; export COQUI_TOS_AGREED

port="${LOCAL_TTS_PORT:-9000}"
bind_host="${LOCAL_TTS_HOST:-127.0.0.1}"
restart_backoff=2

cd "$here"
while true; do
  "$venv_python" -m uvicorn main:app --host "$bind_host" --port "$port"
  code=$?
  if [ "$code" -eq 42 ] || [ "$code" -eq 43 ]; then
    echo "[supervisor] sidecar exited with code $code - restarting in ${restart_backoff}s."
    sleep "$restart_backoff"
    continue
  fi
  echo "[supervisor] sidecar exited with code $code - not restarting."
  break
done
```

- [ ] **Step 2: Write the failing tests** — extend `server/src/tts/spawn-sidecar.test.ts`. (Match the file's existing harness for injecting `spawnFn`/`probeFn`; the snippet shows intent.)

```ts
it('spawns bash start.sh on non-Windows', async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const fakeSpawn = ((file: string, args: readonly string[]) => {
    calls.push({ file, args });
    const child: any = new EventEmitter();
    child.pid = 4321;
    child.stdout = null; child.stderr = null;
    return child;
  }) as unknown as typeof spawn;
  await spawnSidecar({
    autoStart: true, modelKey: 'kokoro-v1', eagerLoadKokoro: true, eagerLoadQwen: false,
    repoRoot: '/repo', spawnFn: fakeSpawn,
    probeFn: async () => false, // nothing already listening
    platform: 'darwin', // NEW seam — see implementation
    log: () => {}, warn: () => {},
  } as any);
  expect(calls[0].file).toBe('bash');
  expect(calls[0].args[0]).toMatch(/tts-sidecar[\\/]start\.sh$/);
});

it('does not throw when the child emits an error event (bad spawn)', async () => {
  const child: any = new EventEmitter();
  child.pid = 999; child.stdout = null; child.stderr = null;
  const fakeSpawn = (() => child) as unknown as typeof spawn;
  const handle = await spawnSidecar({
    autoStart: true, modelKey: 'kokoro-v1', eagerLoadKokoro: true, eagerLoadQwen: false,
    repoRoot: '/repo', spawnFn: fakeSpawn, probeFn: async () => false,
    platform: 'darwin', log: () => {}, warn: () => {},
  } as any);
  // Emitting 'error' must be swallowed (handler attached), not crash the process.
  expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow();
  expect(handle).not.toBeNull();
});
```

- [ ] **Step 3: Run, verify they fail** — `npm run test:server -- spawn-sidecar`. Expected: FAIL (still spawns `powershell.exe`; no `platform` seam; no error handler).

- [ ] **Step 4a: Add a `platform` seam + platform-aware spawn** — in `SpawnSidecarOpts` add `platform?: NodeJS.Platform;`, default it in `spawnSidecar` (`platform = process.platform`), and replace the `startScript` + spawn block:

```ts
  const isWindows = platform === 'win32';
  const startScript = join(
    repoRoot, 'server', 'tts-sidecar', isWindows ? 'start.ps1' : 'start.sh',
  );
```

```ts
  let child: ChildProcess;
  try {
    child = isWindows
      ? spawnFn('powershell.exe',
          ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', startScript],
          { env, windowsHide: true, stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'] })
      : spawnFn('bash', [startScript],
          // detached → new process group so killTree can reap the uvicorn grandchild.
          { env, windowsHide: true, stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'], detached: true });
  } catch (err) {
    warn('[sidecar] spawn failed:', err);
    return null;
  } finally {
    if (outFd !== null) closeSync(outFd);
    if (errFd !== null) closeSync(errFd);
  }
```

- [ ] **Step 4b: Add the `error` handler with a once-guard** — replace the existing `child.once('exit', …)` block with:

```ts
  let exitNotified = false;
  const notifyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitNotified) return;
    exitNotified = true;
    onExit?.(code, signal);
  };
  /* An async spawn failure (ENOENT: bash/powershell missing) emits 'error', not a
     thrown exception — without this handler it crashes the Node server (the macOS
     boot crash). Swallow it, log once, and route to the supervisor as an exit. */
  child.once('error', (err) => {
    warn('[sidecar] spawn error — TTS will be unavailable:', err);
    notifyExit(null, null);
  });
  child.once('exit', (code, signal) => {
    warn(`[sidecar] child exited (code=${code}, signal=${signal}) at ${formatTimestamp(new Date())}`);
    notifyExit(code, signal);
  });
```

- [ ] **Step 4c: Group-kill on POSIX for our own child** — change `killTree` to take an `ownGroup` flag and pass `true` from the handle:

```ts
function killTree(pid: number, spawnFn: typeof spawn, ownGroup = false): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    } else {
      try {
        // Negative pid = the whole process group (we spawn our child detached),
        // so the bash launcher AND its uvicorn grandchild are reaped together.
        if (ownGroup) process.kill(-pid, 'SIGTERM');
        else process.kill(pid, 'SIGTERM');
      } catch {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      resolve();
    }
  });
}
```

And the returned handle:

```ts
    kill: () => killTree(pid, spawnFn, true),
```

(Leave the stale-replace call `await killTree(stalePid, spawnFn)` at `ownGroup=false` — that PID is a foreign listener, not our group leader.)

- [ ] **Step 5: Run, verify tests pass** — `npm run test:server -- spawn-sidecar`. Expected: PASS. Then full `npm run test:server` to catch supervisor fallout.

- [ ] **Step 6: Commit** — `git commit -am "fix(server): cross-platform sidecar spawn (start.sh) + error handler + posix group-kill"`

---

## Task 5: Cross-platform `npm start` and `tts:sidecar` (by design)

**Why:** `package.json:10,21` make `start` and `tts:sidecar` PowerShell-only. On macOS the user's natural `npm start` / `npm run tts:sidecar` fail with a cryptic `powershell: not found`. Windows behavior must stay byte-identical (delegate to the existing scripts).

**Files:**
- Create: `scripts/launch-sidecar.mjs`, `scripts/start-app.mjs`
- Modify: `package.json` (`start`, `tts:sidecar`)
- Test: `scripts/tests/launch-dispatch.test.mjs` (new, pure-function dispatch assertions)

- [ ] **Step 1: Write the failing test** — create `scripts/tests/launch-dispatch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sidecarCommand } from '../launch-sidecar.mjs';
import { startAppCommand } from '../start-app.mjs';

test('sidecar dispatch: windows uses powershell start.ps1', () => {
  const c = sidecarCommand('win32', '/repo');
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.at(-1).endsWith('start.ps1'));
});
test('sidecar dispatch: posix uses bash start.sh', () => {
  const c = sidecarCommand('darwin', '/repo');
  assert.equal(c.file, 'bash');
  assert.ok(c.args[0].endsWith('start.sh'));
});
test('start-app dispatch: windows uses powershell start-app.ps1', () => {
  const c = startAppCommand('win32', '/repo');
  assert.equal(c.file, 'powershell.exe');
  assert.ok(c.args.at(-1).endsWith('start-app.ps1'));
});
test('start-app dispatch: posix runs the dev stack', () => {
  const c = startAppCommand('linux', '/repo');
  assert.notEqual(c.file, 'powershell.exe'); // npm/concurrently path
});
```

- [ ] **Step 2: Run, verify it fails** — `node --test scripts/tests/launch-dispatch.test.mjs`. Expected: FAIL (modules missing).

- [ ] **Step 3a: Create `scripts/launch-sidecar.mjs`:**

```js
#!/usr/bin/env node
// Cross-platform `npm run tts:sidecar`: Windows → powershell start.ps1,
// POSIX → bash start.sh. Pure `sidecarCommand` is unit-tested.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sidecarCommand(platform, repoRoot) {
  const dir = join(repoRoot, 'server', 'tts-sidecar');
  return platform === 'win32'
    ? { file: 'powershell.exe', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', join(dir, 'start.ps1')] }
    : { file: 'bash', args: [join(dir, 'start.sh')] };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { file, args } = sidecarCommand(process.platform, repoRoot);
  const child = spawn(file, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error('[tts:sidecar] failed to launch:', err.message); process.exit(1); });
}
```

- [ ] **Step 3b: Create `scripts/start-app.mjs`:**

```js
#!/usr/bin/env node
// Cross-platform `npm start` dev launcher. Windows → the proven start-app.ps1
// (unchanged, no regression). POSIX → the dev stack (frontend + server; the
// server spawns the sidecar). Pure `startAppCommand` is unit-tested.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startAppCommand(platform, repoRoot) {
  if (platform === 'win32') {
    return { file: 'powershell.exe', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', join(repoRoot, 'scripts', 'start-app.ps1')] };
  }
  // POSIX: run the same concurrently dev stack `npm run dev` uses. The Node
  // server spawns the TTS sidecar (plan 43); Vite opens the browser.
  return { file: 'npm', args: ['run', 'dev'] };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { file, args } = startAppCommand(process.platform, repoRoot);
  const child = spawn(file, args, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => { console.error('[start] failed to launch:', err.message); process.exit(1); });
}
```

- [ ] **Step 3c: Point package.json at the dispatchers:**

```json
    "start": "node scripts/start-app.mjs",
    "tts:sidecar": "node scripts/launch-sidecar.mjs",
```

- [ ] **Step 4: Run, verify tests pass** — `node --test scripts/tests/launch-dispatch.test.mjs`. Expected: PASS.

- [ ] **Step 5: Smoke the Windows path (authoring box is Windows)** — `npm start` brings the dev stack up exactly as before; Ctrl+C to stop. Confirm no behavior change.

- [ ] **Step 6: Commit** — `git commit -am "feat(scripts): cross-platform npm start + tts:sidecar dispatchers"`

---

## Task 6: Confirm-first the vite "blank page" chunk bug

**Why (decision c):** the original circular `vendor↔react` chunk bug was filed under Rollup's function-form `manualChunks`; we're now on Vite 8 / Rolldown `advancedChunks`, which chunks differently. `npm run test:e2e` runs the **dev** server (`playwright.config.ts:114` → `vite --mode e2e`), so it CANNOT catch a production-build-only chunk bug. We must reproduce on a **built** bundle before changing config.

**Files:**
- Investigate: `dist/**` (built), `vite.config.ts` (only if reproduced)

- [ ] **Step 1: Build** — `npm run build` (in the worktree). Expected: build succeeds.

- [ ] **Step 2: Serve the built bundle** — `npx vite preview --port 4178 --strictPort` (background).

- [ ] **Step 3: Load it in a real browser and check the console** — drive a headless chromium against `http://localhost:4178/` (use the `run-app` skill or a one-off Playwright snippet). Assert: the app root renders (non-empty), and the console has NO `Cannot read properties of undefined (reading 'useLayoutEffect')` / `React is undefined`.

- [ ] **Step 4: Decide:**
  - **If the page renders fine →** no change. Record in the plan's Ship notes: "Rolldown does not reproduce the circular-chunk bug; `vite.config.ts` left unchanged." Stop.
  - **If it reproduces (blank page / React undefined) →** Step 5.

- [ ] **Step 5 (only if reproduced): Patch the react chunk group** — in `vite.config.ts`, extend the `react` group `test` regex to also match `@dnd-kit/` and `@tanstack/` (both import React and otherwise land in `vendor`):

```ts
                test: /node_modules\/(?:react\/|react-dom\/|react-is|react-router|react-redux|scheduler|use-sync-external-store|@reduxjs\/toolkit|redux\/|redux-thunk|redux-persist|immer\/|reselect|hoist-non-react-statics|@dnd-kit\/|@tanstack\/)/,
```

- [ ] **Step 6 (only if reproduced): Re-verify** — `npm run build` then repeat Steps 2–3; assert the page renders. Commit: `git commit -am "fix(build): keep @dnd-kit/@tanstack in the react chunk to avoid circular-chunk blank page"`.

---

## Task 7: macOS install docs

**Why:** ollama persistence across reboots (issue 7) and the device `.env` step is now obsolete (Task 3 auto-detects).

**Files:**
- Modify: `INSTALL.md` (macOS section ~61–91; "Setting up the analyzer" ~190)

- [ ] **Step 1: Add ollama persistence to the macOS analyzer note** — under "Setting up the analyzer" / Option A manual path, add for macOS:

```markdown
   On macOS, register Ollama so it survives reboots: `brew services start ollama`
   (launchd login item — starts on login and after every reboot).
```

- [ ] **Step 2: Add a one-line device note** — in the macOS install section, after step 4, add:

```markdown
> **Apple Silicon TTS device**: no configuration needed — the sidecar auto-detects
> the GPU (`mps`) and falls back to CPU. To force a device, set `QWEN_DEVICE=cpu`
> (or `mps`) in `server/.env`.
```

- [ ] **Step 3: Verify no stale instruction remains** — confirm INSTALL.md does NOT instruct macOS users to set `QWEN_DEVICE=cuda` / `COQUI_DEVICE`. (It currently doesn't; this is a guard.)

- [ ] **Step 4: Commit** — `git commit -am "docs(install): macOS ollama persistence + auto device note"`

---

## Task 8: Integration verify + Mac acceptance checklist

- [ ] **Step 1: Reconcile** — ensure Tasks 1–7 are all on `fix/macos-launch-cross-platform` (merge agent worktrees one at a time if parallel).
- [ ] **Step 2: Full battery** — `npm run verify` (typecheck + all tests + e2e + build). Triage any red per CLAUDE.md (related → fix; pre-existing → surface).
- [ ] **Step 3: Author the tester checklist** (paste into PR body / hand to tester):
  1. Fresh extract of the new zip on Apple Silicon.
  2. `npm ci && npm --prefix server ci` → clean.
  3. `cd server/tts-sidecar && python3.11 -m venv .venv && ./.venv/bin/python -m pip install -r requirements.txt` → **succeeds** (no onnxruntime-gpu error).
  4. `npm run start:prod` → server stays up (no `spawn powershell.exe ENOENT` crash in `logs/server.err.log`).
  5. Open `http://localhost:8080` → app renders (not blank).
  6. Run an analysis on a chapter → no `ENOENT … skills/…`.
  7. Generate a chapter (Kokoro default) → audio produced; if Qwen installed, `/load` succeeds on `mps`/`cpu` (no "Torch not compiled with CUDA").
  8. `npm start` and `npm run tts:sidecar` run without `powershell: not found`.
- [ ] **Step 4: Open the PR as a draft**, fill Summary + Test plan, link this plan; `gh pr ready` only after local `verify` is green (CI-cost default).

---

## Self-Review (against the tester notes + this session's findings)

- **Issue 1 (onnxruntime)** → Task 2 ✓
- **Issue 2 (powershell spawn)** → Task 4 ✓ (incl. the missing `error` handler = the actual crash)
- **Issue 3 (blank page)** → Task 6 (confirm-first per decision c) ✓
- **Issue 4 (no CUDA)** → Task 3 (Qwen only; Coqui already auto) ✓
- **Issue 5 (skills/ missing)** → Task 1 ✓
- **Issue 6 (ollama model)** → already shipped (INSTALL Option A); no task needed ✓
- **Issue 7 (ollama persistence)** → Task 7 ✓
- **Cross-platform `npm start`/`tts:sidecar`** (decision b) → Task 5 ✓
- **Placeholder scan:** none — every code step carries real code.
- **Type/name consistency:** `platform` seam name reused across Task 4/5; `_resolve_torch_device` signature identical in resolver + test; `sidecarCommand`/`startAppCommand` exports match their tests.
- **Coverage gap check:** none of the 7 notes is unaddressed.

## Ship notes

Implemented 2026-06-10 on branch `fix/macos-launch-cross-platform` (worktree, off `main` @ 25154763), via sequential subagent-driven development with controller review per task. Commits:

- Task 1 — `9e01b501` ship `skills/**` in release zip (+ manifest test)
- Task 2 — `35ed648f` onnxruntime via `kokoro-onnx[gpu]` (+ requirements test)
- Task 3 — `7704b6f5` Qwen device auto-detect (main.py + registry + .env.example + pytest); **`c1212fb6`** follow-up fix — controller review caught that `design_voice` loads VoiceDesign **before** base, so the device must be resolved on the design-first path too (shared `_ensure_device_resolved()` helper + regression test).
- Task 4 — `2a282c2d` cross-platform sidecar spawn (`start.sh` + platform branch + `error` handler + POSIX group-kill); full server suite green (2372 passed).
- Task 5 — `488fb768` cross-platform `npm start` / `tts:sidecar` dispatchers (Windows path byte-identical).
- Task 6 — **no change.** Confirmed on a BUILT bundle (`vite build` + `vite preview` + headless chromium): page renders (`#root` len 9647), `react` chunk separate from `vendor`, zero `useLayoutEffect`/React-undefined errors. The Rollup-era circular-chunk blank-page bug does **not** reproduce under Vite 8 / Rolldown `advancedChunks`. Decision (c) honored — no speculative `vite.config.ts` edit.
- Task 7 — `66d1f579` macOS install docs (ollama `brew services` persistence + auto-device note).

**Verification:** full `npm run verify` GREEN end-to-end (lint, typecheck, config:check, test:hooks, frontend unit 2563, server 2418, server-slow, scripts, sidecar, e2e 165 passed, visual 13 passed, build). Two transient failures along the way were environmental, not code: (1) a `test:server` vitest worker-fork flake that cleared on retry; (2) e2e `ERR_CONNECTION_REFUSED` from a concurrent session holding port 5174 — cleared by running e2e isolated (`CI=1 PLAYWRIGHT_PORT=5203`, `workers:1`). (Note: `prettier --check` flags ~1281 files repo-wide due to Windows CRLF and is NOT part of `verify` — eslint is the style gate.) **macOS runtime acceptance: still owed — see the tester checklist (Task 8).**
