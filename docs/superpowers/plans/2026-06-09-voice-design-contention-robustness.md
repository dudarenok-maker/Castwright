# Voice-Design Contention Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a voice design from spilling VRAM / falsely showing "Halted" / freezing its progress bar when it coincides with chapter generation on the 8 GB GPU.

**Architecture:** Three independent parts, each on its own test harness, all on branch `fix/voice-design-contention-robustness`. **C (root, sidecar/Python):** a VoiceDesign forward and a Kokoro synth become mutually exclusive, and a design evicts a resident Kokoro before loading the 1.7 B model — so the three-way (generation + VoiceDesign + Kokoro) >8 GB spill can't happen. **B (server/TypeScript):** the design's 180 s wall-clock abort becomes liveness-aware — it only gives up when the sidecar's `/health` is unreachable, bounded by a 10 min ceiling. **A (frontend/React):** the design progress indicator shows a ticking elapsed clock, flips to an indeterminate shimmer past the fast window, and swaps "about 15s" for an honest "GPU may be busy" message — so it never looks frozen.

**Tech Stack:** Python (FastAPI sidecar, pytest), Node/Express + TypeScript (Vitest), React 18 + TypeScript (Vitest + RTL, Playwright).

**Spec:** `docs/superpowers/specs/2026-06-09-voice-design-contention-robustness-design.md`

**Note on independence:** C, B, and A do not depend on each other and can be implemented/committed in any order (or in parallel by separate agents). C is the highest-value (root cause). Each part is independently shippable and testable.

---

## Part C — VoiceDesign ↔ Kokoro mutual exclusion (sidecar)

**Why:** A model stays resident in VRAM after releasing its GPU-semaphore token. Qwen Base + active generation ≈ 3.5 GB; + VoiceDesign ≈ 6 GB (fits); + **Kokoro resident during generation** → >8 GB → spill → recycle. Kokoro runs on onnxruntime-gpu (a separate allocator from torch), so its ~1 GB is invisible to torch metrics but real on the card. Fix: never let a VoiceDesign forward and a Kokoro synth overlap, and evict a resident Kokoro for the duration of a design.

### Task C1: Add the VoiceDesign↔Kokoro arbiter primitive

**Files:**
- Modify: `server/tts-sidecar/main.py` (add a module-level arbiter class + singleton, near the other module-level engine globals)
- Test: `server/tts-sidecar/tests/test_design_kokoro_exclusion.py` (create)

- [ ] **Step 1: Write the failing test for the arbiter's exclusion contract**

Create `server/tts-sidecar/tests/test_design_kokoro_exclusion.py`:

```python
"""Unit tests for the VoiceDesign<->Kokoro arbiter (resident-VRAM exclusion).

The arbiter guarantees a VoiceDesign forward and Kokoro synths never overlap,
while letting Kokoro synths run concurrently with each other when no design is
active. See docs/.../2026-06-09-voice-design-contention-robustness-design.md.
"""
import threading
import time

from main import _VdKokoroArbiter


def test_design_waits_for_in_flight_kokoro_to_drain():
    arb = _VdKokoroArbiter()
    order = []
    started = threading.Event()

    def kokoro():
        with arb.kokoro_synth():
            started.set()
            time.sleep(0.05)
            order.append("kokoro-done")

    def design():
        started.wait()
        with arb.design():
            order.append("design-start")

    t1 = threading.Thread(target=kokoro)
    t2 = threading.Thread(target=design)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # The design must not start until the in-flight Kokoro synth finished.
    assert order == ["kokoro-done", "design-start"]


def test_kokoro_blocks_while_design_active():
    arb = _VdKokoroArbiter()
    order = []
    design_holding = threading.Event()
    release_design = threading.Event()

    def design():
        with arb.design():
            design_holding.set()
            release_design.wait(timeout=1)
            order.append("design-done")

    def kokoro():
        design_holding.wait()
        with arb.kokoro_synth():
            order.append("kokoro-start")

    t1 = threading.Thread(target=design)
    t2 = threading.Thread(target=kokoro)
    t1.start()
    t2.start()
    time.sleep(0.05)  # give kokoro a chance to (wrongly) proceed if unguarded
    release_design.set()
    t1.join()
    t2.join()

    # Kokoro must not start until the design released.
    assert order == ["design-done", "kokoro-start"]


def test_two_kokoro_synths_run_concurrently_when_no_design():
    arb = _VdKokoroArbiter()
    both_in = threading.Barrier(2, timeout=1)

    def kokoro():
        with arb.kokoro_synth():
            both_in.wait()  # raises BrokenBarrierError if they can't co-exist

    t1 = threading.Thread(target=kokoro)
    t2 = threading.Thread(target=kokoro)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    # No assertion needed — the barrier proves concurrency (no timeout/raise).
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_design_kokoro_exclusion.py -v`
Expected: FAIL — `ImportError: cannot import name '_VdKokoroArbiter' from 'main'`.

