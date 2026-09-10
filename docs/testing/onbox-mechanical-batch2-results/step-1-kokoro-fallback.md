# Step 1 — Kokoro CUDA-verification / CPU-fallback on-box confirmation

Run 2026-09-06, worktree `wt-mechanical-batch-2` (branch `docs/docs-mechanical-batch-2`),
two-GPU box: GPU0 = RTX 4070 Laptop (8 GB), GPU1 = RTX 5070 Ti (16 GB). Other
lanes' sidecar processes were live on this shared box throughout (confirmed via
`nvidia-smi` and `Get-CimInstance Win32_Process` before touching anything —
`wt-onbox-mechanical-batch1`, `wt-analyzer-render-batch`,
`wt-2934-a36-audition-band` each had their own resident python process; none
were stopped or touched). Only this worktree's own sidecar (port 9170) and
dev server (port 8250) were started/stopped.

**Context-change verification (done first, per the task brief):** loaded
Kokoro with `KOKORO_DEVICE` unset/`cuda` on this box and confirmed via
`/health` that it now genuinely lands on `cuda` — `cuda_verified: true`,
`devices.kokoro: "cuda"`. The "missing `nvidia-cudnn-cu12`" gap A33's own row
recorded as fixed 2026-08-31 is confirmed still fixed for the **live sidecar
app** on this box. (One inconsistency worth flagging: the `pytest`-driven
golden-audio suite's own venv invocation hit a real
`cudnn64_9.dll ... is missing` / `Failed to create CUDAExecutionProvider`
error during A20 bullet 2's corrupted-baseline run, forcing Kokoro onto CPU
for *that one pytest process* even though the live `uvicorn` sidecar in the
same venv landed on CUDA cleanly seconds later. Not chased further — noted
as a real, observed flakiness in this box's CUDA EP construction, not
something either A20 or A33/A102 depend on.) Given CUDA genuinely works, the
process-scoped `CUDA_VISIBLE_DEVICES=-1` mechanism (env var visible only to
the one sidecar subprocess launched for that test) was used to force a real
CUDA→CPU fallback for A102 bullet 2 — see below. (`CUDA_VISIBLE_DEVICES=""`,
tried first, was silently ignored by this box's driver/runtime and did NOT
hide the GPUs; `-1` worked.)

---

## A20 — Golden-audio bless guards / real-`_make_kokoro` engine (PR #2032)

### Bullet 1 — routine `--bless --sidecar-only`, no `GOLDEN_REBLESS_*`

`nvidia-smi` before the run showed both cards near-idle (0% util); other
lanes' processes were resident but not actively computing.

Two consecutive plain `npm run test:golden-audio -- --bless --sidecar-only`
runs (no `GOLDEN_REBLESS_*` set) **did not** complete cleanly — both refused
on `instruct-baseline.json`'s `tolerances` guard:

```
run 1: AssertionError: refusing to bless: tolerances would move beyond epsilon 0.0
  (rtf_max: 0.5000) -- was rtf_max 1.0, now rtf_max 1.5
  -- set GOLDEN_REBLESS_THRESHOLDS=1 to confirm this is intentional
run 2 (immediate retry, still idle): rtf_max 1.0 -> 1.35 (delta 0.35)
```

