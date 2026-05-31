---
status: active
shipped: null
owner: null
---

# 155 — Qwen load-failure VRAM reclaim (stop failed reloads orphaning CUDA tensors)

> Status: active — code + pytest landed; live acceptance (forced OOM mid-load returns `cuda.allocated_mb` to baseline) pending.
> Key files: `server/tts-sidecar/main.py` (`QwenEngine._load_qwen_model`)
> URL surface: none (sidecar internal)
> OpenAPI ops: none
> Related: [[154-false-gemini-rate-limit-misclassify]] (the incident that surfaced this), `side-11` (the host-RAM leak that *forces* the recycles), [[143-sidecar-process-recycle]]

## The finding (2026-05-31, KOTLC *Stellarlune* CH24 investigation)

While diagnosing the false "Gemini rate-limited" stop (plan 154), the live sidecar's
`/debug/memory` showed — with **every engine `*_loaded: false`** — `cuda.allocated_mb
≈ 9889`, `cuda.reserved_mb ≈ 13117`, host `rss ≈ 17 GB`, `committed ≈ 28 GB`. Allocated
≈ 9.9 GB of **live CUDA tensors with no model loaded** = an orphaned-tensor leak on a
card with only 8 GB physical, which oversubscribed VRAM (WDDM spill → RTF collapse) and
forced the recycle that broke CH24. The user's read was exact: *"oversubscription came
from Qwen reloads failing."*

## Root cause

`QwenEngine._load_qwen_model` had **no reclaim on its failure path**. The shape:

```python
model = Qwen3TTSModel.from_pretrained(model_id, ...)   # materialises weights (CPU)
inner.to(self._device)                                  # moves to GPU — can OOM here
return model
# _ensure_*_loaded: self._base = self._load_qwen_model(...)  # assigns only on success
```

When `inner.to(device)` (or `from_pretrained`) raises **partway through** — the common
case under existing VRAM pressure — the partially-built `Qwen3TTSModel` is an `nn.Module`
whose reference **cycles** keep its tensors alive past the failing frame (refcount alone
won't free them; that needs `gc.collect()`). And `_ensure_*_loaded` never assigned it to
`self._base`/`self._design`, so nothing reclaimed it either. Every failed reload then
accumulated its partial allocation → the measured 9.9 GB. `unload()` already does the
right thing (`gc.collect()` + `empty_cache()`); the load path simply never mirrored it.

## The fix

`_load_qwen_model` now wraps the materialise + move + finalise in a `try/except`: on any
exception it drops the partial (`model = None`) and runs the shared
`_reclaim_host_and_vram()` (gc + `empty_cache`) before re-raising — so a failed (re)load
leaves the allocator exactly where it started. `_ensure_base_loaded` /
`_ensure_design_loaded` are unchanged (they already assign only on success, so the
reclaim inside `_load_qwen_model` covers them).

## Test plan

Automated — `server/tts-sidecar/tests/test_qwen_load_reclaim.py` (3 cases, green; CI has
no GPU so they pin the reclaim-on-failure CONTRACT, not byte counts):
- a load whose `inner.to(device)` raises runs `_reclaim_host_and_vram` exactly once before
  re-raising;
- `_ensure_base_loaded` / `_ensure_design_loaded` leave `_base` / `_design` `None` on a
  failed load (no half-built model left assigned) and reclaim.
- Existing `test_batch_synthesis.py` / `test_runtime_wiring.py` / `test_qwen3.py` stay green
  (the happy-path load is unchanged).

Manual acceptance (pending live GPU): force a mid-load OOM (e.g. load with the card
near-full) and confirm `/debug/memory` `cuda.allocated_mb` returns to baseline after the
failure instead of climbing across retries.

## Scope

This stops *failed reloads* from orphaning VRAM. It does **not** address the separate
committed-host variable-shape leak that makes the watchdog recycle in the first place
(`side-11`, plan 153's MKLDNN A/B) or the recycle-at-chapter-boundary mitigation (`side-11`
next round) — both tracked in `docs/BACKLOG.md`.
