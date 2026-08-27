# On-box sitting pack — two-card boot (A2, A3, A12)

> **Sitting pack** for wave 2 of `#2435`, step 2 of the `#2453` chain. Covers
> register rows **A2, A3, A12** — everything that needs the **2-card boot**.
> This pack also carried old A8 (GPU residency safety + coexistence, plan
> 222), **discharged 2026-08-27 (on-box wave 9)** and removed from the
> register — its walkthrough below stays for historical context only.
> Follows the shared format fixed by
> [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §5; the re-resolution rule of
> §6 was applied to every row (see [`## Excluded on re-resolution`](#excluded-on-re-resolution)).
>
> **Box/card target:** the operator's GPU box with **both** cards present —
> 8 GB RTX 4070 (internal) + 16 GB RTX 5070 Ti (eGPU over OcuLink). The eGPU is
> **not hot-pluggable** (OcuLink add/remove is reboot-only), so this sitting is a
> single boot with the card connected; any step that needs a swapped enumeration
> is a second 2-card boot, not a live replug.
>
> **Running time total (recomputed 2026-08-21):** **~110 minutes** of runnable
> acceptance — A2 step 9 ≈ 20, A3 ≈ 45, A8 ≈ 25, A18 ≈ 20. A2 step 3 is
> observe-only/N-A (cannot be forced on OcuLink). **A2 rows 6–8 (steps
> 6–8, formerly conditional) are removed from this pack** — the repo owner
> ruled 2026-08-21 that they are not owed (plan 264 itself frames them as
> "deferred by choice, not blocked"; see `onbox-acceptance-register.md`'s A2
> row). The plan of record estimated 110 min
> ([`onbox-sitting-plan.md`](onbox-sitting-plan.md) §2.1); this recomputation
> matches.

## Preconditions

Stated once for the sitting; do not repeat per row.

- [ ] **Both cards booted.** Boot with the 16 GB eGPU connected over OcuLink. `nvidia-smi` lists two devices; `python -c "import torch; print(torch.cuda.device_count())"` returns 2. Record both device indices and UUIDs: `nvidia-smi --query-gpu=index,uuid,memory.total,name --format=csv`.
- [ ] **Server up** on current `main`, built and running against the real (non-mock) sidecar.
- [ ] **`SEG_CAPACITY_ADMISSION=1`** — the A2 walkthrough runs with admission on (plan 264 `:131`).
- [ ] **A real, multi-chapter book loaded** (at least one non-trivial chapter for analysis and render).
- [ ] **Advanced settings reachable** — A18 pins the Qwen/codec device there.
- [ ] **Two shells** open: one for server control / `gh api` / `curl`, one for `nvidia-smi` / `ollama ps` observation.
- [ ] **Engines available:** Ollama `qwen3.5:9b` analyzer installed; Coqui/Kokoro/Qwen TTS weights installed; ASR with `ASR_DEVICE=cuda` available for A2 step 8.
- [ ] **Know which card is which** before pinning — the 8 GB internal card and the 16 GB eGPU, by both index and UUID.
- [ ] **Cold start at A8.1** — no engine resident unless a step says otherwise.

## Procedure

Ordered so shared setup happens once and engine swaps happen as few times as
possible. A8 steps 1–4 run first while the Ollama analyzer is the resident engine
on the 8 GB card; A8 step 5 and A2 step 9 exercise the roomier/2-card paths; A3 is
the multi-GPU Wave 2 checklist; A18 is the device-pin respawn set, done last
because its enumeration-reorder bullet needs a reboot into a swapped-enumeration
2-card config.

### A8 · GPU residency safety + coexistence (plan 222) — steps 1–5

> **Criteria source:** [`../features/222-gpu-residency-and-analysing-honesty.md`](../features/222-gpu-residency-and-analysing-honesty.md) §"Manual acceptance walkthrough (USER-RUN, live GPU — OWED)" at `:54-59`. Distinct from B1/plan 216 (that one is the device probe). This procedure orders the five steps for the sitting and gives the concrete observation; it does not restate the criteria list.
>
> **Step attribution (this row is mixed):** steps 1–4 need only the **8 GB card** (the internal card, present in this 2-card boot) and could equivalently ride with a single-card sitting; step 5 needs the **12/16 GB card** and belongs **only** to this 2-card sitting. All five are run here in one pass so no separate sitting is owed for A8.

1. **(A8.1) 8 GB card, analyzer `qwen3.5:9b` resident:** run analysis on a multi-chapter book. Observe: VRAM holds ~steady (no per-section sawtooth on `nvidia-smi`); `ollama ps` shows the 9B resident throughout; no mid-stream "no response" stalls; the analysing chip reads "Qwen3.5 9B (local)" (not 4B); large chapters show "section M/N".
   - Result:
2. **(A8.2) 8 GB, analysis finished → start generation (Qwen TTS):** observe the server evicts the 9B before the sidecar loads (≤ ~8 GB peak, no OOM).
   - Result:
3. **(A8.3) 8 GB, start generation WHILE an analysis runs on another book:** observe a clear **409 "GPU busy with analysis"** refusal, not an OOM.
   - Result:
4. **(A8.4) 8 GB, voice design:** observe — while analysis is idle, eviction then design proceeds; while analysis is busy, a 409.
   - Result:
5. **(A8.5) 12/16 GB eGPU:** observe **no eviction** — analyzer + TTS coexist (set `GPU_SAFE_COEXIST_MB` if the detected total straddles the default 11000).
   - Result:

### A2 · Capacity-aware GPU placement (plan 264) — step 9, step 3 (N-A)

> **Criteria source:** [`../features/264-vram-aware-gpu-placement.md`](../features/264-vram-aware-gpu-placement.md) §"Manual acceptance walkthrough (owed on-box — the 'no OOM' bar)" at `:129-179`; header `:9-22`.
>
> **Correction, 2026-08-21.** Rows 6–8 (cold `/load` device steer,
> `design_voice` evicts Ollama, GPU-ASR 503→evict→retry) are **not owed** —
> the repo owner ruled they are deferred by choice, resting on automated
> coverage, per plan 264's own closing sentence. The plan's self-
> contradiction (`S6` listed as both force-driven and not) was fixed
> separately (Castwright#2559). This row's remaining scope is step 9 alone.

6. **(A2.9 — #1730, 2-card only) Concurrent cross-card ops keep to their card:** with both cards up, run `design_voice` + `mint_variant` (and, if `ASR_DEVICE=cuda`, a `/transcribe` + `/embed`) concurrently so they land on **different** admitted cards. Observe: each op's entire run — load **and** forward — stays on its own card; no cross-card clobber, no OOM. (`GET /capacity` confirms the reservation per device.) This is the on-box confirmation of PR #1732 (re-resolved: merged 2026-07-19T22:44:02Z) still owed before the concurrent-multi-card flag flip. *Single-8 GB-card runs never hit this path — it is a 2-card-only check.*
   - Result:
7. **(A2.3 — observe-only, N-A) eGPU fault-drop:** IF the eGPU ever drops off the CUDA bus on its own mid-run ("GPU is lost"), the in-flight op fails fast, its reservation releases, a toast fires, and it re-queues onto the 8 GB card. **Cannot be safely triggered on OcuLink** (add/remove is reboot-only; yanking the cable is a hard crash). Mark **Blocked / N-A** unless it happens on its own; the recovery path is unit-covered and not required for sign-off.
    - Result:

### A3 · srv-57 Multi-GPU Wave 2 — ten checklist items (#1230)

> **Criteria source:** issue [`#1230`](https://github.com/dudarenok-maker/Castwright/issues/1230) — the ten-item on-box checklist (re-resolved: still **OPEN**; ten unchecked `- [ ]` boxes confirmed by re-count). Do not restate the checklist here; run it item-by-item on the issue and tick each box as it passes. Task 16/16.5 (auto-revert on a repeated bad pin) is designed but **unbuilt**, gated on item 1 — note its unbuilt state, do not attempt to build it here.

11. **Per-card UUIDs from torch:** confirm the sidecar reports each card's real CUDA UUID (the raw `cuda-uuid:` literal, not a translated `cuda:N`), per card.
    - Result:
12. **Starved card self-exits code 43:** drive a card below `SIDECAR_VRAM_FREE_FLOOR_MB`; the starved card self-exits with code 43, and `/health` shows the breach first.
    - Result:
13. **`QWEN_DEVICE`/`KOKORO_DEVICE` on different cards run concurrently:** confirm concurrent runs land on different cards; same-card pinning still blocks.
    - Result:
14. **Three code-43 exits in ten minutes — card-specific:** trips the streak guard (card-specific variant).
    - Result:
15. **Three code-43 exits in ten minutes — not card-specific:** manual-investigation path (not card-specific variant).
    - Result:
16. **Remaining #1230 checklist items:** complete the rest of the ten-item checklist on the issue (the analyzer CPU/GPU serialization checks and any other items not named above) and tick each box.
    - Result:
17. **Task 16/16.5 status:** confirm it remains unbuilt and gated on item 1 (it consumes the `tripEvent()` that item 1 exercises). Do not build it here.
    - Result:

### A12 · Device-pin resolution survives a respawn (#1870, closes #1857)

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:829-842` — the four on-box bullets. Re-resolved: PR #1870 merged 2026-07-27T01:53:26Z; #1857 closed 2026-07-27T01:53:27Z; `server/src/tts/sidecar-env.test.ts` exists (unit-level only). The behaviour no CI test can reach is a respawn after the device index actually changes.

18. **Pin Qwen to a specific card** in Advanced settings, restart the server, and force a supervisor respawn (`POST /api/sidecar/restart`, or let a recycle fire). Observe: the engine lands on the **pinned** card both times.
    - Result:
19. **(needs a reboot — do last) Change the enumeration order** — swap the cards physically, or set `CUDA_DEVICE_ORDER` — and confirm a respawn still finds the pinned card by **UUID** rather than failing `_validate_cuda_index` or landing on the wrong one. **This is the regression the change exists to prevent**, and it was previously reachable only when the user had opened Advanced settings during that server session. *Requires a second 2-card boot with swapped enumeration; do this as the last 2-card action of the sitting.*
    - Result:
20. **Pin `tts.qwen.codecDevice` to a card** and confirm the codec is actually placed there. Before #1870 the pin was silently ignored — the literal failed inside torch's `.to()` and rolled back to CPU.
    - Result:
21. **Point the codec pin at a card that is NOT present** and confirm the sidecar logs `QWEN_CODEC_DEVICE=… did not match any visible GPU` and leaves the codec on **cpu** — not on the model's card, which is what `auto` would have done.
    - Result:

## Excluded on re-resolution

None excluded. All four rows were re-resolved against live repo/issue/PR state and remain owed:

- **A2** — `grep -n "S6" docs/features/264-vram-aware-gpu-placement.md` re-run → matches line 16 (the register's original "no-match" claim is wrong; the wave-1 audit already corrected it); plan 264 frontmatter `status: active`; PR #1732 re-checked via `gh api …/pulls/1732` → merged 2026-07-19T22:44:02Z. Rows 6–8 ruled **not owed** 2026-08-21 (see the procedure's correction note) — step 9 stays owed.
- **A3** — `gh api …/issues/1230` re-checked → `state: open`, `closed_at: null`; unchecked `- [ ]` count re-run = 10. STILL OWED.
- **A8** — plan 222 frontmatter `status: active`; header `:9` "on-box GPU acceptance owed"; walkthrough at `:54`; PR #840 merged 2026-06-16T11:02:20Z; PR #841 merged 2026-06-16T11:02:59Z. STILL OWED. **Finding (routed to #2435, not fixed):** PR #839 (merged 2026-06-16T07:29:25Z, "fix(server): tolerate stray model keys in analyzer schema validation") is **misattributed** in the register's `*Shipped*` line for A8 — its body is about Ollama JSON schema salvage, unrelated to GPU residency/eviction. #840/#841 are the real match. Does not change the verdict (the walkthrough-owed statement is independently confirmed from the plan header and ship notes). Editing the register is out of scope for this pack.
- **A18** — PR #1870 re-checked → merged 2026-07-27T01:53:26Z; #1857 re-checked → closed 2026-07-27T01:53:27Z; `server/src/tts/sidecar-env.test.ts` exists. STILL OWED.

## Teardown

- [ ] Evict the warm engines (Ollama analyzer + TTS sidecar) so the next sitting starts cold.
- [ ] Clear the env flags set for this sitting — `SEG_CAPACITY_ADMISSION`, `ASR_DEVICE`, `CUDA_DEVICE_ORDER`, `GPU_SAFE_COEXIST_MB` — restoring each to its prior value.
- [ ] Unpin the Qwen/codec device in Advanced settings (or note the pins left in place for the next sitting).
- [ ] Close the book. The box remains in the 2-card boot state — the eGPU stays connected until the operator reboots back to single-card.
