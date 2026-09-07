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

---

## Criterion 1 — the header is emitted by a real generation-path derive

**Do not open Account → Advanced Settings at any point before the render.**
That screen is what used to be the only thing warming the GPU device list, and
this criterion exists to prove the derive now warms it itself.

1. From a freshly started server, open the book and generate the chapter
   containing the character from Setup step 4.
2. When the lazy derive fires, read the `/xtts/clone-voice` request in the
   sidecar log.

**Pass:** the request carried `X-Device-Hint: cuda:1`, and the placement log
line names the hinted device.

**Fail:** no hint on the request. **This is a failure even if the derive
succeeds and the chapter renders** — a successful un-hinted derive is precisely
the pre-#3058 behaviour, and the whole feature is then inert.

Result:

---

## Criterion 2 — Coqui lands on GPU1, Qwen stays on GPU0

Run with Qwen resident and actively generating on GPU0, GPU1 free.

Sample `nvidia-smi` (e.g. `nvidia-smi --query-gpu=index,memory.used
--format=csv -l 1`) across the derive.

**Pass:** the XTTS weights appear on GPU1; GPU0's Qwen footprint is unchanged;
the render does not stall.

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
