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
   policy normally pins it to `cuda:1` — see the register's line ~1445). Under
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

1. With `COQUI_DEVICE` cleared (Setup step 5) and `QWEN_DEVICE=cuda:1` pinned,
   load Qwen resident on `cuda:1` and drive it into an active voice-design
   session (Base 0.6B + VoiceDesign 1.7B co-resident, ~5 GB combined per
   `docs/features/108-qwen-coexistence.md`) so `cuda:1`'s free VRAM drops
   below `cuda:0`'s ~8 GB free, while still leaving enough room for the Coqui
   derive (~3.5 GB per `docs/features/264-vram-aware-gpu-placement.md`, plus
   the reserve cushion). If Base+VoiceDesign alone doesn't push `cuda:1` low
   enough, also warm Kokoro on `cuda:1` (`PRELOAD_KOKORO=1`, or an on-demand
   synth) to add roughly another 1 GB.
2. Confirm via `nvidia-smi --query-gpu=index,memory.free --format=csv` that
   `cuda:0` free is now **greater than** `cuda:1` free, and that `cuda:1` free
   still clears the Coqui derive's footprint plus reserve. This is the band
   the whole criterion depends on — if you cannot reach it with the models
   above, note the measured free-MB on both cards in the Result line rather
   than forcing a pass; the exact fill level needs on-box tuning and hasn't
   been confirmed against real hardware.
3. Holding that state, trigger the lazy Coqui derive (Setup step 4) with the
   hint active (the shipped #3058 code path). Sample `nvidia-smi` across the
   derive.
4. Reset back to the same `cuda:1`-loaded VRAM state (unload and reload Coqui
   so nothing else changes), then repeat step 3 with the hint suppressed —
   temporarily comment out the `X-Device-Hint` header assignment in
   `derive-engine-artifact.ts:145-146` — and sample `nvidia-smi` again.

**Pass:** with the hint active, the derive lands on `cuda:1`; with the hint
suppressed under the *same* VRAM state, the derive lands on `cuda:0`
(unconstrained placement now prefers it, since it has more free room). **Both
halves must be observed** — a pass on only the hinted half is not a control
and does not discharge this criterion.

**Fail:** either run lands on the same card as the other, or the derive
fails/stalls in either state.

Result:

---

## Criterion 3 — an unsatisfiable hint still lands the derive

This is the criterion that separates the shipped advisory behaviour from the
hard pin that PR #3061's review rejected. Under a hard pin this scenario cost a
~60 s `withCapacityRetry` stall and then a **silently substituted stock
catalogue voice**.

1. Fill GPU1 so the derive cannot fit there — load a second resident model onto
   it, or arrange the boot so the eGPU carries the load.
2. Trigger the same lazy derive.

**Pass, all four:**

- the derive **succeeds on GPU0**, in its normal time;
- the log shows the preference not taken, **not** a `noCapacity` refusal
  naming `cuda:1`;
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
