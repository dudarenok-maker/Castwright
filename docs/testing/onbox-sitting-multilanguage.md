# On-box sitting pack — multi-language render + ASR content-QA (D1, D2, A38, E4)

> **Sitting pack** for wave 2 of `#2435`, step 7 of the `#2453` chain. Covers
> register rows **D1, D2, A38, E4** — non-English ASR content-QA calibration,
> zh/ja placeholder voice design, sidecar auto-scaled RAM/VRAM recycle
> thresholds, and the engine-recommendation CPU caveat. Follows the shared
> format fixed by [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §5; the
> re-resolution rule of §6 was applied to every row (see
> [`## Excluded on re-resolution`](#excluded-on-re-resolution) — nothing was
> excluded).
>
> **Box/card target:** the operator's GPU box, **single 8 GB card**, pinned
> via `CUDA_VISIBLE_DEVICES=0`.
>
> **Running time total (recomputed 2026-08-20):** **165 minutes** — D1 ≈ 90,
> D2 ≈ 25, A38 ≈ 35, E4 ≈ 15. Sum = 165, matching the plan of record's stated
> total for this pack ([`onbox-sitting-plan.md`](onbox-sitting-plan.md) §2.1)
> and the audit's own per-row estimates exactly — all four rows re-resolved
> as still owed, so nothing changed the arithmetic.

## Preconditions

Stated once for the sitting; do not repeat per row.

- [ ] **Single 8 GB card.** `CUDA_VISIBLE_DEVICES=0`.
- [ ] **The fs-61 Coalfall demo books for es, ru, fr, de** — already
      voice-designed (PR #1568, merged 2026-07-13; confirmed present at
      `samples/the-coalfall-commission-es/` with `manuscript.epub` +
      `voices/`). D1 needs all four ready to render; queue es and ru first
      since those are the row's two named residual risks (gendered-number
      mismatch, Russian oblique-case declension).
- [ ] **The zh/ja Coalfall placeholder samples** — confirmed present at
      `samples/the-coalfall-commission-zh/` and `-ja/`, each holding only
      `README.md` + `manuscript.md` (no `.epub`, no `voices/`) — the
      voice-design pipeline has not been run against either. D2 needs the
      shipped Qwen VoiceDesign pipeline pointed at both.
- [ ] **A fresh `server/.env`** with `SIDECAR_RESTART_MB`,
      `SIDECAR_VRAM_RECYCLE_SOFT_MB`, and `SIDECAR_VRAM_RESTART_MB` all
      **absent** (confirmed still commented out in `server/.env.example` at
      `:659`, `:661`, `:663`) — copy `.env.example` verbatim rather than
      hand-editing an existing `.env` that may already carry explicit
      overrides from earlier sittings. A38's whole premise is the auto path
      only activates when these three are unset.
- [ ] **A way to force Qwen onto the CPU device** via the voice-engine
      device setting (Settings → Voice Engine, or the equivalent env
      override) for E4 — confirm the setting exists and is reachable before
      committing GPU time to D1/D2.
- [ ] **A second shell** free throughout the sitting to poll `GET /health`
      (for A38's `recycle_pending` flag) and tail the sidecar log (for the
      `[sidecar]` restart/recycle lines and D1/D2's render progress).
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

## Procedure

Ordered so the one env change (A38) happens before the sidecar is started for
the sitting, D1 — the long pole at ~90 min, largely unattended once running —
goes first and stays in the background as its own render doubles as A38's
RAM/VRAM driver, and the short, genuinely interactive rows (D2's pipeline
kick-off, E4's CPU-forced check) run in D1's shadow rather than after it.
**Where D1/D2's GPU render is in flight, do not also drive E4's CPU-forced
render on the same process** — E4 targets the CPU device explicitly and does
not contend for VRAM, but starting it only after D1 is safely queued avoids
two renders racing to write the same `render-integrity` state.

### A38 · Sidecar auto-scaled RAM/VRAM recycle thresholds now actually apply on a fresh install ([#2179](https://github.com/dudarenok-maker/Castwright/issues/2179), PR [#2210](https://github.com/dudarenok-maker/Castwright/pull/2210))

> **Criteria source:** `onbox-acceptance-register.md` A38 (`:2169-2209`).
> Re-resolved 2026-08-20: `gh issue view 2179` → closed 2026-08-07T01:52:50Z;
> `gh pr view 2210` → merged 2026-08-07T01:52:49Z, title "fix(server): ship
> .env.example as documentation, not assignments" — the fix landed.
> `server/.env.example` still ships all three vars commented out —
> `# SIDECAR_RESTART_MB=0` (`:659`), `# SIDECAR_VRAM_RECYCLE_SOFT_MB=0`
> (`:661`), `# SIDECAR_VRAM_RESTART_MB=0` (`:663`) — confirmed unchanged.
> No later issue, PR, or run sheet records a real fresh-install
> threshold-crossing run. STILL OWED. Setup runs first (below); the
> threshold-crossing checks are folded into D1/D2's render further down
> since a long multi-chapter batch is the row's own named RAM/VRAM driver.

1. **Fresh-install confirmation.** With the fresh `.env` from Preconditions,
   start the sidecar and confirm the startup log computes and logs the auto
   thresholds — 70% of total physical RAM, 90% of the resident card's total
   VRAM (soft), 98% (hard) — rather than treating the absent vars as
   disabled.
   - Result (RAM/VRAM ceilings logged at startup):
2. **RAM ceiling — piggybacks on D1 below.** Once D1's four-language batch is
   underway, watch host committed RAM climb toward the ~70% ceiling. If the
   render alone does not reach it, add a synthetic host-memory hog alongside
   it (the row's own named fallback) rather than waiting indefinitely.
   Confirm the sidecar self-exits with code 43 for the supervisor to
   respawn, not a silent stall or an uncontrolled crash.
   - Result (RAM ceiling reached, exit code observed):
3. **VRAM soft/hard thresholds — same render.** Watch reserved VRAM via
   `nvidia-smi` alongside D1/D2's queued renders. At the 90% soft threshold,
   confirm `GET /health` sets `recycle_pending` and a clean chapter-boundary
   recycle fires (not a mid-chapter hard exit). If the soft recycle doesn't
   relieve enough pressure, continue toward 98% and confirm the hard
   self-exit fires instead of an uncontrolled OOM.
   - Result (soft recycle at 90%, chapter-boundary not mid-chapter):
   - Result (hard restart at 98%, if reached):
4. **Thrash check.** Across D1/D2's ordinary batch peaks, confirm the auto
   thresholds do **not** fire routinely — a card sitting in the high-80s/90s%
   reserved as a normal batch peak should not trip a recycle storm now that
   the ceiling is live where it was previously inert.
   - Result:

### D1 · Non-English ASR content-QA calibration ([#1527](https://github.com/dudarenok-maker/Castwright/issues/1527), [#1084](https://github.com/dudarenok-maker/Castwright/issues/1084))

> **Criteria source:** `onbox-acceptance-register.md` D1 (`:2854-2867`).
> Re-resolved 2026-08-20: `gh issue view 1527` → still **OPEN**
> ("srv: on-box maxWer calibration for es/fr/de/ru (#1084 follow-up)"); `gh
> issue view 1084` → still **OPEN** ("srv: ASR content-QA never
> tuned/validated for non-English"). `server/src/config/registry.ts:300-330`
> defines `qa.asr.maxWer.{es,ru,fr,de}`, every one still `default: 0.4` —
> identical to the global default, confirmed unchanged.
> `server/src/tts/segment-asr-qa.test.ts:688-711`
> (`resolveAsrThresholds` per-language suite) exercises only the resolver
> against synthetic override values fed in by the test — it proves the
> plumbing reads a set knob, not that any knob has been set from a real
> render-and-inspect pass. STILL OWED. **Sequenced first — the long pole at
> ~90 min across four languages, largely unattended once running.**

5. **Kick off the batch.** Render one chapter of each fs-61 demo book — es,
   ru, then fr, de — through the shipped pipeline with the ASR content-QA
   gate enabled. Queue all four; this is the row's own "largely unattended"
   batch and the sitting's long pole — start it, then move to A38 step 1 and
   D2/E4 below while it runs.
   - Result (all four queued, start time):
6. **Per-language WER inspection.** Once each language's chapter completes,
   inspect the ASR content-QA gate's reported WER against the current
   English-tuned `0.4` default. Record the observed WER for es, ru, fr, de.
   - Result (WER: es / ru / fr / de):
7. **Set the four knobs.** From the observed distribution, set
   `qa.asr.maxWer.{es,ru,fr,de}` (`server/src/config/registry.ts:300-330`)
   away from the inherited `0.4` default to values that reflect real
   per-language ASR noise floors rather than the English-tuned figure.
   - Result (knob values set):
8. **Gendered-number mismatch rate.** Across the es/fr/ru renders, record how
   often a gendered number word ("one"/"two" and their es/fr/ru
   gender-agreement forms) is flagged as a false-positive WER mismatch by
   the content-QA gate.
   - Result:
9. **Russian oblique-case declension.** In the ru render, record whether
   oblique-case declensions (a word correctly inflected for case but
   differing from the nominative form Whisper may output) are being
   misflagged as content mismatches.
   - Result:
10. **German compound-number token check.** In the de render, confirm
    whether Whisper's output for compound numbers matches the pipeline's
    single-fused-token assumption, or whether it splits/differs in a way
    that produces a false content mismatch.
    - Result:

### D2 · fs-61 zh/ja placeholder voices ([#1600](https://github.com/dudarenok-maker/Castwright/issues/1600))

> **Criteria source:** `onbox-acceptance-register.md` D2 (`:2869-2873`).
> Re-resolved 2026-08-20: `gh issue view 1600` → still **OPEN** ("fs-61 —
> backfill designed voices + covers onto the zh/ja Coalfall placeholder
> samples"). Directly compared the sample trees:
> `samples/the-coalfall-commission-es/` (one of D1's done languages) holds
> both `manuscript.epub` and a `voices/` directory; `-zh/` and `-ja/` hold
> only `README.md` + `manuscript.md` — no `.epub`, no `voices/` — confirmed
> unchanged. STILL OWED. **Runs in D1's shadow** — its own render is short
> (two languages, unattended pipeline) and does not need to wait for D1 to
> finish; queue it once D1's four renders are underway.

11. **Kick off the pipeline.** Once D1's batch is queued (step 5), run the
    shipped Qwen VoiceDesign pipeline against the zh Coalfall placeholder
    sample, then the ja sample — the same pipeline already run for D1's five
    languages.
    - Result (zh voice-design run, artifacts produced):
    - Result (ja voice-design run, artifacts produced):
12. **Confirm parity with the done languages.** Compare the resulting zh/ja
    sample trees against `samples/the-coalfall-commission-es/`'s shape —
    each should now carry a `voices/` directory of designed voice artifacts,
    matching the done languages rather than the placeholder-only state
    confirmed in Preconditions.
    - Result:

### E4 · fe-51 engine-recommendation CPU caveat (plan [259](../features/259-fe51-engine-recommendation.md))

> **Criteria source:** `docs/features/259-fe51-engine-recommendation.md:183-191`.
> Re-resolved 2026-08-20: `server/src/tts/engine-recommendation.ts:34` still
> defines `CAVEAT_VRAM` at the cited line, and its use at `:67`
> (`caveat: fits ? null : CAVEAT_VRAM`) is unchanged. Plan 259 line 183 still
> reads "On-box acceptance item (real hardware, not mock mode) — owed."
> verbatim. STILL OWED. **Runs in D1/D2's shadow** — this is a CPU-only check
> and does not contend with D1/D2's GPU renders; start it once both are
> safely queued (step 5, step 11) rather than racing their kick-off.

13. **Force CPU and render.** Force Qwen onto the CPU via the voice-engine
    device setting (Preconditions) and render a short chapter or single
    line. Confirm it actually renders — slow, not crashing.
    - Result (renders on CPU, no crash; approximate time vs. GPU):
14. **Fallback decision, only if step 13 fails.** If forcing CPU does **not**
    render, the plan's own named fallback is to soften `CAVEAT_VRAM`
    (`server/src/tts/engine-recommendation.ts:34`) to drop the CPU-mode
    offer and keep only the "pick Kokoro below" nudge — flag this for the
    operator rather than editing it during the sitting.
    - Result (only if step 13 failed):

## Excluded on re-resolution

None excluded. All four rows were re-resolved against live repo/issue/PR
state and the cited files themselves on 2026-08-20 and remain owed:

- **D1** — `gh issue view 1527/1084` both still OPEN, matching the row's own
  account. `registry.ts:300-330`'s four `qa.asr.maxWer.*` knobs confirmed
  still `default: 0.4`; `segment-asr-qa.test.ts:688-711` confirmed
  resolver-only synthetic coverage. STILL OWED.
- **D2** — `gh issue view 1600` still OPEN. Sample-tree comparison confirmed
  zh/ja still pre-pipeline placeholders (no `.epub`, no `voices/`) against
  es's done state. STILL OWED.
- **A38** — `gh issue view 2179` closed, `gh pr view 2210` merged, both match
  the row's account of the fix landing. `.env.example`'s three vars
  confirmed still commented out at the cited lines. No later run sheet
  records a real threshold-crossing run. STILL OWED.
- **E4** — `engine-recommendation.ts:34,67` confirmed unchanged; plan 259
  line 183 confirmed still reads "owed" verbatim. STILL OWED.

None of the four rows is AMBIGUOUS (that is A2/A16/A22's queue, not this
pack's) — every cited plan/issue/PR agrees with its own row text.

## Teardown

- [ ] Evict Qwen (and Coqui/XTTS if either D2's pipeline or E4's CPU check
      loaded it) so the next sitting starts cold.
- [ ] Restore `server/.env` to whatever configuration the box normally runs
      (if the fresh-install `.env` from Preconditions differs from the
      operator's usual working config, note which is now active).
- [ ] Confirm the sidecar is in a normal, non-recycling state — no
      `recycle_pending` still set on `GET /health` — before ending the
      sitting; if A38's hard-restart path fired, confirm the respawned
      sidecar is healthy.
- [ ] Confirm the card returns to baseline (`nvidia-smi` ≈ idle) before
      ending the sitting.
- [ ] Record the four `qa.asr.maxWer.*` values actually set (D1 step 7) and
      the zh/ja artifact locations (D2 step 11) somewhere durable if this
      sitting's config changes are meant to persist past the sitting.