- [ ] **Step 3: Implement the arbiter**

In `server/tts-sidecar/main.py`, add near the top-level imports if missing:

```python
from contextlib import contextmanager
```

Add the arbiter class + singleton at module scope, BEFORE the `kokoro = KokoroEngine()` / `qwen = QwenEngine()` singletons are constructed (so both engines can reference `_VD_KOKORO`):

```python
class _VdKokoroArbiter:
    """Mutual exclusion between a VoiceDesign forward and Kokoro synths.

    Kokoro runs on onnxruntime-gpu (a separate allocator from torch), so a
    resident Kokoro + Qwen Base + the 1.7B VoiceDesign model oversubscribe an
    8 GB card and spill. This arbiter guarantees the two heaviest-combined ops
    never co-reside: a design waits for in-flight Kokoro synths to drain, then
    blocks new ones until it finishes. Kokoro synths still run concurrently with
    EACH OTHER (writer-priority readers/writer), so normal generation is
    unaffected when no design is running. Qwen Base generation never touches this
    arbiter, so a Qwen-voiced chapter generates at full speed alongside a design.
    """

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._kokoro_in_flight = 0
        self._design_active = False

    @contextmanager
    def kokoro_synth(self):
        with self._cv:
            while self._design_active:
                self._cv.wait()
            self._kokoro_in_flight += 1
        try:
            yield
        finally:
            with self._cv:
                self._kokoro_in_flight -= 1
                self._cv.notify_all()

    @contextmanager
    def design(self):
        with self._cv:
            while self._kokoro_in_flight > 0:
                self._cv.wait()
            self._design_active = True
        try:
            yield
        finally:
            with self._cv:
                self._design_active = False
                self._cv.notify_all()


_VD_KOKORO = _VdKokoroArbiter()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_design_kokoro_exclusion.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_kokoro_exclusion.py
git commit -m "feat(sidecar): add VoiceDesign<->Kokoro VRAM exclusion arbiter"
```

### Task C2: Guard the Kokoro synth path with the arbiter

**Files:**
- Modify: `server/tts-sidecar/main.py` — `KokoroEngine.synthesize` (currently ~line 782)
- Test: `server/tts-sidecar/tests/test_design_kokoro_exclusion.py` (extend)

- [ ] **Step 1: Write the failing integration test**

Append to `server/tts-sidecar/tests/test_design_kokoro_exclusion.py`:

