---
status: active
shipped: null
owner: null
---

# 115 — Opt-in FlashAttention-2 install for the Qwen TTS sidecar (Windows)

> Status: active
> Key files: `server/tts-sidecar/scripts/install-qwen3.mjs`, `scripts/tests/install-qwen3-flash-attn.test.mjs`, `server/tts-sidecar/README.md`
> URL surface: none (install-time + sidecar env)
> OpenAPI ops: none

## Benefit / Rationale

- **User / deployer:** a one-flag path to the attention backend `qwen_tts` is actually built for. `node scripts\install-qwen3.mjs --flash-attn` drops a verified prebuilt wheel into the venv — no source build, no CUDA toolkit, no compiler — on the one stack the wheel targets, and is a clean no-op everywhere else.
- **Technical:** the Qwen load path already honored `QWEN_ATTN_IMPL=flash_attention_2` (plan 112, `main.py:764`) with a graceful fallback, but the knob was inert because flash-attn was never installed. This closes that gap without touching the load code. Installing the wheel also silences the benign `flash-attn is not installed` import banner.
- **Architectural:** `SDPA` stays the default (the plan-112 decision is unchanged); FA2 is opt-in and benchmark-gated. The pure `resolveFlashAttnInstall()` gate keeps the platform/version logic testable without a venv.

## Architectural impact

### New seams / extension points

- **`--flash-attn` flag / `QWEN_INSTALL_FLASH_ATTN=1` env** on `install-qwen3.mjs` (mirrors the existing `--cpu`/`FORCE_CPU` pattern). Off by default.
- **`FLASH_ATTN_WHEEL_URL`** — single pinned source of truth for the wheel: `flash_attn 2.7.4 + cu124 + torch2.6.0 + cp311 + win_amd64`, matching the installed venv (torch `2.6.0+cu124`, CPython 3.11) exactly. Hosted on `lldacing/flash-attention-windows-wheel` (upstream `flash-attn` ships no Windows wheel on PyPI).
- **`resolveFlashAttnInstall({ enabled, platform, pyTag })`** — exported pure decision fn: installs only on `win32` + `cp311`; every other case returns `{ action: 'skip', reason }`.

### Invariants preserved

- **SDPA remains the default** (plan 112). No change to `main.py`. Activation is manual via `QWEN_ATTN_IMPL=flash_attention_2`; the default flip is a benchmark-gated follow-up, not part of this plan.
- **Installer stays cross-platform + non-fatal** (deployer-spread convention): non-Windows / non-cp311 skip with a clear line; a failed wheel install or failed `import flash_attn` warns and continues — the already-succeeded `qwen-tts` install is never aborted over the optional accelerator.
- **Module stays inert on import** — `main()` is guarded behind a direct-invocation check so the unit test can import the gate without bootstrapping a venv.

### Reversibility

Fully reversible: the flag is opt-in, the wheel is a single pip package (`pip uninstall flash-attn`), and SDPA is unaffected. Reverting the PR removes only the install step + docs.

## Invariants to preserve

- `server/tts-sidecar/main.py` `_load_qwen_model` reads `QWEN_ATTN_IMPL` (default `sdpa`) and falls back to library-default attention if the kwarg is rejected (plan 112). This plan does **not** touch that path.
- `FLASH_ATTN_WHEEL_URL` must stay matched to the installed `torch`/CUDA/CPython. If the sidecar's torch pin moves off `2.6.0+cu124` or Python off 3.11, the pinned wheel no longer loads — re-pin (and update the `resolveFlashAttnInstall` cp gate) in the same change. The `scripts/tests/install-qwen3-flash-attn.test.mjs` URL-shape assertions guard against a silent drift.

## Test plan

### Automated coverage

- node:test (`scripts/tests/install-qwen3-flash-attn.test.mjs`, run by `npm run test:hooks`) — asserts `resolveFlashAttnInstall` installs on win32+cp311, skips on darwin/linux and on cp312, skips when not opted in, and that `FLASH_ATTN_WHEEL_URL` targets `cu124torch2.6.0 … cp311-cp311-win_amd64`. Importing the installer in the test also proves it stays inert on import.
- The actual wheel install + FA2 synth path can't run in CI (Linux, no CUDA) — covered by the manual acceptance below.

### Manual acceptance walkthrough

1. **Windows box, opted in:** `node server/tts-sidecar/scripts/install-qwen3.mjs --flash-attn --skip-design` → prints the install line + wheel URL, pip succeeds, `[install-qwen3] flash_attn 2.7.4` prints.
2. **Activate + confirm:** set `QWEN_ATTN_IMPL=flash_attention_2`, restart the sidecar, load Qwen Base → model-load log reads `attn_implementation=flash_attention_2` (not a silent SDPA fallback).
3. **Skip path:** on macOS/Linux (or a non-cp311 venv) the same command prints `FlashAttention-2: skipped — …` and the installer still exits 0.
4. **Benchmark (the deciding gate):** `python scripts\bench-tts.py --engine qwen --voice <designedVoiceId>` once with `QWEN_ATTN_IMPL=sdpa` and once with `flash_attention_2` (serial + `--concurrency` sweep). Reboot first for a clean VRAM baseline. Baselines to beat on the 4070: serial RTF ~6.6–8.3, batch ~2.6. **Record the numbers here regardless of outcome.**

**Benchmark results (RTX 4070, 2026-05-26):**

SDPA default — baseline:

| Run | RTF | Note |
|---|---|---|
| Serial `/synthesize`, cold | 8.52 | first call |
| Serial `/synthesize`, warm | 6.6–8.3 | warm barely helps |
| Batch `/synthesize-batch`, 8 same-voice | 2.61 | clean best case |
| Full pipeline, real mixed-cast chapter | 4.12 | the number that actually matters |

The `flash_attention_2` comparison is **still pending** — `side-5` (the default-flip decision) stays open until those numbers land here. Note the dominant lever in this data is **batching** (2.61 batched vs 6.6–8.3 serial ≈ 3×), NOT the attention backend — that's `side-3` (true batching, in flight), and these numbers reinforce it. FA2's expected ceiling for single-token autoregressive decode is modest, so it's unlikely to move the 4.12 full-pipeline figure much regardless.

## Out of scope

- Changing the Qwen attention load code in `main.py` (already wired by plan 112).
- Flipping the `QWEN_ATTN_IMPL` default to `flash_attention_2` — benchmark-gated follow-up tracked in `docs/BACKLOG.md`.
- Linux/macOS flash-attn wheels (different matrix; this is the Windows-deployer path).
- The rest of the `side-2` warning cleanup (HF-symlink, SoX, suppressing the residual benign import banner) — owned by that backlog item.

## Ship notes

(Filled in when status flips to `stable`. Pending: the FA2-vs-SDPA benchmark outcome and the default-flip decision.)