`kokoro-baseline.json`'s own bless (no `tolerances`/`rtf` field — it only
gates `transcript`/`text_edits`) completed silently both times, with one
real, useful signal: the raw Whisper transcript for `narrator-plain` came
back with a comma inserted ("The lighthouse keeper watch the grey sea roll
in." → "The lighthouse keeper, watch the grey sea roll in.") and was
**written through with no flag and no refusal** — `bless_guard`'s
`normalize_words` treats the two as equivalent content, so this is the guard
correctly not rubber-stamping a genuine content change while still not
demanding a flag for real ASR noise. This directly contradicts the row's
"transcript ... must stay BYTE-IDENTICAL on a routine re-bless" framing for
kokoro-baseline.json specifically — on real hardware, a punctuation-level ASR
noise diff **does** get written through silently (no flag, no echo — this
compare.py path has no echo mechanism, only `test_instruct_golden.py`'s does).
Worth feeding back into the row: "byte-identical" is not what real hardware
produces here; "semantically unchanged, written through" is.

To get past the instruct-baseline refusal and observe the accept-path echo
mechanism (bullet's other deliverable), re-ran with `GOLDEN_REBLESS_THRESHOLDS=1`
then `GOLDEN_REBLESS_MEASUREMENTS=1`:

```
refusing to bless: loudness_dbfs would move beyond epsilon 0.4
  (angry: 3.4800, sad: 1.7600, excited: 1.7400, neutral: 1.4000, whisper: 0.6400)
  -- was {whisper:-31.17, neutral:-21.16, excited:-20.96, angry:-17.3, sad:-25.81}
  -- now {whisper:-30.53, neutral:-19.76, excited:-19.22, angry:-13.82, sad:-27.57}
  -- set GOLDEN_REBLESS_MEASUREMENTS=1 to confirm this is intentional
```

With both flags set, the full bless succeeded (`OK sidecar (Suite A)`). Diff
of `instruct-baseline.json` (captured, then reverted — see below):

```
tolerances.rtf_max:        1.0    -> 1.35
identity.cosine.whisper:   0.0125 -> 0.0104   (delta -0.0021)
identity.cosine.sad:       0.0058 -> 0.0077   (delta +0.0019)
identity.cosine.excited:   0.0051 -> 0.0042   (delta -0.0009)
identity.cosine.angry:     0.0070 -> 0.0122   (delta +0.0052)
identity.max:              0.0125 -> 0.0126
loudness_dbfs (all 5 leaves moved 0.6-3.5 dB)
rtf.batched:                0.5089 -> 0.8952
```

**Deliverable — actual per-leaf identity cosine deltas observed:**
whisper −0.0021, sad +0.0019, excited −0.0009, **angry +0.0052**. The `angry`
leaf's single-run delta (0.0052) already **exceeds** `IDENTITY_COSINE_EPSILON`
(0.005) on its own, on genuine hardware noise with no engine/model change —
directly answering #2066's open question: **0.005 is too tight**, at least
for the `angry` leaf on this box. This isn't a one-off either: `rtf_max`
climbed on every successive run of this session (1.0 → 1.5 → 1.35 → 1.55 on
a fourth attempt after re-blessing), which reads as accumulating contention
or thermal/driver drift across repeated runs rather than pure run-to-run
noise — worth a wider sampling window before trusting any single-run epsilon
here.

No `[golden-bless] identity moved ...` / `[golden-bless] loudness_dbfs moved
...` echo lines were visible in the default pytest output for either the
forced-flag run or a bare run, because `run-golden-tests.ps1`'s pytest args
are `-q -rs` with no `-s` — **stdout is only shown by pytest on a FAILED
test**, so a passing bless (forced-flag run) never surfaces the echo unless
the caller adds `-s` explicitly (confirmed by re-running with a trailing
`-- -s`, which still hit the tolerances refusal before reaching the echo
point on that run). This is itself worth noting: an operator trusting bare
`npm run test:golden-audio -- --bless` output to see the echo line will
never see it on a clean pass without knowing to add `-s`.

After capturing the above, both `kokoro-baseline.json` and
`instruct-baseline.json` were reverted (`git checkout --`) — this task's
scope is the results doc only, not baseline-file changes.

### Bullet 2 — hand-edit `transcript` to `null`, confirm refusal + byte-identical revert

Nulled `kokoro-baseline.json`'s `narrator-plain.transcript`, re-ran
`--bless --sidecar-only --engine=kokoro`:

```
AssertionError: Bless refused for one or more lines (ops-45 G1/G2 -- see #1911 s2c):
  narrator-plain: refusing to bless: existing entry has no recorded 'transcript' key
  (was {...'transcript': None...}) -- set GOLDEN_REBLESS_CONTENT=1 to confirm this is intentional
```

`git diff` before/after the attempted bless showed the file untouched except
for my own hand-edit (the null) — the refusal fired **before** any write, as
`bless_guard`'s docstring promises. Hand-edit reverted via `git checkout --`.

### Bullet 3 — hand-edit `identity.cosine.angry` by +0.05, confirm `GOLDEN_REBLESS_MEASUREMENTS` (not `_THRESHOLDS`)

Edited `instruct-baseline.json`'s `identity.cosine.angry` from `0.007` to
`0.057` (+0.05). A bare re-bless hit the `tolerances`/`rtf_max` guard first
(this box's real rtf drift, see bullet 1) with `GOLDEN_REBLESS_THRESHOLDS`,
not yet reaching the identity check — so `GOLDEN_REBLESS_THRESHOLDS=1` was
set (only) to get past that unrelated gate and isolate the identity-window
refusal:

```
AssertionError: refusing to bless: identity would move beyond epsilon 0.005
  (cosine.angry: 0.0493, cosine.sad: 0.0016, cosine.excited: 0.0011, cosine.whisper: 0.0001, max: 0.0001)
  -- was {..., 'angry': 0.057}, now {..., 'angry': 0.0077}
  -- set GOLDEN_REBLESS_MEASUREMENTS=1 to confirm this is intentional
```

Confirmed: refuses with `GOLDEN_REBLESS_MEASUREMENTS`, **not**
`GOLDEN_REBLESS_THRESHOLDS` — exactly the flag-split boundary this bullet
asks for. `git diff` confirmed the file was untouched except the hand-edit
(byte-identical elsewhere); hand-edit reverted.

### Bullet 4 — normal pass, then corrupt the `.onnx` weight file mid-run, confirm FAIL not SKIP

Normal `npm run test:golden-audio -- --sidecar-only --engine=kokoro -- -m golden`:
passed (`OK sidecar (Suite A)`).

First attempt — renaming `kokoro-v1.0.onnx` away entirely — produced a
**SKIP** ("Kokoro weights not found ..."), not a FAIL: this is the *wrong*
repro shape (a missing file is a legitimate, different SKIP condition, not
the #1987 "corruption during warm-up" defect). Restored the file, then
instead **truncated it in place** (same path, same filename, first 1024
bytes only) so the prereq "does a file exist here" check still passes but
loading fails:

```
onnxruntime.capi.onnxruntime_pybind11_state.InvalidProtobuf: [ONNXRuntimeError] : 7 : INVALID_PROTOBUF :
  Load model from .../kokoro-v1.0.onnx failed:Protobuf parsing failed.
```

All three affected tests (`test_kokoro_golden_lengths_match_baseline`,
`test_kokoro_is_deterministic_in_length`,
`test_kokoro_golden_content_matches_baseline`) **FAILED**, not SKIPped —
confirms #1987 stays closed. Restored the original file immediately after
(moved the untouched original back into place, deleted the truncated copy);
verified byte-for-byte via SHA-256
(`7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5`, matching
`kokoro-baseline.json`'s own `metadata.model_sha256`) and size
(325,532,387 bytes, unchanged). A final clean re-run of the same test
confirmed pass again.

---

## A33 — Silent-CPU-fallback alarm: contended vs. idle admission (remaining scope: bullets 2/3)

Launched this worktree's own sidecar (port 9170) with `KOKORO_DEVICE=cuda:0`,
`QWEN_DEVICE=cuda:0`, `COQUI_DEVICE=cuda:0` (pinning everything to the 8 GB
card to reproduce the row's "single 8 GB card" scenario despite this box
actually having two GPUs).

**Bullet 3 (idle positive control) — confirmed.** With nothing else resident
on GPU0, `POST /load {"engine":"kokoro"}` then `/health`:

```json
"devices": {"kokoro": "cuda", ...},
"cuda_verified": true,
"gpus": [
  {"idx": 0, "resident": []},
  {"idx": 1, "resident": []},
  {"idx": -1, "name": "unindexed (cpu / ORT / CT2)",
   "resident": [{"engine": "kokoro", "actual_card": null}]}
]
```

Kokoro landed on a real CUDA execution provider (`devices.kokoro: "cuda"`,
`cuda_verified: true`) with **no** `stale_reason` — the idle case is quiet,
as expected. One correction to the row's own wording: it asks to confirm
"the resident entry now carries the real GPU index (not the -1 bucket)" —
on this codebase that never happens for Kokoro specifically, GPU or CPU:
`main.py`'s `_build_gpus_payload` comment is explicit that "ORT/CT2 engines
(Kokoro/Whisper) ... carry index=None → the -1 bucket" **unconditionally**,
because an ONNX Runtime session has no torch ordinal to report at all. I
confirmed this by inspecting the code (`_engine_actual_card`'s own
docstring: "index is the real torch ordinal for torch engines; None for
ORT/CT2"). So "real GPU index vs. -1 bucket" is not a signal Kokoro can ever
produce; the actually-checkable signal for "genuinely on GPU, not a
fallback" is `devices.kokoro`/`cuda_verified` plus the *absence* of
`stale_reason` in the (always-idx-`-1`) resident entry — which is what I
verified above.

**Bullet 2 (contended CPU admission) — attempted, not achieved this
session; documented as still owed, not invented around.** Real, repeated
attempts and the concrete blockers found:

1. `QWEN_DEVICE=cuda:0` was **not honoured** by either the 0.6B-Base or
   1.7B-Base `/load` paths on this box — `qwen_device_key` came back
   `"cuda:1"` both times, confirmed by `/capacity`'s own before/after
   free-memory delta on GPU1 (not GPU0), reproduced twice. Isolated the pin
   logic itself (`_engine_env_pin("qwen")`) in a standalone interpreter with
   the same env and got the correct `"cuda:0"` back — so the bug (if it is
   one) is in how the running server's admission path uses that pin for
   Qwen specifically, not in `_engine_env_pin` itself. `COQUI_DEVICE=cuda:0`
   **was** honoured correctly (confirmed via the matching `/capacity` GPU0
   delta), so this looks Qwen-specific. Not root-caused further — flagging
   as a real, reproducible anomaly worth its own investigation, separate
   from this row.
2. Because Qwen wouldn't land on GPU0, Coqui (pinned, working, ~2.5 GB
   resident) was the only in-process lever available to consume GPU0
   headroom, and it wasn't enough on its own to push free memory under
   Kokoro's admission threshold (~1.6 GB): GPU0 stayed at 4.5-4.8 GB free
   after Coqui, comfortably above what Kokoro needs.
3. A standalone `torch` process allocating VRAM directly on `cuda:0` (4.2 GB,
   then 5.5 GB, outside the sidecar) was tried as a substitute for "load a
   real model to consume headroom" — but the sidecar's own
   `torch.cuda.mem_get_info(0)` call (which `probe_capacity()` uses)
   **did not reflect the external process's allocation** even after
   `torch.cuda.synchronize()` confirmed the allocation had completed
   (`/capacity` kept reporting the pre-hog free figure, off by >6 GB from
   `nvidia-smi`'s system-wide view). This looks like a Windows/WDDM
   per-process VRAM-accounting quirk rather than a `probe_capacity()` bug
   (in-process allocations, e.g. Coqui's, *were* correctly reflected) — but
   it means external VRAM pressure cannot be used to test this box's
   admission ledger; only genuine in-process engine loads can.

Net effect: with a 16 GB second card and Qwen's pin not landing where asked,
this box could not be pushed into "GPU0 genuinely out of headroom while
Kokoro is pinned there" within this session using only the sanctioned
levers (real model loads on this worktree's own sidecar). **Bullet 2 remains
unverified — still owed**, same shape as this row's own prior "not testable
this round" notes, not a fabricated pass. The Qwen-pin anomaly and the
external-VRAM-invisibility finding are both concrete, reproducible facts
about this box worth carrying into whoever picks this back up.

The #2643 negative control (a box with no CUDA build/device at all) is
**not testable on this box**, per the task's context note — both cards now
genuinely construct CUDA sessions (confirmed above and in A102 bullet 3), so
there is no "CUDA absent" state to exercise here.

---

## A102 — CUDA self-test on real ORT session detects Kokoro CPU fallback (PR #2719)

### Bullet 1 — `cuda_verified` populated on first real load

`PRELOAD_KOKORO=1`, `KOKORO_DEVICE` unset (default). `/health` after
startup:

```json
"kokoro_loaded": true,
"devices": {"kokoro": "cuda", ...},
"cuda_verified": true,
"cuda_verification_detail": null
```

Populated (`true`) on the real `_ensure_loaded`/`from_session` warm-up path.

### Bullet 2 — forced CUDA→CPU fallback

Mechanism: process-scoped `CUDA_VISIBLE_DEVICES=-1` (set only in the launcher
script's environment before spawning this one sidecar subprocess — no other
process on the box was affected) plus `KOKORO_DEVICE=cuda` (so Kokoro still
*requests* CUDA and the self-test has something to compare against).
`CUDA_VISIBLE_DEVICES=""` (empty string) was tried first and was silently
ignored by this box's driver — Kokoro still landed on `cuda` — so `-1` was
used instead, which worked.

`/health`:

```json
"devices": {"kokoro": "cpu", "coqui": "cpu", "qwen": "cpu"},
"cuda_verified": false,
"cuda_verification_detail": "CUDAExecutionProvider was requested but did not land in the real session.",
"gpus": [{"idx": -1, "resident": [{"engine": "kokoro", "actual_card": null, "stale_reason": "cpu_fallback"}]}]
```

Log (sidecar stderr):

```
2026-09-06 15:14:57.964 [sidecar] Kokoro CUDA self-test: CUDAExecutionProvider was requested
but did not land in the real session. (Castwright#2709)
```

`/api/info` (via the main dev server on port 8250, proxying the sidecar):

```json
{"devices": {"kokoro": "cpu", ...}, "cudaVerified": false,
 "cudaVerificationDetail": "CUDAExecutionProvider was requested but did not land in the real session."}
```

All three confirmations match the bullet's ask exactly.

### Bullet 3 — working-CUDA load, no warning

Default box state (no `CUDA_VISIBLE_DEVICES` override, `KOKORO_DEVICE`
unset): `/health` showed `cuda_verified: true`,
`cuda_verification_detail: null`; grepping both the sidecar's stdout and
stderr logs for "CUDA self-test" / "CUDAExecutionProvider was requested"
found **no** warning line. `/api/info`:

```json
{"devices": {"kokoro": "cuda", ...}, "cudaVerified": true, "cudaVerificationDetail": null}
```

No device-panel check was done via the browser UI (the curl-based
`/api/info` check the task allows as a substitute was used instead).

---

## Cleanup / final state

- All baseline-file hand-edits (A20 bullets 1-3) reverted; `git status` /
  `git diff` on `server/tts-sidecar/tests/golden/*.json` clean before this
  doc was written.
- `kokoro-v1.0.onnx` restored byte-for-byte (SHA-256 and file size verified
  against the pre-test original) after the one deliberate corruption in A20
  bullet 4.
- No temporary edit to `_kokoro_session_device` was needed this session
  (A102/A33's CPU-fallback bullets were both reachable via the
  process-scoped `CUDA_VISIBLE_DEVICES=-1` env mechanism instead) — so there
  is nothing to revert in `main.py`; `git diff server/tts-sidecar/main.py`
  is clean.
- All sidecar/server processes started for this session (this worktree's
  own, port 9170 and 8250 only) were stopped by exact PID/command-line match
  before finishing; no other lane's process was touched.
- Scratch helper scripts (`_launch-*.ps1`, `_check-*.py`, `_hog-vram.py`)
  used to drive these tests were deleted after use and are not part of the
  commit.