```python
def test_kokoro_synthesize_acquires_the_arbiter(monkeypatch):
    """KokoroEngine.synthesize must run its load+create under the arbiter so a
    concurrent design can't start mid-synth."""
    import main

    eng = main.KokoroEngine()
    seen = {"in_flight_during_create": None}

    # Stub the heavy model so the test never loads real weights.
    class _FakeModel:
        def create(self, text, voice, speed, lang):
            # Snapshot the arbiter's in-flight counter DURING create().
            seen["in_flight_during_create"] = main._VD_KOKORO._kokoro_in_flight
            import numpy as np
            return np.zeros(10, dtype="float32"), 24000

    eng._kokoro = _FakeModel()
    eng._voices = ["af_heart"]
    monkeypatch.setattr(eng, "_ensure_loaded", lambda model: None)

    eng.synthesize("kokoro", "af_heart", "hello")
    # If synthesize wrapped create() in arb.kokoro_synth(), the counter was 1.
    assert seen["in_flight_during_create"] == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_design_kokoro_exclusion.py::test_kokoro_synthesize_acquires_the_arbiter -v`
Expected: FAIL — `assert None == 1` (create ran outside the arbiter).

- [ ] **Step 3: Wrap the Kokoro synth body in the arbiter**

In `KokoroEngine.synthesize`, wrap the load + create in `with _VD_KOKORO.kokoro_synth():`. The method currently starts:

```python
    def synthesize(self, model: str, voice: str, text: str) -> SynthResult:
        self._ensure_loaded(model)
        assert self._kokoro is not None
```

Change it so everything from `_ensure_loaded` through the `self._kokoro.create(...)` call runs inside the arbiter. Minimal-diff approach — wrap the existing body:

```python
    def synthesize(self, model: str, voice: str, text: str) -> SynthResult:
        # Resident-VRAM exclusion: never let this Kokoro forward overlap a
        # VoiceDesign forward (the three-way spill). Acquired around load+create
        # so a design can't evict Kokoro out from under an in-flight synth.
        with _VD_KOKORO.kokoro_synth():
            self._ensure_loaded(model)
            assert self._kokoro is not None
            # ... existing body unchanged (voice validation, create(), wrap) ...
```

Re-indent the remainder of the existing method body one level deeper under the `with`. Do NOT change any logic inside.

- [ ] **Step 4: Run the focused + full exclusion test file**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_design_kokoro_exclusion.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the existing Kokoro test to confirm no regression**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_kokoro.py -v`
Expected: PASS (unchanged).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_kokoro_exclusion.py
git commit -m "feat(sidecar): run Kokoro synth under the VoiceDesign exclusion arbiter"
```

### Task C3: Hold the arbiter + evict Kokoro during a VoiceDesign forward

**Files:**
- Modify: `server/tts-sidecar/main.py` — `QwenEngine.design_voice` (currently ~line 1276)
- Test: `server/tts-sidecar/tests/test_design_kokoro_exclusion.py` (extend)

- [ ] **Step 1: Write the failing test for design-time eviction + exclusion**

Append to `server/tts-sidecar/tests/test_design_kokoro_exclusion.py`:

```python
def test_design_voice_holds_arbiter_and_evicts_resident_kokoro(monkeypatch):
    """design_voice must take arb.design() around its VoiceDesign forward and,
    if Kokoro is resident, unload it first so the 1.7B load has headroom."""
    import main

    qeng = main.QwenEngine()

    # Pretend Kokoro is resident (e.g. a mixed-cast generation loaded it).
    main.kokoro._kokoro = object()
    unloaded = {"called": False}
    monkeypatch.setattr(main.kokoro, "unload",
                        lambda: unloaded.__setitem__("called", True))

    # Capture arbiter state at the moment the VoiceDesign forward runs.
    captured = {"design_active": None, "kokoro_resident": None}

    class _FakeDesign:
        def generate_voice_design(self, text, language, instruct):
            captured["design_active"] = main._VD_KOKORO._design_active
            captured["kokoro_resident"] = main.kokoro._kokoro is not None
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    qeng._design = _FakeDesign()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_design_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    monkeypatch.setattr(main.torch, "save", lambda *a, **k: None, raising=False)

    import tempfile
    qeng._voices_dir = tempfile.mkdtemp()

    qeng.design_voice("qwen-narrator-preview", "A warm voice.", "english", "Hello there.")

    assert unloaded["called"] is True, "resident Kokoro must be evicted before the design"
    assert captured["design_active"] is True, "design forward must run under arb.design()"
    assert captured["kokoro_resident"] is False, "Kokoro must be unloaded during the design forward"
```

