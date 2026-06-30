# side-19 — `torch.compile` the Qwen Code2Wav decoder — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the Code2Wav decode share of batched Qwen render wall-time (Phase 0, the gate), then — only if the share clears the bar — ship an env-gated `torch.compile` of that decoder that speeds up batched chapter rendering on the default 0.6B engine without changing what the listener hears.

**Architecture:** Two phases joined by a hard measurement gate. Phase 0 adds an env-gated timing hook that wraps the inner model's `speech_tokenizer.decode` at **Qwen 0.6B Base load** and accumulates decode ms into a counter exposed over a debug endpoint; `bench-tts.py` drives a representative batch and reports the codec share. Phase 1 (conditional) compiles the codec decoder submodule once at 0.6B Base load and routes **only** the batched forward through the compiled module via a per-batch swap under the existing `_synth_lock`, leaving the single `/synthesize` preview path eager.

**Tech Stack:** Python 3.12 FastAPI TTS sidecar (`server/tts-sidecar/`), PyTorch (bfloat16 CUDA forward; codec decode device TBD — see M2/Task 4), the installed `qwen_tts` package (read-only), pytest (venv-gated), `bench-tts.py` (stdlib-only HTTP bench), golden-audio gate.

## Implementer handover (read first)

**Status when handed over (2026-06-30):** plan written, two adversarial-review rounds folded in. Spec is already merged (`docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md`, issue #988). Branch: `docs/side19-codec-compilation-plan` (this plan only; cut from `origin/main`).

**This is a measure-first spike, not a green-lit build.** Phase 0 is a hard gate. The single most important rule: **do not write any Phase 1 (`torch.compile`) code until Phase 0 is measured AND clears the decision table** (`>~25–30%` build / `10–25%` conditional / `<10%` STOP-and-close-won't-do). It is a legitimate, expected outcome that this work ends at Task 3 with a number and a won't-do close.

**What you can do off-box, today:** Tasks 1 and 2 are fully TDD'd and GPU-free (stub the wrapper/torch like `test_torch_perf_flags.py`). They add a timing hook + a bench mode and ship committable code. Do these first.

**What needs the 8 GB box with real Qwen weights (`[ON-BOX]`, can't be faked):**
- **Task 3** — run the measurement, resolve the gate. Includes a mandatory **M1 check**: confirm `generate_voice_clone` actually routes through `speech_tokenizer.decode`, else the share is invalid (the bench prints `INVALID: 0 decode calls`), not low.
- **Task 4** (Phase 1 only) — find the decoder submodule, its **device** (M2: `main.py:166` says decode may run on CPU, which changes backend/mode), and **confirm `decode` does a live submodule lookup (R2-B)**. If lookup isn't live, the per-batch swap is a silent no-op and Task 5's mechanism must change — Task 5 is blocked on this.
- **Task 6** — the four acceptance gates (felt speedup / 8 GB VRAM / golden-audio / no interactive regression).

**Three load-bearing facts the plan encodes (don't relearn them the hard way):**
1. `Qwen3TTSModel` is a *wrapper*; the codec is at `model.model.speech_tokenizer`, never `model.speech_tokenizer` — all hooks go through `_resolve_speech_tokenizer`.
2. Hooks attach in `_ensure_base_loaded` (**0.6B Base only**), never in `_load_qwen_model` — which also loads the VoiceDesign 1.7B model and would risk the 8 GB design-time OOM.
3. The Phase 0 share denominator is the sidecar's header `genMs`, never the HTTP `wall_s` (same clock domain as `decode_ms`).

**Definition of done:** either (a) Phase 0 says `<10%` → spec/BACKLOG/issue closed won't-do with the number recorded; or (b) all four Task 6 gates green → flag ships default-OFF, spec archived, issue #988 closed.

## Global Constraints

- **Spec is the source of truth:** `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md` (issue #988, `side-19`). This plan implements it; do not widen scope.
- **Phase 1 is GATED on Phase 0.** Do not write any compile code until the Phase 0 measurement is recorded and clears the decision table: `>~25–30%` → build Phase 1; `~10–25%` → build only if it stays cheap + VRAM-neutral; `<~10%` → STOP, bank the number, close `side-19` won't-do.
- **`Qwen3TTSModel` is a thin WRAPPER, not an `nn.Module`** (`main.py:1547-1551`). The real module — and therefore `speech_tokenizer` — lives at `.model` (authoritative call site: `self._base17.model.speech_tokenizer.decode`, `:2453`). Every hook resolves the codec via `_resolve_speech_tokenizer(model)`; never `model.speech_tokenizer` directly.
- **0.6B-Base only.** Hooks attach in `_ensure_base_loaded` (the 0.6B Base path), **not** in the generic `_load_qwen_model` — which also loads 1.7B-Base and the VoiceDesign 1.7B model (`:2007`). Compiling/timing VoiceDesign would touch the model the spec excludes and risk the plan-108 / PR #1155 design↔base co-residency OOM on 8 GB. The 1.7B Quality tier (mostly the `live_instruct` path) is **out of scope** for this lever.
- **`QWEN_COMPILE_CODEC` env flag, default OFF, OFF on Windows** (`sys.platform == "win32"`) until proven on-box — both the Triton-GPU and the cpp/MSVC inductor backends are historically fragile on Windows.
- **Compile is batch-path only.** Used by `synthesize_batch`'s 0.6B branch; the single `/synthesize` preview path stays eager so interactive use never eats warmup (acceptance gate 4).
- **Output-preserving within tolerance**, never byte-identity — assert within the golden-audio per-line length/loudness tolerance (`npm run test:golden-audio:sidecar -- --engine=qwen`, note the `--` separator so npm forwards the flag). `torch.compile` may perturb the last ULPs (acceptance gate 3).
- **A perf knob must never kill a model load.** Every compile/timing hook is wrapped in try/except that swallows and falls back to eager + `log.warning`, exactly as `_apply_torch_perf_flags` swallows attribute drift (`main.py:146`).
- **8 GB VRAM-neutral** at batch width `QWEN_BATCH_SIZE=32` (acceptance gate 2 — we are at the plan-108 OOM edge). If compile busts the 8 GB budget, it stays disabled there.
- **Inject `torch` as a parameter** into compile hooks (never a module-global). Function-local `torch` imports can't be monkeypatched, so a param is the testable seam (project-memory note). The load-path caller does `import torch` and passes it in.
- **Sidecar pytest is venv-gated** (`npm run test:sidecar` SKIPs on an unbootstrapped venv; CI skips it). New tests must be GPU-free — stub the wrapper/model/torch like `test_torch_perf_flags.py` does — so they run on any bootstrapped venv without weights.
- **On-box-only tasks are marked `[ON-BOX]`.** They require the 8 GB box with real Qwen weights and are manual; do not fake an automated test for them. Their deliverable is a recorded number + a go/no-go note.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `server/tts-sidecar/main.py` | `_resolve_speech_tokenizer` + Code2Wav timing hook + endpoint (P0); `QWEN_COMPILE_CODEC` flag, compile-at-Base-load, per-batch swap (P1) | 0 + 1 |
| `server/tts-sidecar/tests/test_codec_timing.py` | Pin the resolver (wrapper `.model` traversal) + timing-hook helpers: flag default OFF, wrapper accumulates, snapshot/reset, idempotent wrap | 0 |
| `server/tts-sidecar/tests/test_compile_codec.py` | Pin the compile flag: default OFF, OFF-on-Windows, batch-swaps-but-single-eager, load survives compile failure | 1 |
| `server/tts-sidecar/scripts/bench-tts.py` | `--code2wav-share` mode: reset counter → drive a batch → report decode-ms / batch-wall-ms share + decode-call count | 0 |
| `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md` | Record the Phase 0 measured share + `generate_voice_clone` decode-path finding + decode device + go/no-go in **Ship notes** | 0 + 1 |
| `docs/tts-performance.md` | Update lever 5 with the measured codec share | 0 |

> **Phase 1 is scoped to the default 0.6B engine.** The 1.7B Quality tier's hot path is `_icl_instruct_synth_batch` (live instruct), left eager here. If a later measurement justifies it, extend the swap to the 1.7B wrapper branch (`:2799`) and the manual decode at `:1961` — out of scope for this plan.

---

## PHASE 0 — Size the win (the gate)

### Task 1: `_resolve_speech_tokenizer` + env-gated Code2Wav timing hook

Add a timing wrapper around the inner model's `speech_tokenizer.decode` so we can measure the codec's share of batch wall-time. The hot 0.6B batch decode runs **inside** the library's `generate_voice_clone` (`main.py:2840`) — a call site we do not own — so we wrap the bound `decode` method on the shared `speech_tokenizer`. **Whether `generate_voice_clone` actually routes through `.decode` is verified on-box in Task 3 (M1); if it doesn't, the share is invalid, not low.**

**Files:**
- Modify: `server/tts-sidecar/main.py` (new helpers near `_apply_torch_perf_flags` at `:146`; install call in `_ensure_base_loaded` at `:1658`; endpoint near other `/debug/*` routes)
- Test: `server/tts-sidecar/tests/test_codec_timing.py` (create)

**Interfaces:**
- Produces:
  - `_resolve_speech_tokenizer(model: Any) -> Any` — returns `getattr(getattr(model, "model", model), "speech_tokenizer", None)`; tolerates being handed the inner module directly; `None` when absent.
  - `_codec_timing_enabled() -> bool` — reads env `QWEN_CODEC_TIMING` truthy.
  - module-global `_CODEC_TIMING: dict` with keys `total_ms: float`, `calls: int`.
  - `_codec_timing_reset() -> None`.
  - `_codec_timing_snapshot() -> dict` → `{"total_ms": float, "calls": int, "enabled": bool}`.
  - `_install_codec_timing(model: Any) -> None` — when enabled, replaces the resolved `speech_tokenizer.decode` with a wrapper that adds elapsed-ms to `_CODEC_TIMING`; idempotent (`_codec_timed` marker on the speech_tokenizer); a no-op when disabled or when the codec can't be resolved.
  - `GET /debug/codec-timing` → `_codec_timing_snapshot()`; `POST /debug/codec-timing/reset` → resets, returns `{"ok": true}`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tts-sidecar/tests/test_codec_timing.py
"""test_codec_timing.py — Phase-0 Code2Wav timing hook (side-19).

Qwen3TTSModel is a thin WRAPPER holding the real nn.Module at `.model`
(main.py:1547), and speech_tokenizer hangs off that inner module
(self._base17.model.speech_tokenizer.decode, :2453). The hot batch decode
runs inside qwen_tts's generate_voice_clone — a call site we don't own — so
we wrap the bound `decode` method on the resolved speech_tokenizer at load.
Pin: the resolver traverses `.model`, the flag defaults OFF (zero production
overhead), the wrapper accumulates wall-ms, snapshot/reset round-trips, and a
reload doesn't double-wrap.
"""
from __future__ import annotations

import time
import types
from typing import Any

import main


def _make_stub_model(decode_sleep_s: float = 0.0) -> Any:
    """A WRAPPER-shaped stub: the speech_tokenizer hangs off `.model`, exactly
    like the real Qwen3TTSModel."""
    def decode(items):
        if decode_sleep_s:
            time.sleep(decode_sleep_s)
        return ([object()], 24000)
    st = types.SimpleNamespace(decode=decode)
    inner = types.SimpleNamespace(speech_tokenizer=st)
    return types.SimpleNamespace(model=inner)


def test_resolve_speech_tokenizer_traverses_wrapper():
    st = types.SimpleNamespace(decode=lambda x: None)
    wrapper = types.SimpleNamespace(model=types.SimpleNamespace(speech_tokenizer=st))
    assert main._resolve_speech_tokenizer(wrapper) is st
    # Tolerates being handed the inner module directly.
    inner = types.SimpleNamespace(speech_tokenizer=st)
    assert main._resolve_speech_tokenizer(inner) is st
    # Missing → None so callers no-op instead of raising.
    assert main._resolve_speech_tokenizer(types.SimpleNamespace()) is None


def test_codec_timing_disabled_by_default(monkeypatch):
    monkeypatch.delenv("QWEN_CODEC_TIMING", raising=False)
    assert main._codec_timing_enabled() is False
    model = _make_stub_model()
    original = model.model.speech_tokenizer.decode
    main._install_codec_timing(model)
    assert model.model.speech_tokenizer.decode is original  # disabled → no wrap


def test_codec_timing_accumulates_when_enabled(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    model = _make_stub_model(decode_sleep_s=0.01)
    main._install_codec_timing(model)
    model.model.speech_tokenizer.decode([{"audio_codes": object()}])
    model.model.speech_tokenizer.decode([{"audio_codes": object()}])
    snap = main._codec_timing_snapshot()
    assert snap["calls"] == 2
    assert snap["total_ms"] >= 18.0  # two ~10ms sleeps, generous lower bound
    assert snap["enabled"] is True


def test_codec_timing_reset_zeroes(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    model = _make_stub_model()
    main._install_codec_timing(model)
    model.model.speech_tokenizer.decode([])
    assert main._codec_timing_snapshot()["calls"] == 1
    main._codec_timing_reset()
    assert main._codec_timing_snapshot() == {"total_ms": 0.0, "calls": 0, "enabled": True}


def test_codec_timing_install_idempotent(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    model = _make_stub_model()
    main._install_codec_timing(model)
    wrapped_once = model.model.speech_tokenizer.decode
    main._install_codec_timing(model)  # reload — must not re-wrap
    assert model.model.speech_tokenizer.decode is wrapped_once
    model.model.speech_tokenizer.decode([])
    assert main._codec_timing_snapshot()["calls"] == 1  # one wrap, one increment


def test_codec_timing_install_tolerates_unresolvable(monkeypatch):
    monkeypatch.setenv("QWEN_CODEC_TIMING", "1")
    main._codec_timing_reset()
    # A model whose codec can't be resolved must not raise — a perf hook never
    # kills a load.
    main._install_codec_timing(types.SimpleNamespace())
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_codec_timing.py -v`
Expected: FAIL — `AttributeError: module 'main' has no attribute '_resolve_speech_tokenizer'`.

- [ ] **Step 3: Implement the helpers in `main.py`**

Add near `_apply_torch_perf_flags` (after `:177`):

```python
_CODEC_TIMING: dict = {"total_ms": 0.0, "calls": 0}


def _resolve_speech_tokenizer(model: Any) -> Any:
    """The codec lives on the INNER nn.Module: Qwen3TTSModel is a thin wrapper
    holding the real module at `.model` (see _load_qwen_model docstring; the
    authoritative call site is `self._base17.model.speech_tokenizer.decode`).
    Resolve `model.model.speech_tokenizer`, tolerating a model that already IS
    the inner module, and return None when absent so callers no-op rather than
    raise — a perf hook must never break a load."""
    inner = getattr(model, "model", model)
    return getattr(inner, "speech_tokenizer", None)


def _codec_timing_enabled() -> bool:
    """side-19 Phase-0 gate instrument. When QWEN_CODEC_TIMING is truthy,
    `_install_codec_timing` wraps the codec's decode to accumulate Code2Wav
    wall-time. Default OFF — zero overhead in production; a measurement knob,
    not a shipping path."""
    import os as _os  # noqa: PLC0415
    return _os.environ.get("QWEN_CODEC_TIMING", "").strip().lower() in ("1", "true", "yes", "on")


def _codec_timing_reset() -> None:
    _CODEC_TIMING["total_ms"] = 0.0
    _CODEC_TIMING["calls"] = 0


def _codec_timing_snapshot() -> dict:
    return {
        "total_ms": _CODEC_TIMING["total_ms"],
        "calls": _CODEC_TIMING["calls"],
        "enabled": _codec_timing_enabled(),
    }


def _install_codec_timing(model: Any) -> None:
    """Wrap the resolved speech_tokenizer.decode with a wall-ms accumulator,
    once. Idempotent (`_codec_timed` marker survives reloads). No-op when
    disabled or when the codec can't be resolved."""
    if not _codec_timing_enabled():
        return
    try:
        st = _resolve_speech_tokenizer(model)
        if st is None or getattr(st, "_codec_timed", False):
            return
        original = st.decode

        def _timed_decode(*args, **kwargs):
            t0 = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                _CODEC_TIMING["total_ms"] += (time.perf_counter() - t0) * 1000.0
                _CODEC_TIMING["calls"] += 1

        st.decode = _timed_decode
        st._codec_timed = True
    except Exception as e:  # pragma: no cover - defensive, never kill a load
        log.warning("Could not install codec timing (%s) — continuing.", e)
```

Install in `_ensure_base_loaded` (`:1658`) — **0.6B Base only** (C2), right after the model is assigned:

```python
                self._base = self._load_qwen_model(self.BASE_MODEL)
                _install_codec_timing(self._base)
                log.info("Qwen Base loaded.")
```

Add the endpoints near the other `/debug/*` routes:

```python
@app.get("/debug/codec-timing")
async def debug_codec_timing() -> dict:
    return _codec_timing_snapshot()


@app.post("/debug/codec-timing/reset")
async def debug_codec_timing_reset() -> dict:
    _codec_timing_reset()
    return {"ok": True}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_codec_timing.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_codec_timing.py
git commit -m "feat(sidecar): env-gated Code2Wav timing hook for side-19 Phase 0"
```

---

### Task 2: `--code2wav-share` mode in `bench-tts.py`

Drive a representative multi-voice batch at production width and report the codec share + decode-call count (the count is the M1 validity signal). The bench is the HTTP orchestrator; the share comes from the sidecar counter (Task 1).

**Files:**
- Modify: `server/tts-sidecar/scripts/bench-tts.py` (new `--code2wav-share` argparse path + a pure `codec_share(...)` helper)
- Test: `server/tts-sidecar/tests/test_codec_timing.py` (extend — import the helper from the script)

**Interfaces:**
- Consumes: `GET /debug/codec-timing`, `POST /debug/codec-timing/reset`, `POST /synthesize-batch` (`main.py:5053`; the bench already has `synth_batch_once`, `:183`, which returns the sidecar's header `gen_ms`).
- Produces: `codec_share(decode_ms: float, gen_ms: float) -> float` — `decode_ms / gen_ms` (0.0 when `gen_ms <= 0`). **`gen_ms` is the sidecar's header forward-compute time (`synth_batch_once`'s 4th return), NOT the HTTP `wall_s` (R2-A):** `decode_ms` is measured sidecar-side *inside* the forward, so the denominator must be the same clock domain (`decode_ms ⊂ gen_ms`). Using HTTP `wall_s` adds transfer/queue overhead and understates the share — which could manufacture a false `<10%` STOP.

- [ ] **Step 1: Write the failing test** (append to `test_codec_timing.py`)

```python
def test_codec_share_math():
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location(
        "bench_tts", pathlib.Path(__file__).parent.parent / "scripts" / "bench-tts.py"
    )
    bench = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bench)  # safe: the CLI entry is behind `if __name__`
    assert bench.codec_share(300.0, 1000.0) == 0.3
    assert bench.codec_share(0.0, 0.0) == 0.0       # no divide-by-zero
    assert bench.codec_share(50.0, 0.0) == 0.0
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_codec_timing.py::test_codec_share_math -v`
Expected: FAIL — `AttributeError: module 'bench_tts' has no attribute 'codec_share'`.

> **m6 — verify import safety first.** Before writing the helper, confirm `bench-tts.py`'s CLI entry is behind `if __name__ == "__main__":` (it should be — `main(argv)` takes an explicit arg list). If any module-level code calls `main()` / `parse_args()` at import, the test's `exec_module` would run the CLI; move that call under the guard.

- [ ] **Step 3: Implement `codec_share` + the `--code2wav-share` mode** in `bench-tts.py`

```python
def codec_share(decode_ms: float, gen_ms: float) -> float:
    """Code2Wav decode-ms as a fraction of the sidecar's batch forward-compute
    ms — the single number side-19 Phase 0's decision table reads. The
    denominator is the header `genMs` (same sidecar clock domain as decode_ms),
    NOT the HTTP round-trip (R2-A). 0.0 when the batch produced no compute time
    (degenerate / error)."""
    return decode_ms / gen_ms if gen_ms > 0 else 0.0
```

Add an argparse branch `--code2wav-share` that, against a live sidecar with `QWEN_CODEC_TIMING=1`:
1. `POST /debug/codec-timing/reset`.
2. Builds a `--batch 32` batch by **cycling `HIGH_VARIANCE_SENTENCES`** (11 items) up to 32 — e.g. `[POOL[i % len(POOL)] for i in range(batch)]` — a representative length-spread on the single designed `--voice`. (Single-voice is adequate for the *share*: codec decode cost tracks audio length, not voice identity; a true narrator/dialogue mix is exercised by the live gate-1 A/B, not here.) Calls `synth_batch_once(...)` and keeps its 4th return, `gen_ms`.
3. `GET /debug/codec-timing` → `decode_ms = total_ms`, `calls`.
4. Prints, and **hard-flags `calls == 0` as INVALID** (the wrap never saw a decode — `generate_voice_clone` doesn't route through `.decode`; re-do Task 3 Step 2):
   `code2wav share: {codec_share(decode_ms, gen_ms):.1%}  (decode {decode_ms:.0f} ms / forward {gen_ms:.0f} ms, {calls} decode calls)` and, when `calls == 0`, `INVALID: 0 decode calls captured — see Task 3 M1.`

Document the invocation in the script's module docstring:

```
  # side-19 Phase 0 — Code2Wav share of batch wall-time (set QWEN_CODEC_TIMING=1
  # in the sidecar env first, restart it, ensure Qwen 0.6B Base is loaded):
  python scripts/bench-tts.py --engine qwen --voice <designedVoiceId> \
      --code2wav-share --batch 32
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_codec_timing.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/scripts/bench-tts.py server/tts-sidecar/tests/test_codec_timing.py
git commit -m "feat(sidecar): bench-tts --code2wav-share mode for side-19 Phase 0"
```

---

### Task 3 `[ON-BOX]`: Verify the decode path, run the measurement, resolve the gate

**Files:**
- Modify: `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md` (**Ship notes**: decode-path finding + measured share + go/no-go)
- Modify: `docs/tts-performance.md` (lever 5)

No automated test — the deliverable is a recorded number + a decision. Run on the 8 GB box with real Qwen weights.

- [ ] **Step 1: Reboot the box** (clean GPU VRAM + process state — perf-baseline hygiene).

- [ ] **Step 2: (M1) Confirm `generate_voice_clone` routes through `speech_tokenizer.decode`.** In the installed `qwen_tts` (read-only), grep the `generate_voice_clone` implementation for the codec-decode call. Confirm it invokes `self.speech_tokenizer.decode(...)` (the attribute the Task 1 hook wraps) and not a differently-named internal. Record the finding in Ship notes. If it uses a different method, update `_resolve_speech_tokenizer`/`_install_codec_timing` to wrap that method before measuring — otherwise the share is invalid.

- [ ] **Step 3: Start the sidecar with timing on.** Set `QWEN_CODEC_TIMING=1`, `QWEN_BATCH_SIZE=32`, `QWEN_BATCH_TOKEN_BUDGET=3600`, start the stack, load Qwen 0.6B Base.

- [ ] **Step 4: Run the bench** against a designed voice, with **no other generation in flight** (R2-d: `_CODEC_TIMING` is process-global, so a concurrent render between the bench's reset and read would pollute the share — quiesce the queue / pause auto-prosody first):

Run: `cd server/tts-sidecar && python scripts/bench-tts.py --engine qwen --voice <designedVoiceId> --code2wav-share --batch 32`
Run 3×, take the median (discard the first warm-up run). **If it prints `INVALID: 0 decode calls`, stop and fix the wrap (Step 2) — do NOT read this as `<10%`.**

- [ ] **Step 5: Record the number and resolve the gate** in Ship notes + `docs/tts-performance.md` lever 5, using the decision table:
  - `> ~25–30%` → **GO Phase 1.** Proceed to Task 4.
  - `~10–25%` → **GO only if Phase 1 stays cheap + VRAM-neutral.** Proceed to Task 4; treat gates 1 (felt speedup) and 2 (VRAM) as hard stops.
  - `< ~10%` → **STOP.** Close `side-19` won't-do with the share recorded; remove its `docs/BACKLOG.md` row; do NOT implement Phase 1. Commit the doc update and end here.

- [ ] **Step 6: Commit the measurement**

```bash
git add docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md docs/tts-performance.md
git commit -m "docs(side-19): record Phase 0 Code2Wav share measurement"
```

> **GATE — STOP HERE unless Step 5 cleared the bar.** Phase 1 below runs only on a GO.

---

## PHASE 1 — Ship the speedup (GATED on Phase 0 GO)

> **Decision baked into this plan (resolves the spec's one ambiguity).** "Batch-path only, single stays eager" with a *shared* `speech_tokenizer` is implemented as a **per-batch module swap under `_synth_lock`**: at 0.6B Base load we build a compiled clone of the codec decoder submodule; `synthesize_batch`'s 0.6B branch swaps it in for the batched forward and restores eager in a `finally`. The single path never swaps → stays eager. No library fork. Task 4 discovers the submodule name **and its device**; Task 5 wires the swap.
>
> **R2-B — the swap is load-bearing on a library detail.** It only takes effect if `speech_tokenizer.decode` invokes the submodule by a **live attribute lookup** (`self.<attr>(...)` at call time). If the library captured a bound reference at `__init__` or calls the codec functionally, swapping the attribute changes something nothing reads → the compiled module **never runs**: no speedup, no wrong audio, no error — an invisible failure every unit test passes through. **Task 4 confirms live lookup before Task 5 is written.** If lookup is not live, the mechanism changes (monkeypatch `decode` itself, or compile-and-reassign permanently at load), so Task 5 is blocked on Task 4's finding.

### Task 4 `[ON-BOX]`: Locate the codec decoder submodule and its device

`torch.compile` should target the inner codec `nn.Module.forward`, not the Python `speech_tokenizer.decode` wrapper (which iterates a list of dicts and would graph-break / recompile). Identify the submodule, its attribute path, **and whether decode runs on CPU or CUDA** — `main.py:166` notes the Code2Wav decode may run on CPU, which changes the compile backend/mode (M2).

**Files:**
- Modify: `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md` (Ship notes: submodule path + device + chosen backend/mode)

- [ ] **Step 1: Inspect the resolved speech_tokenizer** (read-only), with 0.6B Base loaded:

```python
# `st = model.model.speech_tokenizer`  (NOT model.speech_tokenizer — wrapper)
print(type(st))
for name, child in st.named_children():
    print(name, type(child).__name__)
```

- [ ] **Step 2: Identify the decoder submodule and its device.** Find the feed-forward neural-codec decoder (the `nn.Module` whose `forward` the decode ultimately calls); record its attribute path (e.g. `decoder` / `model.decoder`) and confirm it is a plain `nn.Module` with no KV-cache / generate-loop semantics. Determine its device (`next(submodule.parameters()).device`). Record under Ship notes.

- [ ] **Step 3: Choose backend/mode from the device (M2).**
  - **CUDA decode** → `torch.compile(decoder, dynamic=True)` (default inductor/Triton). `mode="reduce-overhead"` (CUDA graphs) is viable only if the submodule has no graph-breaking control flow — note but don't assume.
  - **CPU decode** → `torch.compile(decoder, dynamic=True)` (inductor cpp backend). CUDA-graph modes do **not** apply; the win is operator fusion. Confirm a C++ toolchain is present on the box. (Windows stays OFF regardless.)
  Record the chosen call in Ship notes; Task 5 uses it verbatim.

- [ ] **Step 4: (R2-B — GATE on Task 5) Confirm the decode does a LIVE submodule lookup.** Read `speech_tokenizer.decode`'s source in the installed `qwen_tts` (read-only). Confirm it calls the decoder submodule by **live attribute access** (`self.<attr>(...)` / `getattr(self, attr)(...)` inside `decode`), not a reference captured at `__init__` and not a functional call. Record the finding in Ship notes:
  - **Live lookup confirmed** → the per-batch swap in Task 5 works as written. Proceed.
  - **NOT live** (bound ref / functional) → **STOP — do not write Task 5 as planned.** The swap would be a silent no-op (R2-B). Switch the mechanism to either monkeypatching `speech_tokenizer.decode` itself with a compiled-aware wrapper, or compiling-and-reassigning the submodule permanently at load (and dropping the per-batch swap — re-deriving "single stays eager" via a separate compiled path). Revise Task 5 accordingly before implementing.

- [ ] **Step 5: Commit the finding**

```bash
git add docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md
git commit -m "docs(side-19): record Code2Wav decoder submodule path, device, live-lookup finding (Phase 1 Task 4)"
```

---

### Task 5: `QWEN_COMPILE_CODEC` flag, compile-at-Base-load, per-batch swap

> **Blocked on Task 4 Step 4 (R2-B).** The per-batch swap below is correct only if Task 4 confirmed `decode` does a live submodule lookup. If it didn't, revise this task to the alternate mechanism Task 4 recorded before implementing.

**Files:**
- Modify: `server/tts-sidecar/main.py` (flag helper near `:146`; compile call in `_ensure_base_loaded` at `:1658`; per-batch swap in `synthesize_batch`'s **0.6B branch** at `:2836-2842`)
- Test: `server/tts-sidecar/tests/test_compile_codec.py` (create)

**Interfaces:**
- Consumes: Task 4's submodule attribute path (use it for `_CODEC_DECODER_ATTR`) and chosen `torch.compile` call.
- Produces:
  - `_should_compile_codec() -> bool` — `QWEN_COMPILE_CODEC` truthy AND `sys.platform != "win32"`.
  - `_maybe_compile_codec(model, torch) -> bool` — when `_should_compile_codec()`, stores `model._compiled_codec_decoder = torch.compile(<resolved decoder>, dynamic=True)`; swallows any failure → returns `False` + `log.warning` (eager fallback). Returns whether a compiled module was installed.
  - context manager `_codec_compiled_for_batch(model)` — when a compiled decoder exists, swaps `<resolved speech_tokenizer>.<_CODEC_DECODER_ATTR>` to the compiled module on entry, restores eager in `finally`; no-op otherwise.

- [ ] **Step 1: Write the failing tests**

```python
# server/tts-sidecar/tests/test_compile_codec.py
"""test_compile_codec.py — side-19 Phase 1 QWEN_COMPILE_CODEC wiring.

A perf knob, so a mis-wire is silent: pin the flag default OFF, OFF on
Windows even when set, that a compiled decoder is swapped in for the BATCH
forward but never the single path, and that a compile failure at load is
swallowed (eager fallback). GPU-free: stub torch.compile and the WRAPPER
model (speech_tokenizer on `.model`), like test_codec_timing.py.
"""
from __future__ import annotations

import types
from typing import Any

import main


def _stub_torch(compile_raises: bool = False) -> Any:
    def _compile(mod, **kwargs):
        if compile_raises:
            raise RuntimeError("inductor exploded")
        return types.SimpleNamespace(_compiled_of=mod, is_compiled=True)
    return types.SimpleNamespace(compile=_compile)


def _stub_model() -> Any:
    decoder = types.SimpleNamespace(name="eager-decoder")
    st = types.SimpleNamespace(decoder=decoder, decode=lambda items: ([], 24000))
    inner = types.SimpleNamespace(speech_tokenizer=st)
    return types.SimpleNamespace(model=inner)  # wrapper holds inner at .model


def test_should_compile_default_off(monkeypatch):
    monkeypatch.delenv("QWEN_COMPILE_CODEC", raising=False)
    assert main._should_compile_codec() is False


def test_should_compile_off_on_windows_even_when_set(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "win32")
    assert main._should_compile_codec() is False


def test_should_compile_on_when_set_off_windows(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    assert main._should_compile_codec() is True


def test_maybe_compile_installs_compiled_decoder(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    model = _stub_model()
    assert main._maybe_compile_codec(model, _stub_torch()) is True
    assert model._compiled_codec_decoder.is_compiled is True


def test_maybe_compile_swallows_failure(monkeypatch):
    """A compile failure at load must NOT raise — fall back to eager."""
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    model = _stub_model()
    assert main._maybe_compile_codec(model, _stub_torch(compile_raises=True)) is False
    assert getattr(model, "_compiled_codec_decoder", None) is None


def test_batch_swap_uses_compiled_single_path_eager(monkeypatch):
    monkeypatch.setenv("QWEN_COMPILE_CODEC", "1")
    monkeypatch.setattr(main.sys, "platform", "linux")
    model = _stub_model()
    st = model.model.speech_tokenizer
    eager = st.decoder
    main._maybe_compile_codec(model, _stub_torch())
    assert st.decoder is eager  # outside the ctx → single path stays eager
    with main._codec_compiled_for_batch(model):
        assert st.decoder is model._compiled_codec_decoder
    assert st.decoder is eager  # restored after the batch forward


def test_batch_swap_noop_when_not_compiled(monkeypatch):
    monkeypatch.delenv("QWEN_COMPILE_CODEC", raising=False)
    model = _stub_model()
    eager = model.model.speech_tokenizer.decoder
    with main._codec_compiled_for_batch(model):
        assert model.model.speech_tokenizer.decoder is eager  # never swapped
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_compile_codec.py -v`
Expected: FAIL — `AttributeError: module 'main' has no attribute '_should_compile_codec'`.

- [ ] **Step 3: Implement the helpers in `main.py`**

> Replace `decoder` with Task 4's recorded attribute name and use Task 4's chosen `torch.compile` call. Keep the attribute name in `_CODEC_DECODER_ATTR` so there's one place to fix. Ensure `import sys` and `from contextlib import contextmanager` are at module top (the latter is already imported for `_suppress_code_predictor_log`; add `import sys` if absent — the tests monkeypatch `main.sys.platform`).

```python
_CODEC_DECODER_ATTR = "decoder"  # side-19 Task 4: speech_tokenizer's codec decoder submodule


def _should_compile_codec() -> bool:
    """side-19 Phase 1. Compile the Code2Wav decoder only when
    QWEN_COMPILE_CODEC is truthy AND not on Windows — both the Triton-GPU and
    cpp/MSVC inductor backends are historically fragile there, so it stays OFF
    on Windows until proven on-box. Default OFF everywhere."""
    import os as _os  # noqa: PLC0415
    if sys.platform == "win32":
        return False
    return _os.environ.get("QWEN_COMPILE_CODEC", "").strip().lower() in ("1", "true", "yes", "on")


def _maybe_compile_codec(model: Any, torch: Any) -> bool:
    """Build a torch.compile clone of the codec decoder submodule and stash it
    on the model. Dynamic shapes (audiobook line lengths vary wildly — the
    same reason cudnn.benchmark is OFF) so recompiles don't thrash. Any failure
    is swallowed → eager fallback; a model load must never die over a perf knob
    (mirrors _apply_torch_perf_flags). Returns True iff a compiled module was
    installed."""
    if not _should_compile_codec():
        return False
    try:
        st = _resolve_speech_tokenizer(model)
        if st is None:
            return False
        eager = getattr(st, _CODEC_DECODER_ATTR)
        model._compiled_codec_decoder = torch.compile(eager, dynamic=True)
        log.info("Code2Wav decoder compiled (QWEN_COMPILE_CODEC, dynamic shapes).")
        return True
    except Exception as e:  # pragma: no cover - defensive
        log.warning("Could not compile Code2Wav decoder (%s) — using eager.", e)
        model._compiled_codec_decoder = None
        return False


@contextmanager
def _codec_compiled_for_batch(model: Any):
    """Swap the compiled codec decoder in for the duration of a BATCHED forward,
    restore eager afterwards. Batch-path only: the single /synthesize path never
    enters this ctx, so it stays eager and never eats warmup. Caller holds
    _synth_lock, so the swap is serialised. No-op when no compiled decoder
    exists or the codec can't be resolved."""
    compiled = getattr(model, "_compiled_codec_decoder", None)
    st = _resolve_speech_tokenizer(model)
    if compiled is None or st is None:
        yield
        return
    eager = getattr(st, _CODEC_DECODER_ATTR)
    setattr(st, _CODEC_DECODER_ATTR, compiled)
    try:
        yield
    finally:
        setattr(st, _CODEC_DECODER_ATTR, eager)
```

Compile at 0.6B Base load — extend the `_ensure_base_loaded` block from Task 1 (`:1658`):

```python
                self._base = self._load_qwen_model(self.BASE_MODEL)
                _install_codec_timing(self._base)
                import torch  # injected into the compile hook for testability
                _maybe_compile_codec(self._base, torch)
                log.info("Qwen Base loaded.")
```

Wrap the **0.6B branch** batched forward in `synthesize_batch` (`:2840`), already under `with self._synth_lock:`:

```python
            with self._synth_lock:
                self._ensure_base_loaded()
                with _codec_compiled_for_batch(self._base):
                    wavs, sr = self._base.generate_voice_clone(
                        text=texts, language=langs, voice_clone_prompt=prompts
                    )
```

(The 1.7B branch at `:2799` is **out of scope** — see the Phase 1 note.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server/tts-sidecar && .venv/Scripts/python -m pytest tests/test_compile_codec.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full sidecar suite (no regressions)**

Run: `npm run test:sidecar`
Expected: PASS (or SKIP banner on an unbootstrapped venv).

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_compile_codec.py
git commit -m "feat(sidecar): QWEN_COMPILE_CODEC compile of Code2Wav decoder (side-19 Phase 1)"
```

---

### Task 6 `[ON-BOX]`: Acceptance gates — speedup, VRAM, golden-audio, no interactive regression

All four gates must hold; a red gate blocks the flag from shipping ON on that platform.

**Files:**
- Modify: `docs/superpowers/specs/2026-06-22-qwen-codec-compilation-design.md` (Ship notes: shipped date, commit SHA, A/B numbers, gate results — flip `status: draft` → `stable`, then `git mv` to `docs/features/archive/`)
- Modify: `docs/features/INDEX.md` (move side-19 to Shipped/archive)
- Modify: `docs/tts-performance.md` (lever 5: shipped + measured speedup)
- Modify: `docs/BACKLOG.md` (remove the side-19 row)

- [ ] **Step 1: Reboot the box** (clean VRAM/process baseline).

- [ ] **Step 2: Gate 1 — felt speedup (live A/B).** Run a real chapter render flag-OFF then flag-ON via `POST /api/books/:id/generation` on the 8 GB box; record wall-time both ways. **Discard the first batch of the flag-ON run from the comparison (R2-e):** the one-time `torch.compile` warmup lands there (seconds–minutes on the cpp/CPU backend), so a short render would otherwise read the warmup as a regression — measure steady-state, where it amortizes. Pass iff flag-ON steady-state is faster by a margin worth the complexity (the micro-bench alone does not ship it).

- [ ] **Step 3: Gate 2 — 8 GB VRAM-neutral.** Watch `nvidia-smi` peak during the flag-ON batch-32 render. Pass iff peak holds within the 8 GB budget. If it busts budget, the flag stays disabled on 8 GB — record that.

- [ ] **Step 4: Gate 3 — output-preserving.** Run `npm run test:golden-audio:sidecar -- --engine=qwen` with the flag ON. Pass iff every fixture line stays within the committed per-line length/loudness tolerance (NOT byte-identity).

- [ ] **Step 5: Gate 4 — no interactive regression.** Time several single `/synthesize` preview calls flag-ON vs flag-OFF. Pass iff single-preview latency is unchanged (the flag never enters `_codec_compiled_for_batch`).

- [ ] **Step 6: Record results and ship (or hold).** If all gates pass: fill Ship notes (date, SHA, A/B + gate numbers), flip `status` → `stable`, `git mv` the spec to `docs/features/archive/`, update `docs/features/INDEX.md` + `docs/tts-performance.md` lever 5, confirm the flag default stays OFF. If any gate fails on 8 GB: record the failure, leave the flag default OFF / disabled-on-8GB, note the follow-up. Then remove the `docs/BACKLOG.md` row and close/advance issue #988.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs docs/features/archive docs/features/INDEX.md docs/tts-performance.md docs/BACKLOG.md
git commit -m "docs(side-19): ship notes + acceptance results, archive spec"
```

---

## Self-Review

**Spec coverage:**
- Phase 0 instrument (codec share of batch wall-time, production width, 8 GB box) → Tasks 1–3. ✓
- Decision table → Task 3 Step 5. ✓
- `QWEN_COMPILE_CODEC` default OFF, OFF on Windows → Task 5. ✓
- Compile only Code2Wav's forward, once at 0.6B Base load → Task 5 (`_maybe_compile_codec` in `_ensure_base_loaded`). ✓
- Batch-path only, single eager → Task 5 (`_codec_compiled_for_batch` under `_synth_lock`). ✓
- Variable shapes → Task 5 (`dynamic=True`). ✓
- Acceptance gates 1–4 → Task 6. ✓
- Testing plan (default OFF, OFF-Windows, batch-not-single, survives compile failure; golden-audio; bench) → Tasks 1, 2, 5, 6. ✓
- Rollout (issue #988, BACKLOG, tts-performance lever 5, won't-do on a stop) → Tasks 3, 6. ✓

**Review-fix coverage (this revision):**
- C1 (wrapper `.model` traversal) → `_resolve_speech_tokenizer`, used by all hooks; tests use the wrapper-shaped stub. ✓
- C2 (Base-only) → hooks in `_ensure_base_loaded`, not `_load_qwen_model`; 1.7B/VoiceDesign explicitly out of scope. ✓
- M1 (decode-path unverified) → Task 3 Step 2 inspection + `calls == 0` INVALID guard in the bench + Task 4 reads it. ✓
- M2 (CPU vs CUDA decode) → Task 4 Steps 2–3 probe device + choose backend/mode. ✓
- m3 (golden-audio command) → `npm run test:golden-audio:sidecar -- --engine=qwen`. ✓
- m4 (1.7B dead coverage) → Phase 1 note + Task 5 wraps only the 0.6B branch. ✓
- m5 (warmup interface drift) → interface no longer claims warmup; impl matches. ✓
- m6 (import guard) → Task 2 Step 2 verifies the `if __name__` guard. ✓

**Round-2 review-fix coverage:**
- R2-A (share clock-domain) → `codec_share(decode_ms, gen_ms)` uses the sidecar header `genMs`, not HTTP `wall_s`; interface + impl + print updated. ✓
- R2-B (swap needs live submodule lookup) → Phase 1 caveat + Task 4 Step 4 hard gate before Task 5 + Task 5 blocked-on note. ✓
- r2-c (batch fill / multi-voice overclaim) → Task 2 cycles the 11-item pool to 32, single-voice rationale stated. ✓
- r2-d (process-global counter) → Task 3 Step 4 quiesce-traffic requirement. ✓
- r2-e (CPU warmup reads as regression) → Task 6 gate 1 discards the first (warmup) batch. ✓

**Type consistency:** `_resolve_speech_tokenizer(model) -> st|None` consumed by `_install_codec_timing`, `_maybe_compile_codec`, `_codec_compiled_for_batch`; `_codec_timing_snapshot()` shape `{total_ms, calls, enabled}` matches endpoint + tests; `codec_share(decode_ms, batch_wall_ms)` matches Task 2's caller; `_maybe_compile_codec(model, torch) -> bool` matches tests + call site. ✓
