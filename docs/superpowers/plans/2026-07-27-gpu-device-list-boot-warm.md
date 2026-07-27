# Deterministic sidecar device env + codec knob parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sidecar's device env deterministic — always the raw `cuda-uuid:` literal, which the sidecar resolves live on every spawn — and make the Qwen codec knob honour a UUID pin.

**Architecture:** Two independent tasks. Task 1 is Node/TypeScript: a second resolver entry point that skips device-UUID reconciliation, used only by `buildSidecarEnv`. Task 2 is the Python sidecar: a named `_codec_device_pref()` helper with a `cpu` fallback. Neither depends on the other; either can land alone.

**Tech Stack:** TypeScript (Node/Express, ESM, `.js` import specifiers), Vitest; Python 3.12 + FastAPI sidecar, pytest.

**Spec:** `docs/superpowers/specs/2026-07-27-gpu-device-list-boot-warm-design.md`

## Global Constraints

- Worktree: `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\fix+1857-gpu-device-cache-boot-warm`, branch `fix/1857-gpu-device-cache-boot-warm`. Run every command from there; never `cd` to the main checkout.
- Server imports use ESM `.js` specifiers even for TypeScript sources.
- Server tests: `npm --prefix server run test -- <path>` from the worktree root, where `<path>` is relative to `server/` (e.g. `src/config/resolver.test.ts`). `server/vitest.config.ts` has `include: src/**` resolved against cwd, so `npx vitest --config server/vitest.config.ts server/src/…` from the root matches the *frontend* tree and exits "No test files found".
- Sidecar tests: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/<file> -v`.
- Commit messages follow Conventional Commits with a scope. Every commit body ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
  ```
- No task requires a GPU.

## File Structure

| File | Responsibility |
|---|---|
| `server/src/config/resolver.ts` (modify) | Gains `resolveKnobForSidecarEnv`, sharing one implementation with `resolveKnob`. |
| `server/src/config/resolver.test.ts` (modify) | Pins that the two entry points diverge exactly on the device-UUID branch. |
| `server/src/tts/spawn-sidecar.ts` (modify) | `buildSidecarEnv` switches to the non-reconciling resolver. |
| `server/src/tts/sidecar-env.test.ts` (modify) | Pins the emitted env under warm **and** cold caches. |
| `server/tts-sidecar/main.py` (modify) | Adds `_codec_device_pref()`; routes the codec read through it. |
| `server/tts-sidecar/tests/test_device_parse.py` (modify) | Pins codec UUID resolution and the `cpu` fallback. |

---

### Task 1: Deterministic sidecar device env

Today `buildSidecarEnv` reads through `resolveKnob`, which translates a stored
`cuda-uuid:` override to `cuda:N` **only when the device cache happens to be
warm** — i.e. only if someone opened Advanced settings this server session. The
warm branch freezes an index that `buildOpts` then re-emits on every respawn
(`sidecar-supervisor.ts:234`), so a card that vanishes or renumbers afterwards
yields a hard `_validate_cuda_index` failure or a silently wrong card. The cold
branch hands over the UUID, which the sidecar resolves live and degrades safely.
Make the safe branch unconditional.

**Files:**
- Modify: `server/src/config/resolver.ts:15-53`
- Modify: `server/src/config/resolver.test.ts` (append to the existing device-UUID describe at :75-95)
- Modify: `server/src/tts/spawn-sidecar.ts:474`
- Modify: `server/src/tts/sidecar-env.test.ts`

