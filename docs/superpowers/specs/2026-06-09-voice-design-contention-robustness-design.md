---
status: draft
date: 2026-06-09
branch: fix/voice-design-contention-robustness
---

# Voice-design robustness under GPU contention

## Problem

A user designing a narrator voice while a chapter generation was running (both
from the UI and from a separate code-driven generation) saw the design "freeze
on the last part of the progress bar," then the design pill flip to **"Halted."**
Investigation showed the design actually **succeeded** — but the experience was
broken end-to-end, and a heavy VoiceDesign model was effectively loaded on top of
a concurrent generation, oversubscribing the 8 GB GPU until the VRAM-crash
protection recycled the sidecar.

This is one fragility story with three layers, confirmed from logs
(`logs/tts.err.log`, `logs/tts.log`) on 2026-06-09:

1. **Root cause (C) — resident-VRAM oversubscription, NOT token concurrency.**
   A model stays resident in VRAM after it releases its GPU-semaphore token, so
   the semaphore (which arbitrates *active* ops, `server/src/gpu/semaphore.ts`)
   never reflects how many models are *sitting* in VRAM at once. Measured
   footprints on the 8 GB box:
   - Qwen Base + active generation ≈ **3.5 GB**
   - \+ VoiceDesign (the heavy 1.7 B design model) ≈ **6 GB** → **fits, no spill**
     (design co-residing with Qwen generation is fine and worth keeping).
   - \+ **Kokoro resident *while generation is active*** (a mixed-cast generation
     voices some characters on Kokoro) → **over 8 GB → spill** (RTF observed
     **3.22**, `gen_ms=222611`) → the VRAM-crash protection recycled the sidecar
     (fresh boot at 19:23:58). The spill is the **three-way** combination —
     active-generation working set **+** VoiceDesign **+** Kokoro. VoiceDesign +
     Kokoro with **no** active generation fits, so Kokoro may stay resident when
     nothing is generating.

   Kokoro runs on **onnxruntime-gpu**, a separate allocator from torch, so its
   ~1 GB is invisible to the torch `vram_reserved` metric but real on
   `nvidia-smi` — which is why the over-subscription was easy to miss. The
   sidecar's plan-161/PR-490 defense-in-depth (the `_synth_lock` on
   `unload`/`unload_design` + `_design_in_flight` re-ensure) is **intact** and
   still prevents two VoiceDesign copies *within one design*; the emotion-variant
   feature (fs-25/fs-34) did not break it. The gap it surfaced is different:
   **nothing prevents VoiceDesign and Kokoro from being co-resident.**

2. **Server symptom (B):** `DESIGN_TIMEOUT_MS = 180_000`
   (`server/src/routes/qwen-voice.ts:70`) is a blind wall-clock abort. Under the
   spill the design ran 222 s; at 180 s the `AbortController` fired and threw
   *"did not complete within 180000ms,"* which the design slice surfaces as a
   scary **"Halted"** — even though the sidecar answered `/health` 200 OK the
   whole time and finished the design 42 s later.

3. **Frontend symptom (A):** `src/components/design-progress.tsx` eases the fill
   to ~92 % over ~15 s and **holds**, with a hard-coded "about 15s" label. A
   multi-minute design therefore sits frozen at 92 % saying "about 15s" — exactly
   the "stuck on the last part of the progress bar" report.

## Scope

In scope: the three fixes below. **Out of scope** (explicit user decision): the
underlying variable-shape memory leak that inflates committed RAM to ~30 GB —
that is a separate, harder problem guarded today by the restart ceiling. This
spec fixes the *contention/over-subscription* fragility and the *honesty* of the
indicator, not the leak.

## Design

### C — VoiceDesign and Kokoro must not co-reside (root fix, sidecar-side)

This is a **resident-VRAM** rule, not a semaphore-cost change — the Node
semaphore can't see residency, so the fix lives in the sidecar where the engines
and VRAM are. Rule: **a VoiceDesign design forward and a Kokoro synth are mutually
exclusive.** Because Kokoro synths only occur *during generation*, this exclusion
is self-limiting — it bites exactly in the dangerous three-way case (design +
active generation + Kokoro) and is a no-op when nothing is generating (so Kokoro
may stay resident then). A design continues to co-reside happily with Qwen Base
generation (~6 GB, fits).

- Add a module-level cross-engine exclusion primitive in
  `server/tts-sidecar/main.py` (a `threading.Lock`, e.g. `_vd_kokoro_excl`)
  shared between the two engines. Mirrors the existing Coqui/XTTS-load ↔ analyzer
  auto-evict precedent.
- `KokoroEngine.synthesize` acquires `_vd_kokoro_excl` around its
  `self._kokoro.create(...)` forward. Uncontended (the common case) this is
  near-free; while a design holds it, Kokoro synths **wait** until the design
  finishes (they belong to a concurrent generation — its Qwen sentences keep
  flowing; only its Kokoro sentences pause briefly).
