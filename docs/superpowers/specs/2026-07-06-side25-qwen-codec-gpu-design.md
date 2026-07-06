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
  (`tts.qwen.codecChunkSize` / `tts.qwen.codecLeftContextSize`): passed into
  the existing `chunked_decode(chunk_size, left_context_size)` call.
  Defaults 300/25 (the library's own defaults — unchanged unless set).
  Only meaningful when the codec is on GPU (bounds activation peak);
  no-ops on CPU.

All three: `apply: restart-sidecar`, `risk: high` (matches the existing
`tts.qwen.device` entry).

No new VRAM-semaphore weight: `GPU_WEIGHT_QWEN` already models the qwen
op's total VRAM cost as one number; moving the codec to GPU just makes
that number bigger for that op. Its registry help text gets a note that
`QWEN_CODEC_DEVICE=auto` requires re-tuning `GPU_WEIGHT_QWEN` upward.

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
- **Quality gate**: no new golden fixture. `test_instruct_golden.py`
  (`npm run test:golden-audio` Suite A) already blesses absolute tolerances
  (ECAPA identity cosine, per-emotion loudness, batched RTF) against a
  CPU-decoded baseline. Re-running it with `QWEN_CODEC_DEVICE=auto` is the
  quality-neutral check — fp32-on-GPU vs fp32-on-CPU should reproduce
  closely enough to pass the existing tolerances. A failure here is a real
  finding, not a fixture gap.
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
- `docs/tts-performance.md` — acceptance-run results land here.

## Depends on / relates to

- #399 (side-11 host leak) — this is its remaining-plateau facet.
- Supersedes the goal of side-19 (codec `torch.compile`, closed won't-ship):
  compilation attacked the same cost by a slower route; relocation attacks
  it directly.
- Pairs with the multi-GPU per-model placement already live.
