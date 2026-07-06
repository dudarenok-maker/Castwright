---
status: draft
---

# side-25 — Move the Qwen Code2Wav codec decode to GPU

Issue: #1374 · Backlog: `side-25` · MoSCoW: should

## Problem

The Qwen Code2Wav codec (`speech_tokenizer.decode` → `chunked_decode`) runs on
CPU today even though the Qwen forward pass runs on CUDA. Measured on the
1.7B tier with 16-item seeded batches (2026-07-06, side-11 root-cause
session):

- **RTF**: decode takes 36–44s per batch against ~75–110s total `gen_ms` —
  40–50% of every batch. A conv-stack decode of this size typically runs
  20×+ faster on GPU (~1–3s/batch), projecting aggregate batch RTF from
  ~0.6–0.9 down to roughly 0.4–0.5.
- **Memory**: the decode's multi-GB transient activations churn through the
  Windows heap, leaving a ~24GB committed / ~16.5GB RSS plateau between
  batches — the remaining facet of the side-11 host-leak investigation
  (#399) not explained by the oneDNN primitive cache (already capped) or
  pinned staging (confirmed zero). On GPU those activations live in the
  torch CUDA allocator, which is already guarded and properly recycled.
- It also retires the "MKLDNN is load-bearing" coupling (plan-153) since
  there's no CPU conv path left in the hot loop.

## Root cause (confirmed by reading the installed `qwen_tts` package)

`Qwen3TTSTokenizer` (`qwen_tts/inference/qwen3_tts_tokenizer.py`) is a plain
Python object, **not an `nn.Module`**. It holds the real decoder at
`.model` and caches a `.device` attribute separately, used by every
`.to(self.device)` call inside `encode()`/`decode()`.

The composite Qwen model attaches it via a plain assignment
(`self.speech_tokenizer = speech_tokenizer` in
`modeling_qwen3_tts.py::load_speech_tokenizer`) — since it isn't an
`nn.Module`, PyTorch's `nn.Module.__setattr__` never registers it as a
submodule. So `_load_qwen_model`'s existing `inner.to(self._device)` call
(`server/tts-sidecar/main.py:1886`) **silently never reaches it** — the
codec stays wherever `Qwen3TTSTokenizer.from_pretrained` originally loaded
it (CPU, since no `device_map` is passed).

This means Phase 0 is not a "does `.to()` work" spike — it's a known,
mechanical gap: explicitly move `speech_tokenizer.model` and resync the
cached `speech_tokenizer.device` right after the existing `inner.to(...)`
call.

**Verified only for the 12Hz decode path** (the hot path this issue targets):
traced `decode()` → `Qwen3TTSTokenizerV2Model.decode()` → `decoder.
chunked_decode()` end to end — no hardcoded `.cpu()` calls anywhere in that
chain except the correct final output marshalling
(`w.detach().cpu().numpy()`). The 25Hz encode path (`Qwen3TTSTokenizerV1*`,
used for VoiceDesign ref-audio encode/xvector/ref-mel) has more device
juggling (`tokenizer.py:340–352`) and was **not** traced the same way — Phase
0's implementation task includes tracing it before claiming the fix is
uniform across all three load call-sites. Similarly, whether
`Qwen3TTSModel.from_pretrained` (the wrapper's own `from_pretrained`,
`inference/qwen3_tts_model.py`) does anything with device placement for the
tokenizer internally has not been read — Phase 0 confirms this by reading
that file, not by assumption.

## Design

### Placement fix

In `_load_qwen_model` (`server/tts-sidecar/main.py`), immediately after the
existing `inner.to(self._device)` call: resolve
`speech_tokenizer = _resolve_speech_tokenizer(model)` and, when the codec
device knob resolves to CUDA, move `speech_tokenizer.model.to(device)` and
reassign `speech_tokenizer.device = torch.device(device)`. Applies
uniformly to all three load call-sites (0.6B-Base, 1.7B-Base,
VoiceDesign) since they all route through `_load_qwen_model`.

### Knobs (new registry entries, `tts-engine` group, next to `tts.qwen.device`)

- **`QWEN_CODEC_DEVICE`** (`tts.qwen.codecDevice`): `cpu` (default — today's
  behavior) | `auto` (mirror this Qwen instance's already-resolved
  `self._device`) | explicit `cuda`/`cuda:N` (pin regardless of where the
  model landed).

  `auto` here deliberately does **not** mean "independently probe
  cuda→mps→cpu" the way `QWEN_DEVICE=auto` does — the codec is loaded
  inside `_load_qwen_model` where `self._device` is already a *concrete*
  resolved device by the time this runs. `auto` means "use that value,
  whatever it is," so the codec can never end up on a different card than
  its own model. This is documented explicitly in the knob's help text to
  avoid confusion with the pre-existing `auto` grammar.

- **`QWEN_CODEC_CHUNK_SIZE`** / **`QWEN_CODEC_LEFT_CONTEXT_SIZE`**
  (`tts.qwen.codecChunkSize` / `tts.qwen.codecLeftContextSize`): defaults
  300/25 (the library's own defaults — unchanged unless set).

  **Wiring correction (caught in adversarial review):** the reachable call
  path is `speech_tokenizer.decode()` → `Qwen3TTSTokenizerV2Model.decode()`
  → `self.decoder.chunked_decode(audio_codes.transpose(1, 2))`
  (`modeling_qwen3_tts_tokenizer_v2.py:1015`) — called with **no
  arguments**, so `chunk_size`/`left_context_size` always fall back to
  `chunked_decode`'s own hardcoded defaults (300/25). Neither wrapper
  `decode()` accepts or threads these params. There is no "existing call"
  to pass them into. The only way to make them configurable is to bind them
  onto the resolved decoder instance, the same way `_maybe_compile_codec`
  already binds a compiled `forward` (`main.py:265–286`):
  `_resolve_codec_decoder(model)` already resolves `st.model.decoder`; at
  load time, when either knob differs from the library default, replace
  `decoder.chunked_decode` with
  `functools.partial(decoder.chunked_decode, chunk_size=N,
  left_context_size=M)` bound onto the instance (mirrors the existing
  `decoder.forward` swap pattern, so no new pattern is introduced).

  **Interaction with the side-19 compile wrapper**: `chunked_decode` calls
  `self(codes_chunk)` per chunk, i.e. `decoder.forward` — whichever forward
  is currently installed (eager or the `QWEN_COMPILE_CODEC`-compiled one via
  `_codec_compiled_for_batch`). Binding a chunk-size partial onto
  `chunked_decode` and swapping `forward` are two different attributes on
  the same object, so they compose without conflict: the chunk-size wrap
  controls the outer chunking loop, the forward-swap controls what runs
  inside each chunk. Called out explicitly since side-19 is officially
  "superseded," not deleted — its scaffolding (`_maybe_compile_codec`,
  `_codec_compiled_for_batch`) stays live in the load/batch paths and this
  fix must not silently break it.

  Only meaningful when the codec is on GPU (bounds activation peak);
  no-ops (well, harmlessly re-binds to the same defaults) on CPU.

All three: `apply: restart-sidecar`, `risk: high` (matches the existing
`tts.qwen.device` entry).

**VRAM protection — corrected framing (caught in adversarial review):** the
original draft claimed "no new VRAM-semaphore weight is needed... just
re-tune `GPU_WEIGHT_QWEN` upward," which is self-contradictory (it says no
change, then describes a change) and wrong regardless — `GPU_WEIGHT_QWEN`
gates **concurrent-op admission** (how many ops may run at once), not a
single op's internal activation peak. Retuning it does nothing to stop one
qwen batch's codec decode from OOMing alone on an otherwise-idle card. The
actual protection against that is `QWEN_CODEC_CHUNK_SIZE` (above) — smaller
chunks bound the per-op activation peak directly. These are two separate,
complementary levers and the spec should not conflate them:
- `GPU_WEIGHT_QWEN` / the VRAM semaphore: protects against **concurrent**
  ops (e.g. Qwen + Kokoro both resident) collectively exceeding the card.
  Operators enabling `QWEN_CODEC_DEVICE=auto` on a tight card should
  re-tune this upward to reflect the qwen op's now-larger footprint — this
  remains true, just stated as its own thing, not as "instead of" chunk
  sizing.
- `QWEN_CODEC_CHUNK_SIZE`: protects against a **single** op's peak. Phase 1
  measures the actual peak at the default 300 on the 8GB box (`bench-tts.py
  --mem-sample` with `QWEN_CODEC_DEVICE=auto`) and only lowers the default
  if that measurement shows it's needed — per the earlier scoping decision,
  the knob ships regardless, but its *default value* is decided by
  measurement, not assumed safe.

### Error handling

The `speech_tokenizer.model.to(device)` move is wrapped in its own
try/except, separate from the outer model-load try/except. A CUDA OOM here
logs a warning and leaves the codec on CPU (both `.model` and the cached
`.device`) rather than failing the whole Qwen load. This is all-or-nothing
per attempt (never a half-moved codec) since `decode()` assumes a
consistent device across `.model` and the cached `.device`.

### Testing

- **Sidecar pytest**: new cases (alongside the existing
  `QWEN_DEVICE`/`_resolve_torch_device` tests) covering `QWEN_CODEC_DEVICE`
  parsing (`cpu`/`auto`/`cuda:N`), the default (`cpu`), and OOM-fallback-to-
  CPU via a mocked `.to()` raising `torch.cuda.OutOfMemoryError`.
- **Quality gate — scoped honestly (corrected in adversarial review):**
  `test_instruct_golden.py` (`npm run test:golden-audio` Suite A) covers
  **only** the 1.7B-Base live-instruct 12Hz decode path, with one voice and
  one passage, at tolerances calibrated for on-box sampling variance
  (identity cosine headroom ~0.10, loudness ±4dB) — coarse enough to catch
  gross breakage, not fine enough to certify subtle numerical parity. This
  is a real regression net for the one path it covers, not proof of
  quality-neutrality overall, and the design does not claim otherwise.
  Re-running it with `QWEN_CODEC_DEVICE=auto` is still the right first
  check — a failure is a real finding — but it leaves the 0.6B-Base and
  VoiceDesign/25Hz encode paths with **zero** golden coverage, since no
  existing fixture touches them.
  - **New smoke coverage** (sidecar pytest, not golden-gated): for the
    0.6B-Base and VoiceDesign paths, add a cheap correctness check — decode
    a short fixed input on both `QWEN_CODEC_DEVICE=cpu` and `=auto`, assert
    output length/sample-rate match and no exception — gated the same way
    other real-model sidecar tests are (skips cleanly without weights).
    This is a smoke check (catches "it crashes" / "wildly wrong length"),
    explicitly not a quality-parity claim the way the golden suite is for
    the 1.7B path.
  - No new golden *fixture* is added — the gap on the other two paths is
    covered by the smoke check above, not by extending the golden suite.
    If the on-box acceptance run (Phase 3) surfaces an audible quality
    difference on either uncovered path, that becomes its own follow-up
    (a new golden fixture), not something this spec pre-builds speculatively.
- **Measurement**: reuse `bench-tts.py --code2wav-share` (codec share of
  batch time) and `--mem-sample` (committed-RAM plateau) as-is — both
  already exist and are what the issue's numbers were measured with.

### Rollout and acceptance (manual, on-box)

- **Default-flip (Phase 2)**: registry default stays `cpu` everywhere — no
  automatic VRAM-threshold heuristic. `server/.env.example` gets a comment
  documenting the recommended setting once the on-box run validates it.
  Flipping `QWEN_CODEC_DEVICE=auto` on a given box is a manual operator
  decision, made after that box's acceptance run passes.
- **Acceptance (Phase 3)**: full-book overnight run with
  `QWEN_CODEC_DEVICE=auto` — flat committed floor, zero VRAM-guard trips,
  zero host recycles, RTF delta recorded into `docs/tts-performance.md`.
  This cannot happen inside an implementation session (needs real GPU +
  hours) — it is the explicit final task of the plan, not folded into
  "implementation complete."
- **Watch item**: the side-11 floor-guard fix (torch-reserved ≥256MB skip)
  just landed for exactly this reason — moving more legitimate work onto
  CUDA reserved memory. The codec move shouldn't reintroduce a
  false-positive recycle, but the overnight run should watch for it given
  the recent history.

## Out of scope

Deferred as follow-ups, only if fp32 + chunk-size tuning don't shape VRAM
enough on their own:

- bf16 codec decode (explicitly the riskiest lever per the issue; needs its
  own golden-audio gating).
- Sub-batch grouping of the codec decode.
- Automatic VRAM-threshold default-flip heuristic (mirroring
  `GPU_SAFE_COEXIST_MB`'s pattern) — a manual per-box flip is simpler and
  has no new failure modes.

## Key files

- `server/tts-sidecar/main.py` — `_load_qwen_model`, `_resolve_speech_tokenizer`,
  codec-timing hooks.
- `server/src/config/registry.ts` — new knobs.
- `server/.env.example` — new knobs + rollout guidance comment.
- `server/tts-sidecar/scripts/bench-tts.py` — already instrumented
  (`--code2wav-share`, `--mem-sample`), no changes needed.
- `server/tts-sidecar/tests/` — new device-knob parsing/fallback cases +
  the 0.6B/VoiceDesign codec-placement smoke check.
- `docs/tts-performance.md` — acceptance-run results land here.

## Depends on / relates to

- #399 (side-11 host leak) — this is its remaining-plateau facet.
- Supersedes the goal of side-19 (codec `torch.compile`, closed won't-ship):
  compilation attacked the same cost by a slower route; relocation attacks
  it directly.
- Pairs with the multi-GPU per-model placement already live.