- `design_voice` (`QwenEngine`), on entering the exclusive VoiceDesign forward,
  acquires `_vd_kokoro_excl` and, **if Kokoro is currently resident**
  (`kokoro._kokoro is not None`), calls `kokoro.unload()` to reclaim its ~1 GB so
  the 1.7 B VoiceDesign load has headroom. Kokoro reloads on the next Kokoro
  synth (~1 s cold). When no generation ran, Kokoro typically isn't resident
  (`PRELOAD_KOKORO=0`), so this is a no-op — honouring "Kokoro can stay if there
  is no generation."
- Hold the exclusion only around the VoiceDesign *reference-clip* forward (the
  heavy step). The Base audition + Qwen generation are unaffected.

*Why mutual-exclude over evict-only:* a bare evict would let a concurrent Kokoro
synth reload Kokoro mid-design and re-spill. Serialising the two heaviest-combined
ops removes the evict/reload thrash window.

*Interaction with A/B:* under this fix a design no longer spills, so it runs at
normal RTF and finishes in seconds — B's 180 s timeout stops being pressured and
A rarely reaches its "slow" state. A/B remain the honest-degradation safety net
for any residual slow case (e.g. a long Kokoro sentence the design waits behind).

### B — Liveness-aware design timeout (no false "Halted")

Replace the blind 180 s abort with a `condition-based-waiting` check that only
gives up when the sidecar is genuinely unresponsive:

- On the design deadline, probe the sidecar `/health` (reuse the probe the
  generation supervisor already uses).
  - **alive →** re-arm for another window and keep waiting, bounded by an absolute
    ceiling (`DESIGN_ABSOLUTE_MAX_MS`, default 10 min) so a truly hung call still
    fails eventually. Log a single "design slow, sidecar alive — extending" warn.
  - **unreachable →** abort with the existing user-facing error.
- The design slice's `halt` should only be reached on a real unreachable/abort,
  never on a slow-but-alive design.

### A — Honest progress indicator

Rework `src/components/design-progress.tsx` (and its pill subtitle) so it can
never look frozen or lie about ETA:

- **Elapsed clock that always ticks** ("Designing… 1:23") — proof of life even
  when the bar is near-full. Driven off the snapshot `lastTickAt` / a start time.
- **Determinate-then-indeterminate fill:** keep the eased determinate fill for the
  expected fast window (~15–20 s), then flip to a continuous **indeterminate
  shimmer** so it reads "still working, no ETA" instead of "stuck at 92 %."
- **Honest copy:** under ~20 s show "about 15s"; past that, swap to **"Taking
  longer than usual — the GPU may be busy with another job."** When the design is
  queued behind generation, the pill prefix already shows "Queued (N ahead)"
  (existing `gpu-queue` plumbing); reuse it.
- Same honesty on the pill: "Designing X · GPU busy", and never "Halted" while the
  sidecar is alive.

## Testing

- **C (sidecar, pytest):** a design forward and a Kokoro synth **never overlap**
  (instrument the lock or assert one blocks while the other holds); a design with
  Kokoro resident **evicts** it before the VoiceDesign load (`kokoro._kokoro is
  None` during the design) and Kokoro reloads on the next synth; a design with no
  Kokoro resident is a **no-op** (no spurious unload); Qwen Base generation is
  **not** blocked by an in-flight design. New cases under
  `server/tts-sidecar/tests/` (e.g. `test_design_kokoro_exclusion.py`).
- **B (server):** test that a slow-but-`/health`-alive design **extends** instead
  of aborting, that an unreachable sidecar aborts with the existing message, and
  that the absolute ceiling still bounds a hung-but-pingable call.
- **A (frontend):** Vitest/RTL tests that the elapsed clock advances, that past
  the slow threshold the copy switches to the "GPU busy" message and the fill
  flips to indeterminate, and that an alive design never renders "Halted." One
  Playwright spec exercising the design pill through a simulated slow design
  (UI-visible behaviour crossing redux/layout seams).

## Risks / notes

- The exclusion serialises **only** Kokoro synths against an in-flight design —
  Qwen Base generation is untouched, so a Qwen-voiced chapter generates at full
  speed alongside a design. Only a mixed-cast generation's *Kokoro* sentences
  pause for the few seconds a design holds the lock.
- Evicting Kokoro forces a ~1 s cold reload on the next Kokoro synth. Acceptable
  and rare (only when a design coincides with a mixed-cast generation). It is NOT
  evicted when idle/no-generation, per the resident-VRAM analysis above.
- Kokoro runs on onnxruntime-gpu; its VRAM won't show in torch `vram_reserved`.
  The exclusion is the guard — do not rely on the torch metric to detect the
  three-way spill.
- This fix is sidecar-only; the Node GPU semaphore and per-engine costs are left
  unchanged (they correctly arbitrate *active* ops; residency is a separate axis
  handled here).
