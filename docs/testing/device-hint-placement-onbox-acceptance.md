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
   cleared. **`QWEN_DEVICE` must NOT stay pinned to `cuda:1` for Criteria 2
   and 3.** It is true that the knob does not gate Coqui's *admission check*
   directly — but each of those criteria triggers a full chapter render
   alongside the derive it measures, and Qwen actually generates somewhere
   during that render. Under the standing `cuda:1` pin, Qwen's own render
   would compete for the exact card the constructed VRAM band lives on.
   In **Criterion 2** (two measured derives around one render) that can evict
   the Coqui the first derive just placed on `cuda:1` before the second,
   control derive runs (confounding the control half — see Criterion 2 step
   6). In **Criterion 3** — a single measured derive, but `cuda:1` is filled
   *tighter* there (`target_free1` is lower) — Qwen's own admission onto an
   already-tight `cuda:1` is the likelier failure: a `noCapacity` stall on
   the render itself, before the criterion's own derive is even reached. For
   the duration of Criteria 2 and 3 only, set `QWEN_DEVICE=cuda:0` in
   `server/.env` (restart) so Qwen's render lands on the *other* card and
   never touches the band — restore the box's standing `cuda:1` pin once
   both criteria are done. This does add one precondition of its own:
   `cuda:0`'s pristine (nothing-loaded) headroom from step 1 below must
   itself be large enough for whichever Qwen model the render's book
   actually chooses (`SEED_FOOTPRINTS_MB`: 0.6B seed 3072 MB at
   `main.py:4340`, 1.7B seed 6144 MB at `main.py:4341`) — routine on an
   empty 8 GB card, but pick a 0.6B-only book if this render also has to
   compete with the `headroom0 > peak + 400` check at step 4.

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