**Interfaces:**
- Produces: `resolveKnobForSidecarEnv(knob: ConfigKnob): KnobValueState` — same shape as `resolveKnob`, never sets `staleReason`, never rewrites a `cuda-uuid:` override.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('resolveKnob — device UUID reconcile …')` block in `server/src/config/resolver.test.ts`, and add `resolveKnobForSidecarEnv` to the import on line 11:

```ts
describe('resolveKnobForSidecarEnv — deliberately does NOT reconcile', () => {
  beforeEach(() => {
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
  });

  /* #1857 B1 — the sidecar resolves 'cuda-uuid:' itself against LIVE
     enumeration on every spawn (main.py:1873 _read_device_env). Handing it a
     pre-translated index instead freezes a mapping that a respawn can no longer
     correct. So this entry point must emit the uuid form even when the cache
     could translate it. */
  it('passes a cuda-uuid override through even when the card IS visible', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GPU-1' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([{ uuid: 'GPU-1', idx: 1 }]);
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda-uuid:GPU-1');
    expect(st.staleReason).toBeUndefined();
  });

  it('passes a cuda-uuid override through when no card matches, WITHOUT flagging stale', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda-uuid:GONE' });
    (gds.getLastKnownGpuDevices as any).mockReturnValue([]);
    const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
    expect(st.effective).toBe('cuda-uuid:GONE');
    // staleReason is a UI concept; the sidecar decides liveness for itself.
    expect(st.staleReason).toBeUndefined();
  });

  it('is identical to resolveKnob for every non-device-uuid value', () => {
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.qwen.device': 'cuda:1' });
    const knob = getKnob('tts.qwen.device')!;
    expect(resolveKnobForSidecarEnv(knob)).toEqual(resolveKnob(knob));
  });

  it('still honours an env-locked value', () => {
    process.env.QWEN_DEVICE = 'cpu';
    try {
      const st = resolveKnobForSidecarEnv(getKnob('tts.qwen.device')!);
      expect(st.effective).toBe('cpu');
      expect(st.source).toBe('env');
      expect(st.locked).toBe(true);
    } finally {
      delete process.env.QWEN_DEVICE;
    }
  });
});
```

Append to `server/src/tts/sidecar-env.test.ts`:

```ts
import {
  setLastKnownGpuDevices,
  getLastKnownGpuDevices,
} from '../gpu/gpu-device-list-state.js';

