# A12 — device-pin resolution across a GPU enumeration-order change (2026-09-20, #3296)

Register row: `docs/testing/onbox-acceptance-register.md` §A12
([#1870](https://github.com/dudarenok-maker/Castwright/pull/1870),
closes [#1857](https://github.com/dudarenok-maker/Castwright/issues/1857)).

**Verdict: the owed bullet's behaviour CONFIRMED on real 2-card hardware.**

## Box

| Card | torch / sidecar canonical UUID | nvidia-smi form |
| --- | --- | --- |
| NVIDIA GeForce RTX 4070 Laptop GPU | `1831b67f-ccc0-c3fc-9167-cff059c3224c` | `GPU-1831b67f-…` |
| NVIDIA GeForce RTX 5070 Ti | `73e7270e-ff5b-d1a2-de93-bc83af87699d` | `GPU-73e7270e-…` |

## Method (read-only, no model load, no reboot, nothing shared disturbed)

Each boot spawned a **fresh Python process importing the real sidecar module**
(`server/tts-sidecar/main.py`) with respawn-shaped env — i.e. the raw
`QWEN_DEVICE=cuda-uuid:<bare uuid>` literal `buildSidecarEnv` hands the sidecar
after #1870, never a translated `cuda:N`. The pin is resolved during module
import / engine construction (`_engine_env_pin` at `main.py:4115` →
`_resolve_uuid_to_index` at `main.py:4086` → `_validate_cuda_index` at
`main.py:5850`; codec via `_codec_device_pref` at `main.py:804`), so importing
*is* the path a supervisor respawn takes. The probe asserted the engine's model
was **not** loaded at import (`QWEN._model is None` at every boot), so no
weights were read and no VRAM moved — other lanes on this box were untouched.

**How the enumeration order was changed.** `CUDA_DEVICE_ORDER` does not renumber
these two cards (`PCI_BUS_ID` and `FASTEST_FIRST` both give `0=4070, 1=5070 Ti` —
boots B8/B9), so the row's suggested lever is inert on this hardware pairing. The
order was changed instead by permuting the visible-device list at spawn
(`CUDA_VISIBLE_DEVICES=1,0`). That flips which physical card torch enumerates as
index 0 — the uuid↔index map the sidecar resolves against is inverted — which is
the state a physical swap produces, while each card keeps its own UUID.

## Boot matrix

| Boot | Enumeration (idx=card) | `QWEN_DEVICE` | Resolved | Lands on | `_validate_cuda_index` | `uuid_ok` |
| --- | --- | --- | --- | --- | --- | --- |
| B1 default | 0=4070, 1=5070 Ti | `cuda-uuid:73e7270e-…` | `cuda:1` | **RTX 5070 Ti** | ok | True |
| B2 **reversed** (1,0) | 0=5070 Ti, 1=4070 | `cuda-uuid:73e7270e-…` | `cuda:0` | **RTX 5070 Ti** | ok | True |
| B3 default again | 0=4070, 1=5070 Ti | `cuda-uuid:73e7270e-…` | `cuda:1` | **RTX 5070 Ti** | ok | True |
| B4 counterfactual | 0=5070 Ti, 1=4070 | `cuda:1` (stale from B1) | `cuda:1` | RTX 4070 Laptop | ok (**silent wrong card**) | — |
| B5 counterfactual | 0=5070 Ti only | `cuda:1` | `cuda:1` | — | `ValueError: cuda:1 out of range; only 1 CUDA device(s) visible` | — |
| B6 control | 0=5070 Ti only | `cuda-uuid:0000…0000` | `auto` | — | ok | False |
| B7 control | 0=4070, 1=5070 Ti | `cuda-uuid:GPU-73e7270e-…` | `auto` | — | ok | False |
| B8 `PCI_BUS_ID` | 0=4070, 1=5070 Ti | `cuda-uuid:73e7270e-…` | `cuda:1` | RTX 5070 Ti | ok | True |
| B9 `FASTEST_FIRST` | 0=4070, 1=5070 Ti | `cuda-uuid:73e7270e-…` | `cuda:1` | RTX 5070 Ti | ok | True |


Codec pin (`QWEN_CODEC_DEVICE=cuda-uuid:1831b67f-…`, the 4070) resolved
`cuda:0` under B1/B3 and `cuda:1` under B2 — it followed the card across the
renumber the same way, `validate=ok` in both orders. Under B6/B7 the codec pin
fell to `cpu`, logging
`QWEN_CODEC_DEVICE=… did not match any visible GPU -- leaving the codec on cpu.`
(`main.py:830-836`) — not onto the model's card, matching what the 2026-09-08
run confirmed for bullet 3.

## What this proves

1. **A respawn finds the pinned card by UUID after the enumeration order
   changes** (B1 vs B2): the resolved index moved `cuda:1 → cuda:0`, the landing
   card did not move, and the UUID torch reports for the landing device equals
   the pin in both orders. Neither a `_validate_cuda_index` failure nor a
   wrong-card landing.
2. **Repeated respawn is deterministic** (B3 ≡ B1, same resolution).
3. **The pre-#1870 shape fails exactly as the row predicts**: a translated
   `cuda:1` replayed under the new order lands on the wrong physical card and
   validation *passes* (B4) — a stale in-range index is undetectable by the
   guard — or raises `ValueError: cuda:1 out of range; only 1 CUDA device(s)
   visible` when the slot is gone (B5), the `_validate_cuda_index` failure mode
   named in the bullet.
4. **Unresolvable pins fall back rather than crash** (B6 → `auto`,
   `QWEN_UUID=uuid_unresolved` in the resolved pin).
5. **Canonical form is the bare UUID, not the `GPU-` prefixed string.**
   `_resolve_uuid_to_index` compares exact strings against
   `str(uuid.UUID(torch.cuda.get_device_properties(i).uuid))`, which carries no
   `GPU-` prefix; `nvidia-smi -L` prints one. B7 shows the prefixed spelling
   does not resolve. The shipped path is self-consistent — `toUuidForm()`
   (`server/src/routes/gpu-uuid.ts:32-43`) stores `cuda-uuid:${card.uuid}` built
   from the sidecar's own `/devices` UUIDs — so this is a hand-editing footgun in
   `tts.qwen.device` / `tts.qwen.codecDevice`, **not** a product defect, and was
   not filed as one.
6. **`CUDA_DEVICE_ORDER` is not a usable renumbering lever on this box** (B8/B9
   byte-identical) — worth remembering for any future row that assumes it is.

## Scope boundary (stated plainly)

The end-to-end `PUT /api/config` → forced respawn (`POST /api/sidecar/restart`) →
`GET /health` leg on both cards was already confirmed by the 2026-09-08 run
(step 9, #2954, `step-5-a12.md`) *without* an order change. What this run drove
is the one variable that run deliberately excluded — enumeration order changing
between boots — in the process where that variable is actually decided (the
sidecar at import), fed the exact env shape `buildSidecarEnv` produces post-#1870.
The shared dev server was not restarted and its supervisor loop was not
re-driven, because this box still runs other lanes; a fully end-to-end pass under
a renumbered order would need the server itself respawned under
`CUDA_VISIBLE_DEVICES=1,0`, i.e. a whole-box-exclusive window.

## Reproduce

Probe + driver were kept out of the repo (scratch-only, read-only against the
product tree):
`%TEMP%\open-engine-scratch\cline-qwen-cloud-3296-20260919-231916\a12probe.py`
and `a12drive2.ps1`. Raw transcript:
`a12-enumeration-2026-09-20-evidence.txt` beside this file, and verbatim below.

```text
### A12 drive v2 - 2026-09-20 09:39:17 - enumeration order changed via CUDA_VISIBLE_DEVICES permutation ###
=== BOOT B1 both cards, default order | QWEN_DEVICE=cuda-uuid:73e7270e-ff5b-d1a2-de93-bc83af87699d | QWEN_CODEC_DEVICE=cuda-uuid:1831b67f-ccc0-c3fc-9167-cff059c3224c | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES= ===
  enumeration : 0=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c ;; 1=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : cuda:1 -> lands on NVIDIA GeForce RTX 5070 Ti [73e7270e-ff5b-d1a2-de93-bc83af87699d] | validate=ok | admission=cuda:1 | uuid_ok=True
  codec pin   : cuda:0 -> cuda:0 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU | validate=ok | weights loaded at import: 
=== BOOT B2 REVERSED enumeration (1,0) | QWEN_DEVICE=cuda-uuid:73e7270e-ff5b-d1a2-de93-bc83af87699d | QWEN_CODEC_DEVICE=cuda-uuid:1831b67f-ccc0-c3fc-9167-cff059c3224c | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES=1,0 ===
  enumeration : 0=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d ;; 1=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c
  qwen pin    : cuda:0 -> lands on NVIDIA GeForce RTX 5070 Ti [73e7270e-ff5b-d1a2-de93-bc83af87699d] | validate=ok | admission=cuda:0 | uuid_ok=True
  codec pin   : cuda:1 -> cuda:1 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU | validate=ok | weights loaded at import: 
=== BOOT B3 both cards, default order again | QWEN_DEVICE=cuda-uuid:73e7270e-ff5b-d1a2-de93-bc83af87699d | QWEN_CODEC_DEVICE=cuda-uuid:1831b67f-ccc0-c3fc-9167-cff059c3224c | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES= ===
  enumeration : 0=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c ;; 1=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : cuda:1 -> lands on NVIDIA GeForce RTX 5070 Ti [73e7270e-ff5b-d1a2-de93-bc83af87699d] | validate=ok | admission=cuda:1 | uuid_ok=True
  codec pin   : cuda:0 -> cuda:0 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU | validate=ok | weights loaded at import: 
--- counterfactual: 'cuda:1' frozen out of B1 and replayed under B2's enumeration (the pre-#1870 shape) ---
=== BOOT B4 stale index under reversed enumeration | QWEN_DEVICE=cuda:1 | QWEN_CODEC_DEVICE=cuda:1 | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES=1,0 ===
  enumeration : 0=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d ;; 1=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c
  qwen pin    : cuda:1 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU [1831b67f-ccc0-c3fc-9167-cff059c3224c] | validate=ok | admission=cuda:1 | uuid_ok=
  codec pin   : cuda:1 -> cuda:1 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU | validate=ok | weights loaded at import: 
  pinned card is idx=0 (NVIDIA GeForce RTX 5070 Ti); 'cuda:1' landed on idx=1 (NVIDIA GeForce RTX 4070 Laptop GPU) -> wrong card: True
  note: uuid_ok for the UUID form in this same order was: True
--- counterfactual: frozen index that has no slot at all on the new boot ---
=== BOOT B5 stale index, single visible card | QWEN_DEVICE=cuda:1 | QWEN_CODEC_DEVICE=cuda:1 | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES=1 ===
  enumeration : 0=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : cuda:1 -> lands on  [] | validate=ValueError: cuda:1 out of range; only 1 CUDA device(s) visible | admission=cuda:1 | uuid_ok=
  codec pin   : cuda:1 -> cuda:1 -> lands on  | validate=ValueError: cuda:1 out of range; only 1 CUDA device(s) visible | weights loaded at import: 
  (only the 5070 Ti visible; 'cuda:1' points past the end of the list)
--- control: uuid the box cannot see at all ---
=== BOOT B6 uuid_unresolved | QWEN_DEVICE=cuda-uuid:00000000-0000-0000-0000-000000000000 | QWEN_CODEC_DEVICE=cuda-uuid:00000000-0000-0000-0000-000000000000 | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES=1 ===
  enumeration : 0=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : auto -> lands on  [] | validate=ok | admission= | uuid_ok=False
  codec pin   : cpu ->  -> lands on  | validate=n/a (cpu) | weights loaded at import: 
--- control: nvidia-smi-style GPU- prefixed uuid (NOT what toUuidForm stores) ---
=== BOOT B7 GPU- prefixed form | QWEN_DEVICE=cuda-uuid:GPU-73e7270e-ff5b-d1a2-de93-bc83af87699d | QWEN_CODEC_DEVICE=cuda-uuid:GPU-73e7270e-ff5b-d1a2-de93-bc83af87699d | CUDA_DEVICE_ORDER= | CUDA_VISIBLE_DEVICES= ===
  enumeration : 0=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c ;; 1=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : auto -> lands on  [] | validate=ok | admission= | uuid_ok=False
  codec pin   : cpu ->  -> lands on  | validate=n/a (cpu) | weights loaded at import: 
--- CUDA_DEVICE_ORDER on this box: does it renumber at all? ---
=== BOOT B8 PCI_BUS_ID | QWEN_DEVICE=cuda-uuid:73e7270e-ff5b-d1a2-de93-bc83af87699d | QWEN_CODEC_DEVICE=cuda-uuid:1831b67f-ccc0-c3fc-9167-cff059c3224c | CUDA_DEVICE_ORDER=PCI_BUS_ID | CUDA_VISIBLE_DEVICES= ===
  enumeration : 0=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c ;; 1=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : cuda:1 -> lands on NVIDIA GeForce RTX 5070 Ti [73e7270e-ff5b-d1a2-de93-bc83af87699d] | validate=ok | admission=cuda:1 | uuid_ok=True
  codec pin   : cuda:0 -> cuda:0 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU | validate=ok | weights loaded at import: 
=== BOOT B9 FASTEST_FIRST | QWEN_DEVICE=cuda-uuid:73e7270e-ff5b-d1a2-de93-bc83af87699d | QWEN_CODEC_DEVICE=cuda-uuid:1831b67f-ccc0-c3fc-9167-cff059c3224c | CUDA_DEVICE_ORDER=FASTEST_FIRST | CUDA_VISIBLE_DEVICES= ===
  enumeration : 0=NVIDIA GeForce RTX 4070 Laptop GPU|1831b67f-ccc0-c3fc-9167-cff059c3224c ;; 1=NVIDIA GeForce RTX 5070 Ti|73e7270e-ff5b-d1a2-de93-bc83af87699d
  qwen pin    : cuda:1 -> lands on NVIDIA GeForce RTX 5070 Ti [73e7270e-ff5b-d1a2-de93-bc83af87699d] | validate=ok | admission=cuda:1 | uuid_ok=True
  codec pin   : cuda:0 -> cuda:0 -> lands on NVIDIA GeForce RTX 4070 Laptop GPU | validate=ok | weights loaded at import: 
### drive complete ###
A12-DRIVE-DONE
```
