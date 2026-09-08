# On-box acceptance — X-Device-Hint derive placement (#3058, PR #3061)

Register row: **A106** (Group A — the GPU box) in
[`onbox-acceptance-register.md`](onbox-acceptance-register.md).

**Hardware prerequisite:** the 2-card boot (8 GB RTX 4070 + 16 GB RTX 5070 Ti
over OcuLink). The eGPU is not hot-pluggable — do this in one sitting. On the
single-card boot the feature deliberately emits no hint at all, so nothing here
is reproducible there.

Also needed: real Qwen and Coqui/XTTS weights, a live sidecar, and a real book
with at least one character on a **designed** Coqui voice.

---

## What is being accepted, and the trap in the obvious version of it

The change makes the lazy Coqui derive — the designed-voice self-heal that runs
mid-chapter when a designed voice's `.pt` artifact is missing — ask the sidecar
to place *that one derive* on `cuda:1`, so it does not contend with a Qwen that
is already generating on `cuda:0`. The request carries `X-Device-Hint: cuda:1`;
the sidecar threads it into `reservation(preferred=...)`, which tries that card
first and falls back to ordinary unconstrained placement if it does not fit.

#3058's original acceptance text said *"issue a hinted derive request and
confirm via `nvidia-smi` that Coqui loads on GPU1."* **Do not run that.** A
hand-issued `curl` with the header set proves only that the sidecar honours a
header it is handed. It says nothing about whether the server ever sends one —
and PR #3061's review found the branch in exactly that state, with the hint
gated on a device list only the Advanced Settings screen ever populated. Every
criterion below is driven from the app.

---

## Setup

1. Boot with both cards attached. Confirm `nvidia-smi` lists two devices.
2. `npm start` from the repo root (frontend + server + sidecar).
3. Have the sidecar log in view. `logs/server.log` is written only by
   `npm start` — see the note in MEMORY/CLAUDE.md — so use that, or the
   sidecar's own stdout.
4. Pick a character in a real book that uses a **designed** Coqui voice, and
   **delete its `.pt` artifact** from the voice-library directory. That absence
   is what makes the lazy derive fire; without it nothing below happens.
5. Confirm `COQUI_DEVICE` is **unset** in `server/.env` (this box's standing
   policy normally pins it to `cuda:1` — see row **A1**'s environmental notes
   in [`onbox-acceptance-register.md`](onbox-acceptance-register.md)). Under
   that pin `_resolve_admission`'s `constraint` is set and the hint is skipped
   outright (`main.py:5184`), so every criterion below is a no-op until it's
   cleared. `QWEN_DEVICE` may stay pinned to `cuda:1` — that governs a
   different engine's residency and does not gate Coqui's admission.

---

## Criterion 1 — the header is emitted by a real generation-path derive (diagnostic — no log line exists for this)

**There is no success-path log line for `X-Device-Hint`.** `_parse_device_hint`
(`main.py:4119-4184`) and the admission path it feeds
(`_resolve_admission`/`reservation()`) never log the header or the preferred
device when the hint is honoured — the four `log.warning` calls in
`_parse_device_hint` fire only on rejection (oversized, unparsable, or an
unresolved uuid). This criterion is diagnostic only; **Criterion 2 below is
what actually proves the mechanism**, end to end, without needing this one.

To observe the header directly anyway, temporarily add one line in
`xtts_clone_voice` right after `device_hint = _parse_device_hint(...)`
(`main.py:11992`): `log.info("device_hint=%s", device_hint)`. Revert it after
the run — it is not part of the shipped code.

**Do not open Account → Advanced Settings at any point before the render.**
That screen is what used to be the only thing warming the GPU device list, and
this criterion exists to prove the derive now warms it itself.

1. Add the temporary log line above and restart the sidecar.
2. From a freshly started server, open the book and generate the chapter
   containing the character from Setup step 4.
3. Read the added log line for the `/xtts/clone-voice` call.

**Pass:** `device_hint=cuda:1`.

**Fail:** `device_hint=None`. **This is a failure even if the derive succeeds
and the chapter renders** — a successful un-hinted derive is precisely the
pre-#3058 behaviour, and the whole feature is then inert.

Result:

---

## Criterion 2 — the hint is what moves placement, not incidental headroom (the discriminating case)

**Do not just sample `nvidia-smi` with Qwen on GPU0 and GPU1 free — that does
not discriminate.** `try_hold`/`best_fit` already pick the roomiest card, and
on this box `cuda:1` (16 GB) is normally roomier than `cuda:0` (8 GB)
regardless of any hint. In that default state the derive lands on GPU1 whether
the hint is honoured or ignored, so it proves nothing about the mechanism.
This criterion instead constructs the narrow band where `cuda:1` still fits
the derive but is **not** the roomier card, so a hinted and an unhinted run
provably diverge.

