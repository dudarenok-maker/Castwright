# side-25 — Qwen Code2Wav Codec GPU Placement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Qwen Code2Wav codec decode from CPU to GPU (behind an opt-in, default-off knob), cutting batch RTF and eliminating the codec's host-memory plateau, without breaking the 1.7B/0.6B/VoiceDesign load paths or the side-19 compile scaffolding.

**Architecture:** `Qwen3TTSTokenizer` (the codec wrapper) is a plain Python object, not an `nn.Module`, so it's silently skipped by `_load_qwen_model`'s existing `inner.to(self._device)` call. The fix adds two new helpers called from `_load_qwen_model` right after that existing call: one resolves+moves the codec's own `.model`/`.device` onto a device (with an OOM-safe rollback), the other binds a `functools.partial` onto the codec decoder's `chunked_decode` to make its `chunk_size`/`left_context_size` configurable (they are NOT reachable through the normal call path, which calls `chunked_decode()` with no arguments). Three new registry knobs expose this via the existing generic Advanced Settings UI. Default is `cpu` everywhere (today's behavior, unchanged) — this ships inert until manually flipped per-box after an on-box acceptance run.

**Tech Stack:** Python (FastAPI sidecar, pytest), TypeScript (Express config registry, Vitest).

## Global Constraints

- All three knobs default to today's exact behavior when unset (`QWEN_CODEC_DEVICE=cpu`, `QWEN_CODEC_CHUNK_SIZE`/`QWEN_CODEC_LEFT_CONTEXT_SIZE` unset) — zero behavior change out of the box.
- All three knobs: `apply: restart-sidecar`, `risk: high` (matches the existing `tts.qwen.device` entry).
- No automatic VRAM-threshold default-flip heuristic — flipping the default on any given box is a manual operator decision made after that box's acceptance run (Task 6).
- No new golden *fixture* — the 0.6B-Base/VoiceDesign paths get a smoke check (Task 5), not golden-tolerance coverage.
- A failed codec-device move must never leave a half-migrated model — a failed load is a clean, fully-visible failure (propagates to `_load_qwen_model`'s existing outer reclaim-and-fail handler), never silently swallowed.
- Spec: `docs/superpowers/specs/2026-07-06-side25-qwen-codec-gpu-design.md` (already through 2 rounds of Opus adversarial review — treat as vetted).

---

### Task 1: Resolve `QWEN_CODEC_DEVICE` + move the codec (happy path)

**Files:**
- Modify: `server/tts-sidecar/main.py:24` (add `import functools`)
- Modify: `server/tts-sidecar/main.py:306-309` (add two new functions after `_codec_compiled_for_batch`, before `app = FastAPI(...)`)
- Modify: `server/tts-sidecar/main.py:1886-1892` (wire the move into `_load_qwen_model`, right after the existing `inner.to(self._device)` + `model.device` resync block, still inside the same outer `try:`)
- Test: `server/tts-sidecar/tests/test_qwen3.py` (extend the fake-runtime harness + add tests, right after `test_load_moves_inner_model_and_resyncs_device`, ~line 663)

**Interfaces:**
- Produces: `_resolve_codec_device(pref: str, model_device: str) -> Optional[str]` — returns `None` when the codec should not be moved (the `'cpu'` default — no-op), or a concrete device string otherwise.
- Produces: `_move_codec_to_device(model: Any, device: str, torch_module: Any) -> None` — moves `speech_tokenizer.model` and resyncs `speech_tokenizer.device`. (Task 2 will add error handling to this same function — ship it bare here.)
- Consumes: `_resolve_speech_tokenizer(model)` (already exists, `main.py:185-193`).

- [ ] **Step 1: Write the failing tests**

  First, extend the fake harness in `server/tts-sidecar/tests/test_qwen3.py` so `_FakeTokenizerStub` mirrors the real `Qwen3TTSTokenizer`'s shape (a plain object holding `.model` — a real "nn.Module" stand-in — and a separately-cached `.device`). Replace the existing `_FakeTokenizerStub` class (lines 41-46) with:

  ```python
  class _FakeCodecDecoder:
      """Stand-in for the real Qwen3TTSTokenizerV2Decoder -- the nn.Module
      `chunked_decode` lives on (two levels below speech_tokenizer). Records
      the kwargs it was called with so Task 3's tests can assert a
      functools.partial bound the right chunk_size/left_context_size."""

      def chunked_decode(self, codes: Any, chunk_size: int = 300, left_context_size: int = 25) -> dict:
          return {"chunk_size": chunk_size, "left_context_size": left_context_size}


  class _FakeCodecModel:
      """Stand-in for speech_tokenizer.model (the real Qwen3TTSTokenizerV2Model)
      -- an nn.Module with a .decoder submodule and its own .to(). Records every
      .to() call; `fail_calls` (a set of 1-indexed call numbers) makes that call
      raise instead of succeeding, so Task 2's tests can simulate a mid-move
      CUDA OOM (fail the 1st call) and confirm a rollback .to('cpu') (the 2nd
      call) either succeeds or -- for the "rollback also fails" edge case --
      also raises."""

      def __init__(self, fail_calls: frozenset = frozenset()) -> None:
          self.device: Any = None
          self.decoder = _FakeCodecDecoder()
          self.to_calls: list[Any] = []
          self._fail_calls = fail_calls

      def to(self, device: Any) -> "_FakeCodecModel":
          self.to_calls.append(device)
          if len(self.to_calls) in self._fail_calls:
              raise RuntimeError("CUDA out of memory (fake OOM)")
          self.device = device
          return self


  class _FakeTokenizerStub:
      """Stand-in for model.speech_tokenizer used by _icl_instruct_synth (Task 2
      fs-55) AND the side-25 codec-placement fix. decode() returns a flat-zero
      24 kHz clip -- same shape as the real decode. .model/.device mirror the
      real Qwen3TTSTokenizer's shape (a plain object, NOT an nn.Module -- see
      _resolve_speech_tokenizer's docstring in main.py) so the placement fix's
      .to()/device resync can be exercised without real weights."""

      def __init__(self, codec_model: "_FakeCodecModel | None" = None) -> None:
          self.model = codec_model if codec_model is not None else _FakeCodecModel()
          self.device: Any = "cpu"  # matches the real class's from_pretrained default

      def decode(self, codes: Any) -> tuple[list[Any], int]:  # type: ignore[return]
          return [np.zeros(6000, dtype=np.float32)], 24000
  ```

  Then add these tests directly after `test_load_moves_inner_model_and_resyncs_device` (~line 663):

  ```python
  def test_resolve_codec_device_cpu_default_means_no_move() -> None:
      assert main._resolve_codec_device("cpu", "cuda:0") is None
      assert main._resolve_codec_device("", "cuda:0") is None
      assert main._resolve_codec_device(None, "cuda:0") is None


  def test_resolve_codec_device_auto_mirrors_model_device() -> None:
      assert main._resolve_codec_device("auto", "cuda:1") == "cuda:1"
      assert main._resolve_codec_device("AUTO", "mps") == "mps"


  def test_resolve_codec_device_explicit_pin_passes_through() -> None:
      assert main._resolve_codec_device("cuda:1", "cuda:0") == "cuda:1"


  def test_load_moves_codec_to_device_when_configured(fake_qwen_runtime, monkeypatch) -> None:
      """QWEN_CODEC_DEVICE=cuda:0 moves speech_tokenizer.model to that device
      and resyncs the cached speech_tokenizer.device -- the codec's own
      .to(self.device) calls inside encode()/decode() then land on the right
      device."""
      engine = fake_qwen_runtime["engine"]
      monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda:0")
      engine._device = "cuda:0"
      _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

      model = engine._load_qwen_model(engine.BASE_MODEL)

      codec_model = model.model.speech_tokenizer.model
      assert codec_model.device == "cuda:0"
      assert model.model.speech_tokenizer.device == "cuda:0"


  def test_load_leaves_codec_on_cpu_by_default(fake_qwen_runtime, monkeypatch) -> None:
      """QWEN_CODEC_DEVICE unset (default 'cpu') never touches the codec --
      preserves today's behaviour exactly."""
      engine = fake_qwen_runtime["engine"]
      monkeypatch.delenv("QWEN_CODEC_DEVICE", raising=False)
      _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

      model = engine._load_qwen_model(engine.BASE_MODEL)

      codec_model = model.model.speech_tokenizer.model
      assert codec_model.to_calls == []
  ```

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen3.py -k "resolve_codec_device or moves_codec_to_device or leaves_codec_on_cpu" -v`
  Expected: FAIL — `AttributeError: module 'main' has no attribute '_resolve_codec_device'` (and the two `_load_qwen_model` tests fail the same way once that's added, or error since the fixture change alone doesn't wire anything yet).

- [ ] **Step 3: Implement `_resolve_codec_device` + `_move_codec_to_device`**

  In `server/tts-sidecar/main.py`, add `import functools` after line 24 (`import asyncio`), keeping the alphabetical stdlib-import ordering:

  ```python
  import asyncio
  import functools
  import gc
  ```

  Add these two functions after `_codec_compiled_for_batch` (ends at line 306) and before `app = FastAPI(...)` (line 309):

  ```python
  def _resolve_codec_device(pref: str, model_device: str) -> Optional[str]:
      """Resolve QWEN_CODEC_DEVICE to a concrete device string, or None to
      leave the codec exactly where it already is (today's CPU-only
      behaviour).

      'cpu' (default) -> None: no move attempted.
      'auto' -> model_device: mirror this Qwen instance's OWN resolved device.
        Deliberately NOT an independent cuda->mps->cpu probe like
        QWEN_DEVICE=auto -- the codec is always loaded alongside an
        already-resolved model (self._device is concrete by the time
        _load_qwen_model runs this), so 'auto' here means "wherever that
        model landed," full stop. This is the only way the codec can never
        end up on a different card than its own model.
      explicit cuda/cuda:N/mps -> returned unchanged (validated by the
        caller via _validate_cuda_index, same as every other device knob)."""
      p = (pref or "cpu").strip().lower()
      if p == "cpu":
          return None
      if p == "auto":
          return model_device
      return pref


  def _move_codec_to_device(model: Any, device: str, torch_module: Any) -> None:
      """Move the resolved codec (speech_tokenizer.model) to `device` and
      resync its cached `.device` attribute, so every `.to(self.device)` call
      inside Qwen3TTSTokenizer.encode()/decode() lands on the right device.
      No-op when the codec can't be resolved (a perf/placement knob must
      never break a model load)."""
      speech_tokenizer = _resolve_speech_tokenizer(model)
      if speech_tokenizer is None:
          return
      speech_tokenizer.model.to(device)
      speech_tokenizer.device = torch_module.device(device)
  ```

- [ ] **Step 4: Wire the move into `_load_qwen_model`**

  In `server/tts-sidecar/main.py`, immediately after the existing block:

  ```python
              try:
                  model.device = torch.device(self._device)
              except Exception:
                  pass
  ```

  (around line 1892) and still inside the same outer `try:` (before the `# Surface the impl that actually took effect` comment), add:

  ```python
              codec_device = _resolve_codec_device(
                  os.environ.get("QWEN_CODEC_DEVICE", "cpu"), self._device
              )
              if codec_device is not None:
                  _validate_cuda_index(codec_device, torch)
                  _move_codec_to_device(model, codec_device, torch)
  ```

- [ ] **Step 5: Run the tests to verify they pass**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen3.py -k "resolve_codec_device or moves_codec_to_device or leaves_codec_on_cpu" -v`
  Expected: PASS (5 tests).

- [ ] **Step 6: Run the full sidecar fast suite to confirm no regression**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/ -m "not golden" -q`
  Expected: PASS, same pass count as before plus the 5 new tests (SKIP banner is fine if the venv isn't bootstrapped in this environment — see `npm run test:sidecar`'s existing SKIP behavior).

- [ ] **Step 7: Commit**

  ```bash
  git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
  git commit -m "feat(sidecar): move Qwen codec to GPU when QWEN_CODEC_DEVICE is set

Qwen3TTSTokenizer is a plain object, not an nn.Module, so it was
silently skipped by _load_qwen_model's existing inner.to(device)
call -- it always stayed on CPU regardless of where the Qwen model
itself loaded. Adds an explicit move + device resync, gated behind
QWEN_CODEC_DEVICE (default cpu, unchanged behavior). 'auto' mirrors
this Qwen instance's own resolved device rather than independently
probing cuda->mps->cpu, so the codec can never land on a different
card than its model.

Part of side-25 (#1374)."
  ```

---

### Task 2: OOM-safe rollback for the codec move

**Files:**
- Modify: `server/tts-sidecar/main.py` — `_move_codec_to_device` (added in Task 1)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Consumes: `_FakeCodecModel(fail_calls: frozenset)` (Task 1), `_FakeTokenizerStub(codec_model=...)` (Task 1), `_FakeQwenModel` (pre-existing).
- Modifies (same signature, no interface change): `_move_codec_to_device(model, device, torch_module) -> None`.

- [ ] **Step 1: Write the failing tests**

  Add to `server/tts-sidecar/tests/test_qwen3.py`, after the Task 1 tests:

  ```python
  def test_load_rolls_back_codec_on_oom(fake_qwen_runtime, monkeypatch) -> None:
      """A CUDA OOM partway through the codec move must roll the codec back
      to cpu -- not leave .model half-migrated. nn.Module.to() moves
      submodules in place and non-transactionally, so a naive except that
      only reset the cached .device attribute (without ALSO rolling .model
      back) would leave weights split across devices and break every
      subsequent decode()."""
      engine = fake_qwen_runtime["engine"]
      monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda:0")
      engine._device = "cuda:0"
      import qwen_tts

      failing_codec = _FakeCodecModel(fail_calls=frozenset({1}))  # move raises; rollback must succeed

      def recorder(model_id, **kwargs):
          fake_model = _FakeQwenModel(model_id)
          fake_model.model.speech_tokenizer = _FakeTokenizerStub(codec_model=failing_codec)
          return fake_model

      monkeypatch.setattr(qwen_tts.Qwen3TTSModel, "from_pretrained", recorder)

      model = engine._load_qwen_model(engine.BASE_MODEL)

      assert model is not None  # a RECOVERABLE codec OOM must not fail the whole load
      assert failing_codec.to_calls == ["cuda:0", "cpu"]  # move attempted, then rolled back
      assert failing_codec.device == "cpu"
      assert model.model.speech_tokenizer.device == "cpu"


  def test_load_propagates_when_codec_rollback_also_fails(fake_qwen_runtime, monkeypatch) -> None:
      """If even the cpu rollback raises (e.g. a poisoned CUDA context), the
      exception must propagate to _load_qwen_model's outer handler rather
      than being swallowed -- a failed load is a clean, fully-visible
      failure, never a half-migrated model handed back to a caller."""
      engine = fake_qwen_runtime["engine"]
      monkeypatch.setenv("QWEN_CODEC_DEVICE", "cuda:0")
      engine._device = "cuda:0"
      import qwen_tts

      unrecoverable_codec = _FakeCodecModel(fail_calls=frozenset({1, 2}))  # move AND rollback raise

      def recorder(model_id, **kwargs):
          fake_model = _FakeQwenModel(model_id)
          fake_model.model.speech_tokenizer = _FakeTokenizerStub(codec_model=unrecoverable_codec)
          return fake_model

      monkeypatch.setattr(qwen_tts.Qwen3TTSModel, "from_pretrained", recorder)

      with pytest.raises(RuntimeError, match="CUDA out of memory"):
          engine._load_qwen_model(engine.BASE_MODEL)
  ```

  `_FakeCodecModel`/`_FakeTokenizerStub`/`_FakeQwenModel` are module-level classes already defined in this test file (`_FakeCodecModel`/`_FakeTokenizerStub` from Task 1, `_FakeQwenModel` pre-existing) — referenced directly, not via `main.`, since they live in the test module's own namespace.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen3.py -k "rolls_back_codec_on_oom or propagates_when_codec_rollback" -v`
  Expected: FAIL — the first test fails because `_move_codec_to_device` currently has no try/except (the `RuntimeError` propagates all the way out, so `model` is never returned — `engine._load_qwen_model` raises instead of returning). The second test currently passes by accident (it also raises) — that's fine, Step 2 only needs the FIRST test to demonstrate the gap.

- [ ] **Step 3: Add the rollback**

  In `server/tts-sidecar/main.py`, replace the `_move_codec_to_device` body added in Task 1:

  ```python
  def _move_codec_to_device(model: Any, device: str, torch_module: Any) -> None:
      """Move the resolved codec (speech_tokenizer.model) to `device` and
      resync its cached `.device` attribute, so every `.to(self.device)` call
      inside Qwen3TTSTokenizer.encode()/decode() lands on the right device.

      On failure (most commonly a CUDA OOM), rolls the codec back to CPU
      explicitly -- nn.Module.to() moves submodules in place and
      non-transactionally, so merely resetting the cached `.device`
      attribute without ALSO rolling back `.model` would leave some layers
      on CUDA and the rest on CPU, and every subsequent decode() would fail
      pushing CPU inputs into a partially-CUDA model. The rollback is a
      real `.to('cpu')` call (frees GPU memory rather than allocating more
      of the scarce resource, so it doesn't share the OOM's failure mode).
      If the rollback itself raises, that exception is NOT swallowed -- it
      propagates to _load_qwen_model's outer try/except, which already
      reclaims and fails the whole load (see _load_qwen_model's
      "Reclaim-on-failure" docstring note). A failed load is a clean,
      fully-visible failure -- no half-migrated model is ever handed back
      to a caller."""
      speech_tokenizer = _resolve_speech_tokenizer(model)
      if speech_tokenizer is None:
          return
      try:
          speech_tokenizer.model.to(device)
          speech_tokenizer.device = torch_module.device(device)
      except Exception as e:
          log.warning(
              "Could not move Qwen codec to %s (%s) -- rolling back to cpu.",
              device, e,
          )
          speech_tokenizer.model.to("cpu")
          speech_tokenizer.device = torch_module.device("cpu")
  ```

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen3.py -k "rolls_back_codec_on_oom or propagates_when_codec_rollback" -v`
  Expected: PASS (2 tests).

- [ ] **Step 5: Run the full sidecar fast suite**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/ -m "not golden" -q`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
  git commit -m "fix(sidecar): roll back a failed Qwen codec GPU move to cpu

nn.Module.to() moves submodules in place and non-transactionally, so
a mid-move CUDA OOM could leave some codec layers on CUDA and the
rest on CPU -- just resetting the cached .device attribute wouldn't
roll those layers back, and decode() would then push CPU inputs into
a partially-CUDA model on every subsequent synth. The except block
now explicitly rolls .model back to cpu before resyncing .device; if
even that fails, the exception propagates to the existing
reclaim-and-fail load path instead of being swallowed.

Part of side-25 (#1374)."
  ```

---

### Task 3: Chunk-size / left-context knobs + side-19 docstring note

**Files:**
- Modify: `server/tts-sidecar/main.py:265-286` (`_maybe_compile_codec` docstring)
- Modify: `server/tts-sidecar/main.py` (add `_read_int_env`, `_apply_codec_chunk_size`; wire into `_load_qwen_model`)
- Test: `server/tts-sidecar/tests/test_qwen3.py`

**Interfaces:**
- Produces: `_read_int_env(var_name: str) -> Optional[int]`.
- Produces: `_apply_codec_chunk_size(model: Any, chunk_size: Optional[int], left_context_size: Optional[int]) -> None`.
- Consumes: `_resolve_codec_decoder(model)` (already exists, `main.py:244-252`).

- [ ] **Step 1: Write the failing tests**

  Add to `server/tts-sidecar/tests/test_qwen3.py`:

  ```python
  def test_read_int_env_parses_and_defaults(monkeypatch) -> None:
      monkeypatch.setenv("QWEN_CODEC_CHUNK_SIZE", "150")
      assert main._read_int_env("QWEN_CODEC_CHUNK_SIZE") == 150
      monkeypatch.delenv("QWEN_CODEC_CHUNK_SIZE", raising=False)
      assert main._read_int_env("QWEN_CODEC_CHUNK_SIZE") is None
      monkeypatch.setenv("QWEN_CODEC_CHUNK_SIZE", "not-a-number")
      assert main._read_int_env("QWEN_CODEC_CHUNK_SIZE") is None


  def test_load_binds_chunk_size_when_configured(fake_qwen_runtime, monkeypatch) -> None:
      """QWEN_CODEC_CHUNK_SIZE/QWEN_CODEC_LEFT_CONTEXT_SIZE bind a
      functools.partial onto the resolved decoder's chunked_decode -- the
      ONLY way to make these configurable, since
      Qwen3TTSTokenizerV2Model.decode() calls chunked_decode() with no
      arguments (verified directly against the installed qwen_tts package
      during the design's adversarial review)."""
      engine = fake_qwen_runtime["engine"]
      monkeypatch.setenv("QWEN_CODEC_CHUNK_SIZE", "150")
      monkeypatch.setenv("QWEN_CODEC_LEFT_CONTEXT_SIZE", "10")
      _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

      model = engine._load_qwen_model(engine.BASE_MODEL)

      decoder = model.model.speech_tokenizer.model.decoder
      result = decoder.chunked_decode(codes="fake-codes")
      assert result == {"chunk_size": 150, "left_context_size": 10}


  def test_load_leaves_chunk_size_at_library_defaults_when_unset(fake_qwen_runtime, monkeypatch) -> None:
      """Knobs unset -> chunked_decode is left completely untouched (its own
      300/25 defaults apply, matching today's behaviour byte-for-byte)."""
      engine = fake_qwen_runtime["engine"]
      monkeypatch.delenv("QWEN_CODEC_CHUNK_SIZE", raising=False)
      monkeypatch.delenv("QWEN_CODEC_LEFT_CONTEXT_SIZE", raising=False)
      _patch_from_pretrained(fake_qwen_runtime, monkeypatch)

      model = engine._load_qwen_model(engine.BASE_MODEL)

      decoder = model.model.speech_tokenizer.model.decoder
      result = decoder.chunked_decode(codes="fake-codes")
      assert result == {"chunk_size": 300, "left_context_size": 25}
  ```

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen3.py -k "read_int_env or chunk_size" -v`
  Expected: FAIL — `AttributeError: module 'main' has no attribute '_read_int_env'`.

- [ ] **Step 3: Implement the chunk-size wiring**

  In `server/tts-sidecar/main.py`, add after `_move_codec_to_device` (from Task 2):

  ```python
  def _read_int_env(var_name: str) -> Optional[int]:
      """Parse an integer env knob, returning None when unset or unparsable
      -- a malformed value falls back to the library default rather than
      hardening a model load into a failure."""
      raw = os.environ.get(var_name)
      if raw is None or not raw.strip():
          return None
      try:
          return int(raw.strip())
      except ValueError:
          return None


  def _apply_codec_chunk_size(
      model: Any, chunk_size: Optional[int], left_context_size: Optional[int]
  ) -> None:
      """Bind QWEN_CODEC_CHUNK_SIZE / QWEN_CODEC_LEFT_CONTEXT_SIZE onto the
      resolved codec decoder's chunked_decode, mirroring how
      _maybe_compile_codec binds a compiled forward onto the same decoder
      object. The reachable call path -- speech_tokenizer.decode() ->
      Qwen3TTSTokenizerV2Model.decode() -> decoder.chunked_decode(codes) --
      calls chunked_decode with NO arguments, so its own
      chunk_size=300/left_context_size=25 defaults always apply; there is
      no other way to make them configurable. No-op when both knobs are
      unset (library defaults apply as-is) or the decoder can't be
      resolved. Idempotent in practice: each _load_qwen_model call builds a
      fresh decoder instance, so there's no risk of wrapping an
      already-wrapped chunked_decode and nesting partials."""
      if chunk_size is None and left_context_size is None:
          return
      decoder = _resolve_codec_decoder(model)
      if decoder is None:
          return
      decoder.chunked_decode = functools.partial(
          decoder.chunked_decode,
          chunk_size=chunk_size if chunk_size is not None else 300,
          left_context_size=left_context_size if left_context_size is not None else 25,
      )
  ```

  Then wire it into `_load_qwen_model`, immediately after the `_move_codec_to_device` call added in Task 1/2:

  ```python
              codec_device = _resolve_codec_device(
                  os.environ.get("QWEN_CODEC_DEVICE", "cpu"), self._device
              )
              if codec_device is not None:
                  _validate_cuda_index(codec_device, torch)
                  _move_codec_to_device(model, codec_device, torch)
              _apply_codec_chunk_size(
                  model,
                  _read_int_env("QWEN_CODEC_CHUNK_SIZE"),
                  _read_int_env("QWEN_CODEC_LEFT_CONTEXT_SIZE"),
              )
  ```

  Finally, update the `_maybe_compile_codec` docstring (`main.py:265-269`) — change:

  ```python
      """Compile the resolved codec decoder's `forward` and stash the compiled
      callable on the model (side-19 Task 4: the decoder runs on CPU on this
      box for BOTH tiers -> inductor's cpp backend via dynamic=True; no
      CUDA-graph modes apply). We compile `forward`, NOT the whole decoder
  ```

  to:

  ```python
      """Compile the resolved codec decoder's `forward` and stash the compiled
      callable on the model (side-19 Task 4: originally written when the
      decoder ran on CPU for BOTH tiers -> inductor's cpp backend via
      dynamic=True. Since side-25, QWEN_CODEC_DEVICE can move the decoder
      onto CUDA -- inductor adapts its backend to wherever the tensors
      actually are at trace time, so this still works, but the "CPU for
      both tiers" framing below is no longer universally true. Not a
      correctness risk either way: a compile failure is swallowed to eager,
      and this knob is off by default and off on Windows). We compile
      `forward`, NOT the whole decoder
  ```

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_qwen3.py -k "read_int_env or chunk_size" -v`
  Expected: PASS (3 tests).

- [ ] **Step 5: Run the full sidecar fast suite**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/ -m "not golden" -q`
  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_qwen3.py
  git commit -m "feat(sidecar): make Qwen codec chunk_size/left_context_size configurable

decoder.chunked_decode's chunk_size/left_context_size can't be
threaded through the normal decode() call path (it calls
chunked_decode() with no arguments -- verified against the installed
qwen_tts package), so QWEN_CODEC_CHUNK_SIZE/QWEN_CODEC_LEFT_CONTEXT_SIZE
bind a functools.partial onto the decoder instance instead, mirroring
the existing _maybe_compile_codec forward-swap pattern. Also notes in
_maybe_compile_codec's docstring that its CPU-only framing no longer
universally holds now that the codec can move to CUDA.

Part of side-25 (#1374)."
  ```

---

### Task 4: Registry knobs (Advanced Settings) + `.env.example` sync

**Files:**
- Modify: `server/src/config/registry.ts:502-511` (insert 3 new `ConfigKnob` entries after `tts.qwen.attnImpl`, before the `PRELOAD_COQUI` entry)
- Modify: `server/.env.example` (regenerated, not hand-edited)
- Test: `server/src/config/registry.test.ts`

**Interfaces:**
- Consumes: `ConfigKnob`/`ConfigGroup` types (`server/src/config/types.ts`, unchanged).
- Produces: registry entries with keys `tts.qwen.codecDevice`, `tts.qwen.codecChunkSize`, `tts.qwen.codecLeftContextSize` — consumed generically by `GET /api/config` (`server/src/routes/config.ts`), no route changes needed.

- [ ] **Step 1: Write the failing test**

  Add to `server/src/config/registry.test.ts` (following the existing style, e.g. near the `ANALYZER_KEEP_ALIVE` test):

  ```typescript
  it('registers the three Qwen codec-placement knobs with cpu/300/25 defaults', () => {
    const device = getKnob('tts.qwen.codecDevice');
    const chunkSize = getKnob('tts.qwen.codecChunkSize');
    const leftContext = getKnob('tts.qwen.codecLeftContextSize');
    expect(device?.env).toBe('QWEN_CODEC_DEVICE');
    expect(device?.default).toBe('cpu');
    expect(chunkSize?.env).toBe('QWEN_CODEC_CHUNK_SIZE');
    expect(chunkSize?.default).toBe(300);
    expect(leftContext?.env).toBe('QWEN_CODEC_LEFT_CONTEXT_SIZE');
    expect(leftContext?.default).toBe(25);
    [device, chunkSize, leftContext].forEach((k) => {
      expect(k?.group).toBe('tts-engine');
      expect(k?.apply).toBe('restart-sidecar');
      expect(k?.risk).toBe('high');
    });
  });
  ```

- [ ] **Step 2: Run the test to verify it fails**

  Run: `cd server && npx vitest run src/config/registry.test.ts`
  Expected: FAIL — `getKnob('tts.qwen.codecDevice')` returns `undefined`.

- [ ] **Step 3: Add the registry entries**

  In `server/src/config/registry.ts`, insert after the `tts.qwen.attnImpl` entry (ends at line 511, right before the `PRELOAD_COQUI` entry at line 512):

  ```typescript
    {
      key: 'tts.qwen.codecDevice',
      env: 'QWEN_CODEC_DEVICE',
      group: 'tts-engine',
      label: 'Qwen codec device',
      help: '"cpu" (default) keeps the Code2Wav codec decode on CPU, matching today\'s behaviour. "auto" moves it onto whichever device this Qwen instance itself resolved to (NOT an independent cuda→mps→cpu probe — it always follows the model, so the codec can never land on a different card). Pin an explicit "cuda:1" to force a specific card regardless of where the model landed. Changing this requires a sidecar restart.',
      type: 'device',
      default: 'cpu', // ← QWEN_CODEC_DEVICE default in tts-sidecar/main.py (_resolve_codec_device)
      apply: 'restart-sidecar', risk: 'high',
    },
    {
      key: 'tts.qwen.codecChunkSize',
      env: 'QWEN_CODEC_CHUNK_SIZE',
      group: 'tts-engine',
      label: 'Qwen codec chunk size',
      help: 'Codec decode chunk size (time-axis frames). Bounds the GPU activation peak when tts.qwen.codecDevice moves the codec off CPU — lower it if a tight card OOMs during decode. Library default 300; unset uses that default unchanged. No effect while the codec stays on CPU. Changing this requires a sidecar restart.',
      type: 'integer', min: 1,
      default: 300, // ← chunked_decode's own chunk_size default in the qwen_tts package
      apply: 'restart-sidecar', risk: 'high',
    },
    {
      key: 'tts.qwen.codecLeftContextSize',
      env: 'QWEN_CODEC_LEFT_CONTEXT_SIZE',
      group: 'tts-engine',
      label: 'Qwen codec left-context size',
      help: 'Codec decode left-context overlap (time-axis frames) between chunks. Library default 25; unset uses that default unchanged. Larger values cost more overlap compute for smoother chunk boundaries. No effect while the codec stays on CPU. Changing this requires a sidecar restart.',
      type: 'integer', min: 0,
      default: 25, // ← chunked_decode's own left_context_size default in the qwen_tts package
      apply: 'restart-sidecar', risk: 'high',
    },
  ```

- [ ] **Step 4: Run the test to verify it passes**

  Run: `cd server && npx vitest run src/config/registry.test.ts`
  Expected: PASS.

- [ ] **Step 5: Regenerate `.env.example` and verify it's in sync**

  Run: `npm run config:sync`
  Then: `npm run config:check`
  Expected: `config:sync` reports the file updated; `config:check` (the real registry↔`.env.example` drift gate — `server/scripts/sync-env-example.ts --check`) exits 0, confirming the on-disk file's managed block now matches the registry exactly. (`env-example.test.ts` only asserts `renderManagedBlock()`'s in-memory shape — markers present, two sentinel env names — it never reads the on-disk file, so `config:check` is the step that actually verifies the commit below.)

- [ ] **Step 6: Run the full server suite**

  Run: `cd server && npm run test`
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add server/src/config/registry.ts server/src/config/registry.test.ts server/.env.example
  git commit -m "feat(server): add Qwen codec placement knobs to the config registry

QWEN_CODEC_DEVICE/QWEN_CODEC_CHUNK_SIZE/QWEN_CODEC_LEFT_CONTEXT_SIZE
join the registry-driven Advanced Settings UI (GET /api/config serves
GROUPS + every KNOBS entry generically -- no separate frontend wiring
needed). Regenerated .env.example via npm run config:sync.

Part of side-25 (#1374)."
  ```

---

### Task 5: Real-model smoke test — 0.6B-Base + VoiceDesign codec placement

**Files:**
- Create: `server/tts-sidecar/tests/test_codec_device_smoke.py`

**Interfaces:**
- Consumes: `main.QwenEngine`, `main._resolve_speech_tokenizer` (both pre-existing), `_resolve_codec_device`/`_move_codec_to_device` (Task 1/2, exercised indirectly via `_load_qwen_model`).

This is the smoke coverage for the two load call-sites `test_instruct_golden.py` doesn't touch (it only covers the 1.7B-Base 12Hz decode path). It needs real Qwen weights + CUDA and SKIPs cleanly otherwise — it cannot be made to PASS in an environment without those, only to SKIP correctly. Verify the SKIP path here; the acceptance run (Task 6) is where it actually executes for real.

- [ ] **Step 1: Write the test file**

  Create `server/tts-sidecar/tests/test_codec_device_smoke.py`:

  ```python
  """side-25 acceptance smoke: codec-on-GPU correctness for the 0.6B-Base and
  VoiceDesign paths (see docs/superpowers/specs/2026-07-06-side25-qwen-codec-
  gpu-design.md). tests/golden/test_instruct_golden.py already covers the
  1.7B-Base 12Hz decode path at golden tolerances; it does NOT touch these
  other two load call-sites at all. This file is a SMOKE check, not a
  quality-parity claim: it asserts the codec decodes on both cpu and
  QWEN_CODEC_DEVICE=auto without erroring and produces output of the same
  length/sample-rate -- not that the two outputs sound identical.

  Needs real Qwen weights + CUDA; SKIPs cleanly otherwise (same gate shape as
  tests/test_instruct_synth.py's requires_qwen_gpu / conftest._qwen_weights_present).
  """
  from __future__ import annotations

  import sys
  from pathlib import Path

  import pytest

  SIDECAR_ROOT = Path(__file__).resolve().parent.parent
  if str(SIDECAR_ROOT) not in sys.path:
      sys.path.insert(0, str(SIDECAR_ROOT))

  import main  # noqa: E402


  def _qwen_gpu_available() -> bool:
      """True when qwen_tts + torch + CUDA are all present. Mirrors
      conftest._qwen_weights_present() / test_instruct_synth.py's local copy."""
      try:
          import qwen_tts  # noqa: F401
          import torch  # noqa: F401
          return torch.cuda.is_available()
      except Exception:
          return False


  requires_qwen_gpu = pytest.mark.skipif(
      not _qwen_gpu_available(),
      reason="Qwen weights / CUDA not available on this box (side-25 codec smoke skipped)",
  )


  def _round_trip(model, synthetic_audio):
      """Encode a short synthetic sine wave through the model's own codec and
      decode it straight back -- exercises exactly the encode/decode path the
      placement fix touches, without needing a designed voice or the full
      synthesize() pipeline."""
      tokenizer = main._resolve_speech_tokenizer(model)
      encoded = tokenizer.encode(synthetic_audio, sr=24000)
      return tokenizer.decode(encoded)


  @requires_qwen_gpu
  @pytest.mark.parametrize("model_attr", ["BASE_MODEL", "VOICEDESIGN_MODEL"])
  def test_codec_decode_matches_length_cpu_vs_auto(model_attr: str, monkeypatch) -> None:
      """0.6B-Base and VoiceDesign codec placement smoke check: decoding the
      same short probe through QWEN_CODEC_DEVICE=cpu vs =auto must produce
      the same output length and sample rate."""
      import numpy as np

      synthetic_audio = np.sin(
          np.linspace(0, 440 * 2 * np.pi, 24000)
      ).astype(np.float32)  # 1s @ 24kHz, 440Hz tone

      monkeypatch.setenv("QWEN_CODEC_DEVICE", "cpu")
      engine_cpu = main.QwenEngine()
      engine_cpu._ensure_device_resolved()
      model_id = getattr(engine_cpu, model_attr)
      model_cpu = engine_cpu._load_qwen_model(model_id)
      wavs_cpu, sr_cpu = _round_trip(model_cpu, synthetic_audio)

      monkeypatch.setenv("QWEN_CODEC_DEVICE", "auto")
      engine_gpu = main.QwenEngine()
      engine_gpu._ensure_device_resolved()
      model_gpu = engine_gpu._load_qwen_model(model_id)
      wavs_gpu, sr_gpu = _round_trip(model_gpu, synthetic_audio)

      assert sr_cpu == sr_gpu
      assert len(wavs_cpu[0]) == len(wavs_gpu[0])
      assert len(wavs_cpu[0]) > 0
  ```

- [ ] **Step 2: Run it to confirm the SKIP path (this environment has no Qwen weights)**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_codec_device_smoke.py -v`
  Expected: `2 skipped` with reason `"Qwen weights / CUDA not available on this box (side-25 codec smoke skipped)"`. This is the correct, passing outcome in an environment without real weights — do NOT try to force it to execute here.

- [ ] **Step 3: Run the full sidecar fast suite to confirm no collection errors**

  Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/ -m "not golden" -q`
  Expected: PASS (the new file collects cleanly and SKIPs; no import errors).

- [ ] **Step 4: Commit**

  ```bash
  git add server/tts-sidecar/tests/test_codec_device_smoke.py
  git commit -m "test(sidecar): add codec-on-GPU smoke check for 0.6B-Base + VoiceDesign

test_instruct_golden.py only covers the 1.7B-Base 12Hz decode path.
This smoke test covers the two load call-sites it doesn't touch --
a correctness check (decodes without erroring, same output length/
sample-rate cpu vs auto), not a quality-parity claim. Requires real
Qwen weights + CUDA; SKIPs cleanly otherwise.

Part of side-25 (#1374)."
  ```

---

### Task 6: On-box acceptance run (manual — NOT subagent-executable)

**This task has no code changes and cannot be executed inside an implementation session** — it needs a real GPU, real Qwen weights, and an overnight full-book run. It is the explicit final step of the plan (per the spec's Phase 3), not folded into "implementation complete." Whoever runs this should do it directly, not delegate it to a coding subagent.

- [ ] **Step 1**: On the target box, set `QWEN_CODEC_DEVICE=auto` in `server/.env` (leave `QWEN_CODEC_CHUNK_SIZE`/`QWEN_CODEC_LEFT_CONTEXT_SIZE` unset for the first pass — library defaults). `--voice` below must be an ALREADY-DESIGNED voice ID from your library — Qwen fails fast on an undesigned voice, so substitute one you already have (e.g. the Coalfall narrator voice `test_instruct_golden.py` uses) rather than a placeholder.
- [ ] **Step 2**: Run `python server/tts-sidecar/scripts/bench-tts.py --engine qwen --voice <your-designed-voice-id> --code2wav-share --batch 32` (requires `QWEN_CODEC_TIMING=1` in the sidecar env, and the Qwen 0.6B-Base loaded — the tool's own header comment, `bench-tts.py:43-46`, spells out this exact invocation) and confirm the codec's share of batch compute drops from ~50% toward the projected ~single-digit/low-teens percent.
- [ ] **Step 3**: Run `python server/tts-sidecar/scripts/bench-tts.py --engine qwen --voice <your-designed-voice-id> --batch 16 --mem-sample --batches 200` (the tool's own canonical `--mem-sample` invocation, `bench-tts.py:37-38` — `--batches` defaults to 200 to match the scale of the original leak experiment; don't shrink it, a short run won't reveal a slow committed-RAM slope) and confirm the plateau flattens (target: ≤ ~12GB with a roughly flat slope, vs ~24GB today). If it doesn't, that's where `QWEN_CODEC_CHUNK_SIZE` gets tuned down — re-run after lowering it, at the SAME `--batch 16` the issue's numbers were measured at (chunk size alone does not bound the `batch_size × chunk_size` peak — see the spec's "Out of scope" note on a batch-size cap being a distinct follow-up if this doesn't converge).
- [ ] **Step 4**: Run `npm run test:golden-audio` (Suite A, `test_instruct_golden.py`) with `QWEN_CODEC_DEVICE=auto` and confirm it still passes — this is the 1.7B-Base quality-neutrality check.
- [ ] **Step 5**: Run `server/tts-sidecar/tests/test_codec_device_smoke.py` for real (Task 5) and confirm both parametrized cases pass.
- [ ] **Step 6**: Run a full-book overnight render (the canonical fixture: `server/src/__fixtures__/the-coalfall-commission.md`) and confirm: zero VRAM-guard trips, zero host recycles, a flat committed-memory floor.
- [ ] **Step 7**: Record the measured RTF delta and the committed-memory-floor result in `docs/tts-performance.md`.
- [ ] **Step 8**: If all of the above pass, update `server/.env.example`'s `QWEN_CODEC_DEVICE` comment (in the registry help text or a nearby note) to recommend `auto` for boxes with headroom comparable to the one just tested — this is the "default-flip" Phase 2 the spec describes as a manual, per-box operator decision, not an automatic heuristic.
- [ ] **Step 9**: Update `docs/release-notes-next.md` and `RELEASE_NOTES.md` per the project's before-shipping checklist, and close/link issue #1374 in the PR.