1. With nothing loaded on either card, `COQUI_DEVICE` cleared, and
   `QWEN_DEVICE=cuda:0` set (Setup step 5 — the render this criterion
   triggers places a real Qwen load, and its device is an input to the band
   this criterion constructs, not a side detail), read `nvidia-smi
   --query-gpu=index,memory.free,memory.total --format=csv,noheader,nounits`
   for both devices. This run sheet assumes `total0` ≈ 8192 MiB (RTX 4070)
   and `total1` ≈ 16376 MiB (RTX 5070 Ti); if this box's cards report
   different totals, recompute the reserve figures below from
   `_device_reserve_mb`'s own formula — `min(round(0.05 * total_mb),
   GPU_RESERVE_MB)` (`main.py:4500-4506`) — before proceeding. Also read the
   box's actual `GPU_RESERVE_MB` (`server/.env`, or the default 500 if
   unset) rather than assuming 500 — see the reserve-formula note at step 4.
2. Compute `cuda:0`'s headroom the same way the ledger does
   (`ReservationLedger._headroom`, `main.py:4550-4558`, consumed by
   `try_hold`/`best_fit` at `main.py:4560-4583`/`4585-4600`): with nothing
   held yet, `headroom0 = free0 - min(round(0.05 * total0), GPU_RESERVE_MB)`
   — at `total0 = 8192` and the default `GPU_RESERVE_MB = 500` that's
   `headroom0 = free0 - 410`; recompute the subtracted figure from your
   box's actual `GPU_RESERVE_MB` (`server/.env`, or the config-registry
   default of 500 if unset — `gpu.reserveMb`,
   `server/src/config/registry.ts:829-838`) if it differs.
3. Query the sidecar's `GET /debug/memory` and read its `footprints.coqui`
   block (`{seed_mb, learned_mb, sample_count}` — `FootprintTable.snapshot`,
   `main.py:4480-4497`, served at `main.py:11056-11153`). The Coqui derive's
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
   short of `headroom0`. **The reserve subtracted per device is
   `reserve(total_mb) = min(round(0.05 * total_mb), GPU_RESERVE_MB)` —
   `GPU_RESERVE_MB` is the operator-configurable ceiling (`gpu.reserveMb`,
   `server/src/config/registry.ts:829-838`; env `GPU_RESERVE_MB`, default
   500), not a hardcoded 500.** Read your box's actual value from
   `server/.env` before computing `target_free1` below — this box's own
   register row (**A1**) already runs non-default GPU env policy, so do not
   assume the default. `target_free1 = target_headroom1 + reserve(total1)`
   — at `total1 = 16376`, `round(0.05 * 16376) = 819`, so
   `reserve(16376) = min(819, GPU_RESERVE_MB)`, which is `min(819, 500) =
   500` at the default, giving `target_free1 = 3784 + 500 = 4284` at the
   seed `peak`. **Use `reserve(total1)` — the full formula, not the raw
   `GPU_RESERVE_MB` — on both sides of this criterion**: computing
   `target_free1` here, and reading `headroom1` back from the fill in step 5
   and again at the re-verify points below. Applied consistently this is
   self-correcting for any actual `GPU_RESERVE_MB` (it cancels out of both
   sides of the same formula). It stops being self-correcting the moment
   either side substitutes a bare number instead — hardcoding `500` while
   the box actually runs a different `GPU_RESERVE_MB` silently moves
   `target_free1` relative to the `headroom1` a real run measures, and the
   hinted half of step 6 can then land on the wrong card against
   otherwise-correct code.
5. **Fill `cuda:1` to that target with a scratch allocation**, and leave it
   running for the whole of steps 6-9. From a Python environment with the
   sidecar's own torch install (e.g. the venv at
   `server/tts-sidecar/.venv`):

   ```python
   import torch, time
   torch.cuda.set_device(1)
   TARGET_FREE_MB = 4284  # target_free1 from step 4 -- recompute if peak or GPU_RESERVE_MB differs
   total_b, free_b = torch.cuda.mem_get_info(1)
   assert total_b // (1024 * 1024) in range(16350, 16400), (
       f"cuda:1 reports total={total_b // (1024*1024)} MiB -- confirm this is "
       "actually the 16 GB card and CUDA's device ordering matches nvidia-smi's "
       "before trusting anything below (a real trap on this box)."
   )
   fill_mb = free_b // (1024 * 1024) - TARGET_FREE_MB
   assert fill_mb > 0, (
       f"cuda:1 already has less than {TARGET_FREE_MB} MiB free "
       f"({free_b // (1024*1024)} MiB) -- nothing to fill; re-check for a "
       "resident model or a leftover scratch allocation before proceeding."
   )
   buf = torch.empty(fill_mb * 1024 * 1024, dtype=torch.uint8, device="cuda:1")
   print(f"holding {fill_mb} MiB on cuda:1 -- Ctrl+C to release")
   while True:
       time.sleep(3600)
   ```

   Confirm via `nvidia-smi --query-gpu=index,memory.free --format=csv,noheader,nounits`
   that `cuda:1`'s free VRAM has dropped to `target_free1`, and that
   `headroom1` computed from it (`free1 - reserve(total1)`, at the default
   `free1 - 500`) sits inside the band from step 4.
6. **Re-verify immediately before triggering the derive** — re-read
   `nvidia-smi` for BOTH cards. `cuda:1` should still read `target_free1`
   (confirm the scratch-fill process from step 5 is still alive) and
   `cuda:0` should still be fully free (nothing has loaded there yet). Then
   trigger the lazy Coqui derive (Setup step 4) with the hint active (the
   shipped #3058 code path) — this is also the chapter render that loads
   Qwen, which lands on `cuda:0` per the `QWEN_DEVICE=cuda:0` override in
   Setup step 5. Sample `nvidia-smi` across the derive.

   **The band measured in steps 1-4 is now stale on `cuda:0`.** This render
   leaves Qwen resident on `cuda:0` for the rest of this criterion — nothing
   unloads it before step 8. Before continuing, re-read `nvidia-smi
   --query-gpu=index,memory.free --format=csv,noheader,nounits` for `cuda:0`
   and recompute `headroom0 = free0 - min(round(0.05 * total0),
   GPU_RESERVE_MB)` with Qwen's footprint now subtracted — this is the
   headroom step 8's control half actually contends with, not the
   nothing-loaded `headroom0` from step 2. If it has fallen to at or below
   `target_headroom1`, record the measured figures in the Result line rather
   than forcing step 8's expected outcome: pick a book/character whose
   render stays on the Qwen 0.6B model (~1952 MB, `main.py:4335`) rather
   than the 1.7B (~3915 MB, `main.py:4344`) if this keeps tripping, since the
   1.7B alone can exceed the margin this band was built with. Also re-confirm
   `cuda:1`'s free VRAM still reads `target_free1` before continuing to step
   7.
7. **Without touching the scratch fill**, unload Coqui (Advanced Settings, or
   `POST /api/sidecar/unload`) — leave it non-resident, don't reload it.
   Reloading it here would re-admit it and pin `_resolve_admission`'s
   `constraint` to wherever it just landed, which skips the `preferred`/hint
   check entirely regardless of what the header says next (`main.py:5184`).
   Then re-delete the `.pt` artifact for the same character (Setup step 4) —
   step 6's derive already wrote a fresh one, and without deleting it again
   the next call finds `ptExists && !stale` and skips the derive outright
   (`clone-voice-resolver.ts:1025`), leaving nothing to observe.
8. **Re-verify one more time immediately before this step** — re-read
   `nvidia-smi` for both cards and confirm both readings still match what
   step 6's check recorded (`cuda:1` at `target_free1`, `cuda:0`'s
   Qwen-adjusted `headroom0` still above `target_headroom1`). This is the
   last point at which the band can have silently moved. Comment out
   **only** the header assignment at `derive-engine-artifact.ts:146`
   (`headers['X-Device-Hint'] = input.deviceHint;`) — not the
   `if (input.deviceHint) {` at `:145` or the `}` at `:147`, which must stay
   or the file won't parse. Trigger the same derive again (same manuscript
   action as step 6) and sample `nvidia-smi`.
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
   hold still; the same `total_b`/`fill_mb` guards apply), but targeting the
   opposite end of the band: `target_headroom1 = peak - 200` (at the 3584 MB
   seed value, **3384 MB** — comfortably below what the derive needs, so the
   `preferred` try_hold provably fails rather than merely being tight), so
   `target_free1 = target_headroom1 + reserve(total1)` (per Criterion 2 step
   4's formula — **3884 MB** at the seed value and the default
   `GPU_RESERVE_MB = 500`; recompute `reserve(total1)` from your box's
   actual `GPU_RESERVE_MB` if it isn't 500. Use `reserve(total1)`
   consistently here and when reading `headroom1` back in step 2 below —
   substituting a hardcoded 500 for one side while the box actually runs a
   different `GPU_RESERVE_MB` reopens exactly Criterion 2's gap: at a cap
   **<= 300**, that substitution would raise the derive's actual `headroom1`
   back up to `peak` or above, letting it fit after all and defeating this
   criterion's own premise).
   Confirm via `nvidia-smi --query-gpu=index,memory.free
   --format=csv,noheader,nounits` that `cuda:1`'s free VRAM sits at or below
   that figure before proceeding.
2. **Re-verify immediately before triggering** — re-read `nvidia-smi` for
   `cuda:1` and confirm it still sits at or below `target_free1` (confirm the
   step-1 scratch-fill process is still alive). Trigger the same lazy
   derive — this is also the chapter render that loads Qwen, which lands on
   `cuda:0` per the `QWEN_DEVICE=cuda:0` override in Setup step 5, so it
   never contends with the `cuda:1` band this criterion depends on. Leave
   the scratch fill running across it, and kill it once this criterion's
   Result line is filled in.

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