NOTE: if `import main.torch` indirection differs (torch is imported lazily inside `design_voice`), adjust the `torch.save` monkeypatch to patch `torch.save` on the module torch object the function imports. The function does `import torch` then `torch.save(...)`; patch via `monkeypatch.setattr("torch.save", lambda *a, **k: None)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_design_kokoro_exclusion.py::test_design_voice_holds_arbiter_and_evicts_resident_kokoro -v`
Expected: FAIL — `unloaded["called"] is False` / `design_active is None`.

- [ ] **Step 3: Wrap the VoiceDesign forward in `arb.design()` + evict Kokoro**

In `QwenEngine.design_voice`, the in-flight guard + ensure + `_synth_lock` forward currently looks like (around line 1306):

```python
        self._design_last_used = time.monotonic()
        self._design_in_flight += 1
        try:
            self._ensure_design_loaded()
            self._ensure_base_loaded()
            with self._synth_lock:
                self._ensure_design_loaded()
                self._ensure_base_loaded()
                ref_wavs, ref_sr = self._design.generate_voice_design(
                    text=ref_text, language=lang, instruct=instruct
                )
                ref_audio = ref_wavs[0]
                prompt = self._base.create_voice_clone_prompt(
                    ref_audio=(ref_audio, ref_sr), ref_text=ref_text
                )
```

Wrap the `_ensure_design_loaded()` + the `_synth_lock` reference forward in `with _VD_KOKORO.design():`, and evict a resident Kokoro at the top of that block. Replace the block above with:

```python
        self._design_last_used = time.monotonic()
        self._design_in_flight += 1
        try:
            # Resident-VRAM exclusion (root fix): a VoiceDesign forward and a
            # Kokoro synth must not co-reside on the 8 GB card. Take the arbiter
            # (waits for any in-flight Kokoro synth to drain, blocks new ones),
            # then evict a resident Kokoro so the 1.7B load has headroom. Kokoro
            # reloads on the next synth (~1s); when no generation ran it isn't
            # resident, so this is a no-op.
            with _VD_KOKORO.design():
                if kokoro._kokoro is not None:
                    log.info("Evicting resident Kokoro to free VRAM for VoiceDesign load.")
                    kokoro.unload()
                self._ensure_design_loaded()
                self._ensure_base_loaded()
                with self._synth_lock:
                    self._ensure_design_loaded()
                    self._ensure_base_loaded()
                    ref_wavs, ref_sr = self._design.generate_voice_design(
                        text=ref_text, language=lang, instruct=instruct
                    )
                    ref_audio = ref_wavs[0]
                    prompt = self._base.create_voice_clone_prompt(
                        ref_audio=(ref_audio, ref_sr), ref_text=ref_text
                    )
```

The rest of `design_voice` (disk cache write, audition synth, `finally: self._design_in_flight -= 1`) stays exactly as-is, OUTSIDE the `with _VD_KOKORO.design():` block — the audition runs on Base only and needs no Kokoro exclusion. `kokoro` is the module-level singleton; reference it directly (no `global` needed for read).

- [ ] **Step 4: Run the full exclusion test file**

Run: `server\tts-sidecar\.venv\Scripts\python.exe -m pytest server/tts-sidecar/tests/test_design_kokoro_exclusion.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Run the broader sidecar suite to confirm no regression**

Run: `npm run test:sidecar`
Expected: PASS (or SKIP banner if venv unbootstrapped — but here the venv exists, so PASS).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_design_kokoro_exclusion.py
git commit -m "fix(sidecar): evict Kokoro + exclude Kokoro synth during VoiceDesign forward

Prevents the three-way (generation + VoiceDesign + Kokoro) >8GB VRAM
oversubscription that spilled to system RAM and tripped the crash-recycle."
```

---

## Part B — Liveness-aware design timeout (server)