**Don't fill VRAM by loading real models** — a Qwen/Kokoro-based fill was
tried and rejected: `_qwen_design_idle_watchdog` frees the ~4-5 GB
VoiceDesign share 120-150 s after the last design
(`server/tts-sidecar/main.py:9067`, `:9098`), or immediately at the next
`/synthesize` (`:8141-8142`), so the band this criterion depends on evaporates
mid-criterion. Fill with a scratch CUDA allocation instead — `probe_capacity`
reads driver-level `mem_get_info` (`main.py:4210-4218`, `4297-4326`), so a
`torch.empty(...)` tensor moves the same number the placement code reads, and
unlike a resident engine nothing ever evicts it.

1. With nothing loaded on either card and `COQUI_DEVICE` cleared (Setup step
   5), read `nvidia-smi --query-gpu=index,memory.free,memory.total
   --format=csv,noheader,nounits` for both devices. This run sheet assumes
   `total0` ≈ 8192 MiB (RTX 4070) and `total1` ≈ 16376 MiB (RTX 5070 Ti); if
   this box's cards report different totals, recompute the reserve figures
   below from `_device_reserve_mb`'s own formula — `min(round(0.05 *
   total_mb), 500)` (`main.py:4500-4506`) — before proceeding.
2. Compute `cuda:0`'s headroom the same way the ledger does
   (`ReservationLedger._headroom`, `main.py:4550-4557`, consumed by
   `try_hold`/`best_fit` at `main.py:4560-4583`/`4585-4599`): with nothing
   held yet, `headroom0 = free0 - min(round(0.05 * total0), 500)` — at
   `total0 = 8192` that's `headroom0 = free0 - 410`.
3. Query the sidecar's `GET /debug/memory` and read its `footprints.coqui`
   block (`{seed_mb, learned_mb, sample_count}` — `FootprintTable.snapshot`,
   `main.py:4480-4496`, served at `main.py:11056-11153`). The Coqui derive's
   admission footprint (`peak`) is `learned_mb` once `sample_count >= 5`,
   else the seed `SEED_FOOTPRINTS_MB["coqui"]` of **3584 MB**
   (`main.py:4355`, `FootprintTable.peak_mb`, `main.py:4463-4470`) — call
   this value `peak`. A fresh box with no prior Coqui admissions uses the
   3584 MB seed unmodified.
4. **The target band, in MB:** this criterion needs `headroom0 > peak + 400`
   to have room to construct a discriminating band at all — if it doesn't,
   record the measured `headroom0` and `peak` in the Result line rather than
   forcing a pass — the exact headroom this box has needs on-box confirmation
   either way. Otherwise the target is
   `target_headroom1 = peak + 200` (comfortably inside the band's floor;
   at the seed value that's **3784 MB**) — enough margin above `peak` to
   survive nvidia-smi's own read noise, and (given the check above) still
   short of `headroom0`. Since `total1`'s reserve is capped at 500 MB
   (`min(round(0.05 * 16376), 500) = 500`), the free-VRAM figure to hit is
   `target_free1 = target_headroom1 + 500` — **4284 MB** at the seed value.
5. **Fill `cuda:1` to that target with a scratch allocation**, and leave it
   running for the whole of steps 6-9. From a Python environment with the
   sidecar's own torch install (e.g. the venv at
   `server/tts-sidecar/.venv`):

   ```python
   import torch, time
   torch.cuda.set_device(1)
   TARGET_FREE_MB = 4284  # target_free1 from step 4 — recompute if peak differs
   free_b, _ = torch.cuda.mem_get_info(1)
   fill_mb = free_b // (1024 * 1024) - TARGET_FREE_MB
   buf = torch.empty(fill_mb * 1024 * 1024, dtype=torch.uint8, device="cuda:1")
   print(f"holding {fill_mb} MiB on cuda:1 -- Ctrl+C to release")
   while True:
       time.sleep(3600)
   ```

   Confirm via `nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits`
   that `cuda:1`'s free VRAM has dropped to `target_free1`, and that
   `headroom1` computed from it (`free1 - 500`) sits inside the band from
   step 4.
6. Holding that fill, trigger the lazy Coqui derive (Setup step 4) with the
   hint active (the shipped #3058 code path). Sample `nvidia-smi` across the
   derive.
7. **Without touching the scratch fill**, unload Coqui (Advanced Settings, or
   `POST /api/sidecar/unload`) — leave it non-resident, don't reload it.
   Reloading it here would re-admit it and pin `_resolve_admission`'s
   `constraint` to wherever it just landed, which skips the `preferred`/hint
   check entirely regardless of what the header says next (`main.py:5184`).
   Then re-delete the `.pt` artifact for the same character (Setup step 4) —
   step 6's derive already wrote a fresh one, and without deleting it again
   the next call finds `ptExists && !stale` and skips the derive outright
   (`clone-voice-resolver.ts:1025`), leaving nothing to observe.
8. Comment out **only** the header assignment at
   `derive-engine-artifact.ts:146` (`headers['X-Device-Hint'] =
   input.deviceHint;`) — not the `if (input.deviceHint) {` at `:145` or the
   `}` at `:147`, which must stay or the file won't parse. Trigger the same
   derive again (same manuscript action as step 6) and sample `nvidia-smi`.
9. Revert the comment from step 8, and kill the scratch-fill process from
   step 5.

**Pass:** with the hint active (step 6), the derive lands on `cuda:1`; with
the hint suppressed (step 8) under the *same* scratch-filled VRAM state, the
derive lands on `cuda:0` (unconstrained placement now prefers it, since it
has more headroom). **Both halves must be observed** — a pass on only the
hinted half is not a control and does not discharge this criterion.

**Fail:** either run lands on the same card as the other, or the derive
fails/stalls in either state.

Result:

---

## Criterion 3 — an unsatisfiable hint still lands the derive (partly diagnostic — no log line distinguishes the fallback)

This is the criterion that separates the shipped advisory behaviour from the
hard pin that PR #3061's review rejected. Under a hard pin this scenario cost a
~60 s `withCapacityRetry` stall and then a **silently substituted stock
catalogue voice**.

**There is no log line that says "the preference was offered and not
taken."** `_resolve_admission` (`main.py:5126-5253`) is the same function
Criterion 1 already audited: the `preferred` try_hold at `main.py:5184-5187`
and its unconstrained fallback at `main.py:5188-5189` are both silent — no
`log.` call anywhere in that path records whether the preferred device was
tried, or whether it was tried and rejected before falling through. A
`noCapacity` refusal naming `cuda:1` isn't a log line either; it would surface
as an HTTP 503 response body (`_no_capacity(adm)`,
`{"noCapacity": {"deviceKey": "cuda:1", ...}}`) that Node's retry/substitution
path consumes internally, not something written anywhere an operator can read
after the fact.

What genuinely is observable without instrumentation: bullets 1, 3, and 4
below, taken together, already rule out the hard-pin failure mode this
criterion exists to catch — a hard pin fails as a 60 s stall *plus* a silent
substitution, not as a clean GPU0 success in normal time. A clean pass on
those three is the real discriminator; the second bullet below is the
diagnostic-only confirmation of *why*, not an independent proof.

To observe the fallback directly anyway, add two temporary log lines in
`_resolve_admission` and revert them after the run — they are not part of the
shipped code:

- right after the `preferred` try at `main.py:5187`:
  `log.info("preferred=%s held=%s", preferred, held)`
- right after the fallback try at `main.py:5189`:
  `log.info("fallback held=%s", held)`

1. Fill `cuda:1` so the derive cannot fit there — using the same scratch-CUDA
   approach as Criterion 2 step 5 (not a second resident model: same
   rationale as Criterion 2's note above on why a model-based fill doesn't
   hold still), but targeting the opposite end of the band: `target_headroom1
   = peak - 200` (at the 3584 MB seed value, **3384 MB** — comfortably below
   what the derive needs, so the `preferred` try_hold provably fails rather
   than merely being tight), so `target_free1 = target_headroom1 + 500`
   (**3884 MB** at the seed value). Confirm via `nvidia-smi
   --query-gpu=index,memory.free --format=csv,noheader,nounits` that
   `cuda:1`'s free VRAM sits at or below that figure before proceeding.
2. Trigger the same lazy derive. Leave the scratch fill running across it,
   and kill it once this criterion's Result line is filled in.

**Pass, all four:**

- the derive **succeeds on GPU0**, in its normal time;
- (diagnostic only, with the temporary log lines above) the first log line
  shows `held=None` for `preferred="cuda:1"`, and the second shows a non-`None`
  fallback `held` on `cuda:0` — i.e. the preference was tried, rejected, and
  fallen through, rather than a `noCapacity` refusal ever reaching Node;
- there is **no ~60 s stall** before it proceeds;
- the character renders in **its own designed voice**.

The last one is the user-visible half and it is silent in the UI — a
substitution still produces a green render. Listen to the chapter, or inspect
the rendered cast assignment, rather than trusting the render's own status.

Result:

---

## Criterion 4 — the operator's `COQUI_DEVICE` pin still wins

1. Set `tts.coqui.device` to `cuda:0` (Advanced Settings, or
   `COQUI_DEVICE=cuda:0` in `server/.env`). Restart.
2. Render the same chapter.

**Pass:** the derive lands on **GPU0** despite the hint naming `cuda:1`.

A per-request preference must not overrule a `risk: 'high'` registry knob the
operator set on purpose.

Result:

---

## Criterion 5 — a stale device list stays harmless

The device-list cache is never invalidated when the sidecar respawns, so it can
outlive the cards it describes. That is accepted; this criterion pins that it
costs nothing.

1. Warm the list on the 2-card boot (open Advanced Settings once).
2. Restart **only the sidecar**, with `CUDA_VISIBLE_DEVICES=0` so one card is
   visible. Leave the Node server running.
3. Render again.

The cached list still reports an idx-1 card, so the hint is still emitted and
names a device that no longer exists.

**Pass:** the derive still succeeds on the remaining card, with no stall and no
voice substitution.

Result:

---

## Recording the outcome

Fill each `Result:` line above with what was observed, by whom, and when — an
outcome, not a tick. Then update row **A106** in the register (and the live
view) per CLAUDE.md before-shipping step 3. "Tests pass, so it's presumably
fine" never discharges a row.