describe('buildSidecarEnv hands the sidecar a UUID pin verbatim', () => {
  beforeEach(() => {
    setLastKnownGpuDevices([]);
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
    delete process.env.QWEN_DEVICE;
  });

  /* Both cases must agree. Before #1857 the emitted value depended on whether
     the user had opened Advanced settings during this server session — the warm
     branch froze a cuda:N that every later respawn re-emitted, so a vanished or
     renumbered card produced a hard load failure or the wrong card. */
  for (const [label, cache] of [
    ['cold cache', [] as { uuid: string; idx: number }[]],
    ['warm cache', [{ uuid: 'GPU-1', idx: 1 }]],
  ] as const) {
    it(`emits the raw cuda-uuid literal with a ${label}`, () => {
      (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
        'tts.qwen.device': 'cuda-uuid:GPU-1',
      });
      setLastKnownGpuDevices([...cache]);

      const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });

      expect(env.QWEN_DEVICE).toBe('cuda-uuid:GPU-1');
    });
  }

  it('still emits a plain cuda:N pin unchanged', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.qwen.device': 'cuda:1',
    });
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.QWEN_DEVICE).toBe('cuda:1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix server run test -- src/config/resolver.test.ts src/tts/sidecar-env.test.ts`
Expected: FAIL. The resolver tests fail with `resolveKnobForSidecarEnv is not a function`. The `warm cache` case in `sidecar-env.test.ts` fails with `expected 'cuda:1' to be 'cuda-uuid:GPU-1'` — that one is the B1 regression test and **must** be red before the fix.

- [ ] **Step 3: Split the resolver**

In `server/src/config/resolver.ts`, replace `resolveKnob` (lines 15-53) with a shared implementation plus two entry points:

```ts
function resolveKnobInner(knob: ConfigKnob, reconcileDeviceUuid: boolean): KnobValueState {
  if (knob.env) {
    const raw = process.env[knob.env];
    if (raw != null && raw.trim() !== '') {
      const v = parseEnv(knob, raw);
      if (v != null) {
        return { key: knob.key, effective: v, source: 'env', locked: true, overridden: false };
      }
      const warnKey = `${knob.env}=${raw}`;
      if (!warnedInvalidEnv.has(warnKey)) {
        warnedInvalidEnv.add(warnKey);
        console.warn(
          `[config] ${knob.env}="${raw}" is not a valid ${knob.type} for ${knob.key} — ignoring env, falling through to override/default.`,
        );
      }
    }
  }
  const overrides = readConfigOverrides();
  if (Object.prototype.hasOwnProperty.call(overrides, knob.key)) {
    const raw = overrides[knob.key];
    if (
      reconcileDeviceUuid &&
      knob.type === 'device' &&
      typeof raw === 'string' &&
      raw.startsWith('cuda-uuid:')
    ) {
      const uuid = raw.slice('cuda-uuid:'.length);
      const card = getLastKnownGpuDevices().find((d) => d.uuid === uuid);
      if (card) {
        return { key: knob.key, effective: `cuda:${card.idx}`, source: 'override', locked: false, overridden: true };
      }
      return {
        key: knob.key,
        effective: raw,
        source: 'override',
        locked: false,
        overridden: true,
        staleReason: 'uuid_unresolved',
      };
    }
    return { key: knob.key, effective: raw, source: 'override', locked: false, overridden: true };
  }
  return { key: knob.key, effective: knob.default, source: 'default', locked: false, overridden: false };
}

/** Effective value for a READ SITE or the Advanced UI. Reconciles a stored
    'cuda-uuid:<uuid>' override against the last-known device list, so the UI can
    show a concrete card and flag a vanished one as staleReason:'uuid_unresolved'. */
export function resolveKnob(knob: ConfigKnob): KnobValueState {
  return resolveKnobInner(knob, true);
}

/** Effective value for the SIDECAR ENV. Deliberately does NOT reconcile a
    'cuda-uuid:' override to an index (#1857).

    The sidecar resolves the uuid form itself, against LIVE torch enumeration, on
    every spawn — `_read_device_env` -> `_resolve_uuid_to_index`, main.py:1873.
    Handing it a pre-translated `cuda:N` instead freezes whatever the Node cache
    believed at translation time, and `buildOpts` re-emits that frozen value on
    every respawn (sidecar-supervisor.ts). A card that then vanishes makes
    `_validate_cuda_index` raise and the engine load fail on every retry; a card
    that renumbers silently lands on the wrong one. Passing the uuid through
    keeps the sidecar's live resolution in charge, which degrades a vanished pin
    to 'auto' with a warning instead.

    It also makes the spawn env DETERMINISTIC: before this split, the emitted
    value depended on whether the device cache happened to be warm, i.e. on
    whether the user had opened Advanced settings during this server session. */
export function resolveKnobForSidecarEnv(knob: ConfigKnob): KnobValueState {
  return resolveKnobInner(knob, false);
}
```

- [ ] **Step 4: Point `buildSidecarEnv` at it**

In `server/src/tts/spawn-sidecar.ts`, update the import and line 474:

```ts
// import: was  import { resolveKnob } from '../config/resolver.js';
import { resolveKnobForSidecarEnv } from '../config/resolver.js';

// line 474, inside the restart-sidecar knob loop — was: const st = resolveKnob(knob);
const st = resolveKnobForSidecarEnv(knob);
```

**Keep the `resolveKnob` import — do NOT find-replace.** `spawn-sidecar.ts` has
**three** `resolveKnob` call sites and only line 474 changes:

| Line | Function | Knobs | Change? |
|---|---|---|---|
| 119 | `expectedSidecarCeilings` | `sidecar.restartMb`, `sidecar.vramRestartMb` | **no** |
| 136 | `expectedFreeFloorMb` | `sidecar.vramFreeFloorMb` | **no** |
| 474 | `buildSidecarEnv` loop | all restart-sidecar knobs | **yes** |

The two ceiling helpers feed `sidecarCeilingMismatch`, which drives
adopt-versus-recycle decisions. Their knobs are numeric, so the split is
behaviourally identical for them — meaning a careless find-replace would change
the declared intent of that code and **no test would catch it**. The import line
must end up as:

```ts
import { resolveKnob, resolveKnobForSidecarEnv } from '../config/resolver.js';
```

Then extend the docblock above the loop (`spawn-sidecar.ts:462-471`) with a fourth paragraph:

```ts
     Device knobs go through resolveKnobForSidecarEnv, NOT resolveKnob: a
     'cuda-uuid:' pin is handed to the sidecar verbatim so it resolves against
     live enumeration on every spawn. See that function's docblock (#1857).
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix server run test -- src/config/resolver.test.ts src/tts/sidecar-env.test.ts`
Expected: PASS, including the pre-existing `resolveKnob` reconcile tests at `resolver.test.ts:79-94` — those pin the UI path and must be untouched by this split.

- [ ] **Step 6: Run the wider suites that read device knobs**

Run: `npm --prefix server run test -- src/config src/tts/spawn-windows-hide.test.ts src/routes/config.test.ts src/gpu`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/config/resolver.ts server/src/config/resolver.test.ts server/src/tts/spawn-sidecar.ts server/src/tts/sidecar-env.test.ts
git commit -F - <<'EOF'
fix(server): hand the sidecar a device UUID pin verbatim

buildSidecarEnv resolved device knobs through resolveKnob, which
translates a stored cuda-uuid: override to cuda:N only when the GPU
device cache is warm — i.e. only if Advanced settings had been opened
this session. Same config, two different spawn envs, and the warm one
froze an index that every respawn re-emitted: a card that vanished
afterwards failed _validate_cuda_index on every retry, and one that
renumbered landed on the wrong card silently.

Adds resolveKnobForSidecarEnv, which skips the reconcile. The sidecar
resolves the uuid itself against live enumeration on every spawn and
degrades a vanished pin to auto with a warning. The UI path keeps its
translation and its uuid_unresolved badge.

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

### Task 2: `QWEN_CODEC_DEVICE` resolves a UUID pin

Independent of Task 1. `tts.qwen.codecDevice` is the fourth and only
`type: 'device'` knob whose env var is read with a bare `os.environ.get`, so a
card pinned from the UI is stored as `cuda-uuid:<uuid>`, passes
`_validate_cuda_index` (because `_parse_device` reads it as family `cuda` with no
index), then fails inside torch's `.to()` and is rolled back to CPU.

**Files:**
- Modify: `server/tts-sidecar/main.py` — add helper after `_resolve_codec_device` (ends line 403); change the call site currently at 2995-2997
- Modify: `server/tts-sidecar/tests/test_device_parse.py`

- [ ] **Step 1: Write the failing test**

Append to `server/tts-sidecar/tests/test_device_parse.py`:

```python
def test_codec_device_pref_resolves_uuid(monkeypatch):
    """QWEN_CODEC_DEVICE is a type:'device' knob, so a card picked in Advanced
    Settings is persisted as 'cuda-uuid:<uuid>'. _codec_device_pref is what
    _load_qwen_model calls, so a UUID must never reach torch raw."""
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda-uuid:GPU-1")
    monkeypatch.setattr(main, "_enumerate_cuda_devices",
        lambda tm=None: [{"uuid": "GPU-1", "idx": 1, "name": "x", "total_mb": 16000, "free_mb": 14000}])
    assert main._codec_device_pref() == "cuda:1"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") == "cuda:1"


def test_codec_device_pref_vanished_uuid_falls_back_to_cpu(monkeypatch):
    """A vanished card must NOT degrade to 'auto' -- for the codec that means
    "follow the model", i.e. move onto the very card the user was spreading VRAM
    away from. cpu is the knob's registry default and is VRAM-neutral."""
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda-uuid:GONE")
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [])
    assert main._codec_device_pref() == "cpu"
    # _resolve_codec_device('cpu', ...) is None == "leave the codec where it is"
    assert main._resolve_codec_device(main._codec_device_pref(), "cuda:0") is None


def test_codec_device_pref_unset_and_empty_mean_cpu(monkeypatch):
    monkeypatch.delenv("QWEN_CODEC_DEVICE", raising=False)
    assert main._codec_device_pref() == "cpu"
    monkeypatch.setenv("QWEN_CODEC_DEVICE", "   ")
    assert main._codec_device_pref() == "cpu"


def test_codec_device_pref_passes_through_plain_values(monkeypatch):
    """cpu / auto / cuda:N are unchanged -- no behaviour change for any value
    that already worked."""
    for raw, expected in (("cpu", "cpu"), ("auto", "auto"), ("cuda:1", "cuda:1")):
        monkeypatch.setenv("QWEN_CODEC_DEVICE", raw)
        assert main._codec_device_pref() == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_device_parse.py -v -k codec_device_pref`
Expected: all four FAIL with `AttributeError: module 'main' has no attribute '_codec_device_pref'`.

- [ ] **Step 3: Add the helper**

In `server/tts-sidecar/main.py`, immediately after `_resolve_codec_device` (which
ends at line 403):

```python
def _codec_device_pref() -> str:
    """QWEN_CODEC_DEVICE as a resolved device string, defaulting to 'cpu'.

    QWEN_CODEC_DEVICE is a type:'device' knob, so PUT /api/config persists a
    picked card as 'cuda-uuid:<uuid>'. A bare os.environ.get (the #1857 bug) let
    that literal through _validate_cuda_index untouched -- _parse_device reads
    'cuda-uuid:x' as family cuda with NO index, and the range check only fires on
    a concrete index -- so it failed later inside torch's .to() in
    _move_codec_to_device and got rolled back to CPU.

    Deliberately NOT _read_device_env: that degrades an unresolvable pin to
    'auto', which is right for the three engine knobs but wrong here.
    _resolve_codec_device('auto', model_device) means "follow the model", so a
    vanished card would silently move the codec ONTO the model's card -- adding
    pressure to exactly the card a user pinning the codec elsewhere was trying to
    protect, with no rollback (that only fires if .to() raises, not if a
    successful move OOMs a later decode). 'cpu' is this knob's registry default
    and is VRAM-neutral.

    Named rather than inlined so it is reachable from tests: the call site is
    inside _load_qwen_model, which needs real weights and a GPU.
    """
    raw = os.environ.get("QWEN_CODEC_DEVICE")
    if not raw or not raw.strip():
        return "cpu"
    resolved = _resolve_uuid_to_index(raw)
    if resolved is None:
        log.warning(
            "QWEN_CODEC_DEVICE=%s did not match any visible GPU -- leaving the codec on cpu.",
            raw,
        )
        return "cpu"
    return resolved
```

- [ ] **Step 4: Route the production read through it**

Find the call site by content — it is around line 2995 *before* the helper is
inserted and shifts down by the helper's length afterwards, so do not go by line
number:

```python
        # BEFORE (find this):
        codec_device = _resolve_codec_device(
            os.environ.get("QWEN_CODEC_DEVICE", "cpu"), self._device
        )

        # AFTER:
        codec_device = _resolve_codec_device(_codec_device_pref(), self._device)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_device_parse.py -v`
Expected: PASS, all tests in the file.

Run: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_module_import_order.py -v`
Expected: PASS. `_codec_device_pref` is defined at ~404 but calls `_resolve_uuid_to_index` (1858) — safe, because Python resolves names at call time and the only caller is `_load_qwen_model`, which is never reached at module import. This file guards that class of NameError, so run it.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py
git commit -F - <<'EOF'
fix(sidecar): resolve a cuda-uuid: pin for QWEN_CODEC_DEVICE

The one type:'device' knob still read with a bare os.environ.get. A
pinned card reached torch as a raw 'cuda-uuid:' literal, passed
_validate_cuda_index (which no-ops when _parse_device finds no concrete
index), then failed inside .to() and rolled back to CPU.

An unresolvable pin falls back to cpu rather than _read_device_env's
'auto' — for the codec, 'auto' means follow the model, which would move
it onto the card a user pinning the codec elsewhere was protecting.

Refs #1857

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01VxtGhVyXqmikbXSpsvuEmg
EOF
```

---

## Final verification

- [ ] Full server suite: `npm run test:server`
- [ ] Typecheck: `npm run typecheck` (root `tsc --noEmit` **and** `npm --prefix server run typecheck`)
- [ ] Sidecar: `server/tts-sidecar/.venv/Scripts/python.exe -m pytest server/tts-sidecar/tests/test_device_parse.py server/tts-sidecar/tests/test_module_import_order.py -v`
- [ ] Confirm no other caller was switched by accident: `grep -rn "resolveKnobForSidecarEnv" server/src` should return the resolver definition, its tests, and exactly one call site in `spawn-sidecar.ts`.
- [ ] Open PR with `Closes #1857` in the body, carrying the premise correction: the sidecar already resolves `cuda-uuid:` for the three engine knobs, the raw literal is the designed input rather than the bug, and the issue's suggested boot warm would have made respawns worse. Link the two Fable review findings that drove the rescope.