**Why:** `DESIGN_TIMEOUT_MS = 180_000` is a blind wall-clock abort. Under the (now-fixed-by-C, but still defensible) slow case it killed a design that the sidecar was still actively running, surfacing a false "Halted." Make it abort only when `/health` is genuinely unreachable, bounded by a 10 min ceiling.

### Task B1: Replace the fixed abort with a liveness watchdog

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (constant ~line 70; the design fetch block ~lines 203–282)
- Test: `server/src/routes/qwen-voice.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Add to `server/src/routes/qwen-voice.test.ts` (follow the file's existing import/mocking style; these assert the new exported helper's behaviour). First, the implementation will export a pure helper `evaluateDesignLiveness` so it's unit-testable without a real sidecar:

```typescript
import { evaluateDesignLiveness } from './qwen-voice.js';

describe('evaluateDesignLiveness', () => {
  const T0 = 1_000_000;
  it('continues while the sidecar is reachable and under the ceiling', () => {
    const r = evaluateDesignLiveness({
      startedAt: T0,
      now: T0 + 200_000, // past the 180s first-check
      health: 'reachable',
      absoluteMaxMs: 600_000,
    });
    expect(r).toEqual({ action: 'continue' });
  });

  it('aborts as unreachable when the sidecar /health is down', () => {
    const r = evaluateDesignLiveness({
      startedAt: T0,
      now: T0 + 200_000,
      health: 'unreachable',
      absoluteMaxMs: 600_000,
    });
    expect(r).toEqual({ action: 'abort', reason: 'unreachable' });
  });

  it('aborts on the absolute ceiling even if the sidecar still pings', () => {
    const r = evaluateDesignLiveness({
      startedAt: T0,
      now: T0 + 600_001,
      health: 'reachable',
      absoluteMaxMs: 600_000,
    });
    expect(r).toEqual({ action: 'abort', reason: 'absolute' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t evaluateDesignLiveness`
Expected: FAIL — `evaluateDesignLiveness` is not exported.

- [ ] **Step 3: Implement the helper + wire the watchdog**

In `server/src/routes/qwen-voice.ts`, replace the single constant and add the ceiling + helper near line 70:

```typescript
/* The base liveness-check interval. A design that exceeds this AND whose sidecar
   /health is still reachable is slow-but-alive — keep waiting (it's almost
   always a contended GPU). Only an unreachable sidecar or the absolute ceiling
   aborts. (Was a blind wall-clock abort that surfaced a false "Halted" while the
   sidecar was happily still designing.) */
const DESIGN_LIVENESS_INTERVAL_MS = 180_000;
/* Hard ceiling so a genuinely hung-but-pingable sidecar still fails eventually. */
const DESIGN_ABSOLUTE_MAX_MS = 600_000;

export type DesignLivenessResult =
  | { action: 'continue' }
  | { action: 'abort'; reason: 'unreachable' | 'absolute' };

/** Pure decision for the design liveness watchdog — easy to unit-test. */
export function evaluateDesignLiveness(p: {
  startedAt: number;
  now: number;
  health: 'reachable' | 'unreachable';
  absoluteMaxMs: number;
}): DesignLivenessResult {
  if (p.now - p.startedAt >= p.absoluteMaxMs) return { action: 'abort', reason: 'absolute' };
  if (p.health === 'unreachable') return { action: 'abort', reason: 'unreachable' };
  return { action: 'continue' };
}
```

Add the import for the health probe at the top of the file (alongside the other imports):

```typescript
import { probeSidecarHealth } from './sidecar-health.js';
```

In `designQwenVoiceForCharacter`, replace the fixed timer (line 208) and the AbortError branch (lines 230–234). Replace:

```typescript
    const timer = setTimeout(() => controller.abort(), DESIGN_TIMEOUT_MS);
```

with the watchdog:

```typescript
    const startedAt = Date.now();
    let abortReason: 'unreachable' | 'absolute' | null = null;
    const livenessTimer = setInterval(() => {
      void (async () => {
        const health = (await probeSidecarHealth()).status; // 'reachable' | 'unreachable'
        const decision = evaluateDesignLiveness({
          startedAt,
          now: Date.now(),
          health,
          absoluteMaxMs: DESIGN_ABSOLUTE_MAX_MS,
        });
        if (decision.action === 'abort') {
          abortReason = decision.reason;
          controller.abort();
        } else {
          console.warn(
            `[qwen-voice] design slow (${Math.round((Date.now() - startedAt) / 1000)}s) ` +
              `— sidecar /health reachable, extending (ceiling ${DESIGN_ABSOLUTE_MAX_MS / 1000}s).`,
          );
        }
      })();
    }, DESIGN_LIVENESS_INTERVAL_MS);
```

Replace the AbortError branch (currently lines 228–238) to distinguish the cause:

```typescript
      } catch (e) {
        const err = e as { name?: string; message?: string };
        if (err.name === 'AbortError') {
          if (p.signal?.aborted) {
            throw new Error('Voice design was cancelled.');
          }
          if (abortReason === 'unreachable') {
            throw new Error(
              `TTS sidecar (${sidecarUrl}) stopped responding to /health during voice design — the process may have crashed or been recycled.`,
            );
          }
          throw new Error(
            `Sidecar /qwen/design-voice did not complete within ${DESIGN_ABSOLUTE_MAX_MS}ms — voice design is unusually slow or the process is stuck.`,
          );
        }
        throw new Error(
          `TTS sidecar (${sidecarUrl}) is unreachable — ${err.message || 'request failed'}.`,
        );
      }
```

Update the `finally` block (line 277–281) to clear the interval instead of the old timer:

```typescript
    } finally {
      clearInterval(livenessTimer);
      if (p.signal) p.signal.removeEventListener('abort', onExternalAbort);
      releaseGpu();
    }
```

Remove the now-unused `DESIGN_TIMEOUT_MS` constant (line 70) if nothing else references it — grep first:

Run: `cd server && grep -rn DESIGN_TIMEOUT_MS src/`
If only its own declaration remains, delete that line. If other references exist, leave it and reconcile.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t evaluateDesignLiveness`
Expected: PASS (3 passed).

- [ ] **Step 5: Run the full qwen-voice test file + typecheck**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts` then `npm run typecheck`
Expected: PASS for both (no type errors from the new import / signature).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): make voice-design timeout liveness-aware (no false Halted)

A slow-but-alive design (sidecar /health reachable) now extends instead of
aborting at 180s; only an unreachable sidecar or a 10min ceiling aborts."
```

---

## Part A — Honest design progress indicator (frontend)

**Why:** `design-progress.tsx` eases the fill to ~92 % in ~15 s, holds, and hard-codes "about 15s" — so a multi-minute design looks frozen at 92 %. Add a ticking elapsed clock, flip to an indeterminate shimmer past the fast window, and swap the copy for an honest "GPU may be busy" message.

### Task A1: Rework DesignProgress with elapsed clock + indeterminate + honest copy

**Files:**
- Modify: `src/components/design-progress.tsx`
- Modify: `src/components/design-progress.test.tsx`
- Modify (styles): `src/styles.css` (add an `.design-fill--indeterminate` shimmer rule)

- [ ] **Step 1: Write the failing tests**

Replace `src/components/design-progress.test.tsx` with:

```tsx
import { render, screen, act } from '@testing-library/react';
import { DesignProgress } from './design-progress';

describe('DesignProgress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the designing phase label', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
  });

  it('shows a ticking elapsed clock so it never looks frozen', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:00');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:03');
  });

  it('shows the optimistic ETA inside the fast window', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/about 15s/i);
  });

  it('switches to the honest "GPU busy" copy past the fast window', () => {
    render(<DesignProgress phase="designing" />);
    act(() => {
      vi.advanceTimersByTime(21000); // past the 20s fast window
    });
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/taking longer than usual/i);
  });

  it('flips the fill to indeterminate past the fast window', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('.design-fill--indeterminate')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(21000);
    });
    expect(container.querySelector('.design-fill--indeterminate')).toBeTruthy();
  });

  it('renders the waveform + fill scaffold', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('[data-testid="design-waveform"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-fill"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/design-progress.test.tsx`
Expected: FAIL — no `design-elapsed` / `design-eta` testids; no indeterminate class.

- [ ] **Step 3: Implement the reworked component**

Replace `src/components/design-progress.tsx` with:

```tsx
import { useEffect, useState, type CSSProperties } from 'react';

const PHASE_LABELS: Record<'designing' | 'rendering', string> = {
  designing: 'Designing the voice…',
  rendering: 'Rendering the 12s audition…',
};

/** Number of waveform bars. Static count; staggered animation delays come from
    the nth-child rules in styles.css (.design-wave i). */
const BARS = 12;

/** Past this many ms the design is "slow" — the optimistic eased fill + "about
    15s" ETA would start lying, so we flip to an honest indeterminate shimmer and
    a "GPU may be busy" message. Designs normally land in ~15s; a slow one is
    almost always a contended GPU. */
const SLOW_AFTER_MS = 20_000;

interface Props {
  phase: 'designing' | 'rendering';
  /** When the design is done, pass true so the fill snaps to 100%. */
  complete?: boolean;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function DesignProgress({ phase, complete = false }: Props) {
  /* Tick once a second so the elapsed clock advances — proof of life even when
     the eased fill is near-full. Mount time ≈ design start (the component
     mounts when the design begins). */
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (complete) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [complete]);

  const slow = !complete && elapsedMs >= SLOW_AFTER_MS;

  /* Soft ETA: CSS eases the fill to ~92% over ~15s and holds (styles.css
     .design-fill i). On completion we override to a full, transition-backed
     width so it snaps shut honestly. Past the slow threshold we ADD the
     indeterminate modifier so the bar reads "still working, no ETA" rather than
     "stuck at 92%". */
  const fillStyle: CSSProperties | undefined = complete
    ? { width: '100%', animation: 'none', transition: 'width 300ms ease-out' }
    : undefined;
  const fillClass = `design-fill mt-2${slow ? ' design-fill--indeterminate' : ''}`;

  return (
    <div className="mt-3 rounded-2xl bg-canvas border border-ink/10 p-4">
      <div className="design-wave" data-testid="design-waveform" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className={fillClass} data-testid="design-fill">
        <i style={fillStyle} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-purple-deep/70">{PHASE_LABELS[phase]}</span>
        <span className="text-[11px] text-ink/40 tabular-nums" data-testid="design-elapsed">
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-ink/40" data-testid="design-eta">
        {slow ? 'Taking longer than usual — the GPU may be busy with another job.' : 'about 15s'}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the indeterminate shimmer style**

In `src/styles.css`, find the existing `.design-fill` block and add below it:

```css
/* Slow-design state: once a design passes the fast window the eased fill would
   sit frozen near 92% and read as "stuck". Overlay a continuously-moving
   indeterminate shimmer so it reads "still working, no ETA". */
.design-fill--indeterminate i {
  animation: design-indeterminate 1.2s ease-in-out infinite;
  width: 40%;
}
@keyframes design-indeterminate {
  0% { margin-left: -42%; }
  100% { margin-left: 100%; }
}
```

(If `.design-fill i` uses `transform`/`width` transitions that fight this, scope the override with `.design-fill--indeterminate i { transition: none; }` as the first line of the rule.)

- [ ] **Step 5: Run the component tests to verify they pass**

Run: `npx vitest run src/components/design-progress.test.tsx`
Expected: PASS (6 passed).

- [ ] **Step 6: Run the consumer's tests to confirm no regression**

Run: `npx vitest run src/components/voice-engine-picker.test.tsx src/modals/profile-drawer.test.tsx`
Expected: PASS (DesignProgress still renders its phase label as before).

- [ ] **Step 7: Commit**

```bash
git add src/components/design-progress.tsx src/components/design-progress.test.tsx src/styles.css
git commit -m "fix(frontend): honest design progress (elapsed clock + indeterminate + GPU-busy copy)"
```

### Task A2: E2E — the design indicator never looks frozen on a slow design

**Files:**
- Create: `e2e/voice-design-progress.spec.ts`

- [ ] **Step 1: Write the e2e spec**

Create `e2e/voice-design-progress.spec.ts`. Follow the existing e2e harness conventions (mock-mode app on port 5174; see a sibling spec under `e2e/` for the `test.beforeEach` navigation + how a single design is triggered in mock mode). The spec must:

```typescript
import { test, expect } from '@playwright/test';

// Drives the profile drawer's single-voice design in mock mode and asserts the
// progress indicator stays honest on a slow design: the elapsed clock advances
// and the copy switches to the "GPU busy" message past the fast window.
test('design progress shows a ticking clock and honest slow-state copy', async ({ page }) => {
  // 1. Navigate to a book → open a character's profile drawer → trigger design.
  //    (Reuse the helper/selectors the existing drawer e2e specs use.)
  // 2. Assert the elapsed clock is present and advances.
  await expect(page.getByTestId('design-elapsed')).toBeVisible();
  const first = await page.getByTestId('design-elapsed').textContent();
  await page.waitForTimeout(2500);
  const second = await page.getByTestId('design-elapsed').textContent();
  expect(first).not.toBe(second);
  // 3. The ETA line is present (exact copy depends on timing; assert it exists).
  await expect(page.getByTestId('design-eta')).toBeVisible();
});
```

IMPLEMENTER NOTE: wire the navigation/trigger using the existing mock-mode design path. If mock mode does not expose a slow design, assert only the always-true honesty invariants (clock present + advances; eta line present). Do NOT add app code purely to make a slow path reachable — keep the e2e to observable behaviour.

- [ ] **Step 2: Run the e2e spec**

Run: `npm run test:e2e -- voice-design-progress`
Expected: PASS (chromium).

- [ ] **Step 3: Commit**

```bash
git add e2e/voice-design-progress.spec.ts
git commit -m "test(frontend): e2e — design progress indicator stays honest while running"
```

---

## Final verification

- [ ] **Run the full battery**

Run: `npm run verify`
Expected: typecheck + all unit tests + e2e + build all green (sidecar tests run via `test:sidecar` inside `test:all`).

- [ ] **Live GPU acceptance (owed, manual)**

With the real sidecar + GPU: start a mixed-cast chapter generation, then design a Qwen voice mid-generation. Confirm via `nvidia-smi` that total VRAM stays under 8 GB (Kokoro evicts for the design, reloads after), the design completes without a recycle, the pill never shows "Halted," and the drawer's progress shows a ticking clock. Record the SHA + result in the spec's Ship notes.

---

## Self-review notes

- **Spec coverage:** C → Tasks C1–C3 (arbiter + Kokoro guard + design evict/exclusion); B → Task B1 (liveness watchdog + ceiling); A → Tasks A1–A2 (honest component + e2e). Out-of-scope memory leak explicitly excluded.
- **Type consistency:** `_VdKokoroArbiter` / `_VD_KOKORO` (sidecar), `evaluateDesignLiveness` / `DesignLivenessResult` (server), `design-elapsed` / `design-eta` / `design-fill--indeterminate` (frontend) are used consistently across their tasks.
- **Pill "GPU busy" / "never Halted":** the false-Halted is fixed at the source by B (server no longer aborts an alive design), so the pill stops receiving a `halt` for a slow design with no frontend slice change required. The "· GPU busy" pill subtitle from the spec is optional polish and intentionally NOT a hard task here (it would need a snapshot `startedAt`); add it only if desired after the core lands.
