# On-box sitting pack — VRAM contention + eviction (A5, A16, A19, A20, A25, A28, A34, A35, A36)

> **Sitting pack** for wave 2 of `#2435`, step 3 of the `#2453` chain. Covers
> register rows **A5, A16, A19, A20, A25, A28, A34, A35, A36** — the rows that
> only mean something when the single 8 GB card is genuinely full — and nothing
> else. Follows the shared format fixed by
> [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §5; the re-resolution rule of
> §6 was applied to every row (see
> [`## Excluded on re-resolution`](#excluded-on-re-resolution)).
>
> **A16 is included per the plan of record's own re-derivation** (§3): the
> issue #2462 brief's row list omits it, but the plan explicitly moves A16 into
> this pack and is the document that "fixes… the binning you must not
> re-litigate." Its AMBIGUOUS status (frontmatter `active` vs. body `stable`)
> is a docs-status decision, not a reason to skip the live-GPU step — the plan
> says to *run it regardless* and flag the contradiction. See §A16 below.
>
> **Box/card target:** the operator's GPU box, **single 8 GB card**, pinned via
> `CUDA_VISIBLE_DEVICES=0` (internal `cuda:0`, 4070 8 GB). This box is
> dual-GPU, so **every** step here must stay pinned to the one card —
> `_worst_device_key` otherwise picks the roomier `cuda:1` and a row passes or
> fails for entirely the wrong reason.
>
> **Running time total (recomputed):** **~155 minutes** — A5 ≈ 20, A19 ≈ 20,
> A20 ≈ 25, A25 ≈ 20, A28 ≈ 15, A34 ≈ 10, A35 ≈ 15 (subtotal 125), plus **A16
> ≈ 15** (runs in the same session — its book/cast precondition is already
> met by A19/A5/A20's fixture) and **A36 ≈ 15** (also rides the same session's
> ASR pass, folded into no separate block). 125 + 15 + 15 = **155**, matching
> the plan of record's stated total for this pack exactly
> ([`onbox-sitting-plan.md`](onbox-sitting-plan.md) §2.1).
>
> **A19/A5/A20/A25 share one session by design** — same card, same
> mixed-cast non-English book, and A19 already stages the Qwen+Coqui
> co-residency A20's first bullet needs (register `:969`, run sheet §2). Do not
> give them separate sittings.

## Preconditions

Stated once for the sitting; do not repeat per row.

- [ ] **Single 8 GB card.** `CUDA_VISIBLE_DEVICES=0`; `nvidia-smi` lists the
      4070 8 GB as `cuda:0`. Record both device index and UUID:
      `nvidia-smi --query-gpu=index,uuid,memory.total,name --format=csv`.
- [ ] **Box policy pins temporarily undone.** `server/.env` currently pins
      renders to the 16 GB card — `COQUI_DEVICE=cuda:1` / `QWEN_DEVICE=cuda:1` /
      `ASR_DEVICE=cuda:1` (owner's call since 2026-08-01, git-ignored). Every
      row in this sitting targets the **single 8 GB card**, so set all three to
      `cuda:0` (or comment them out) before starting, and **restore them in
      teardown**. Without this the sitting exercises the 16 GB card, not the
      8 GB card these rows are about (register `:904-908`).
- [ ] **Server up** on current `main`, built and running against the real
      (non-mock) sidecar, started via `start-prod.bat` so the `.env` ceilings
      are actually in effect.
- [ ] **A mixed-cast non-English book loaded** — the Russian Coalfall chapter,
      with one designed-Qwen character and one undesigned character that falls
      back to Coqui (the fixture A19/A20/A5/A25/A16 all name). This also
      satisfies A16's "open a real Russian book's cast view" precondition and
      A5's "Russian book with an undesigned character" precondition.
- [ ] **`SEG_CAPACITY_ADMISSION=1`** (the default) and **Qwen as the generation
      engine** (also the default) — neither needs an explicit flip.
- [ ] **Engines available:** Qwen VoiceDesign installed; Coqui XTTS weights
      installed and loadable from the UI; Whisper ASR with `ASR_DEVICE=cuda`
      and `SEG_ASR_ENABLED=1` set (A36 only).
- [ ] **A way to make `/unload` fail** (A19): a `SIDECAR_URL` proxy that 500s
      `POST /unload` and passes everything else through, or the ability to stop
      the sidecar's unload path by hand.
- [ ] **Two shells** open: one for server control / `gh api` / `curl`, one for
      `nvidia-smi` / `/health` polling.
- [ ] **A second browser tab/session** (A35's overlapping requests).
- [ ] **OS-level process-kill access** (A34) — `taskkill` against the pid in
      `.run/tts.pid`.
- [ ] **Cold start** — no engine resident unless a step says otherwise. The
      quiet-box caveat from A19's 2026-08-01 correction applies: a foreign
      process holding `cuda:0` (e.g. another worktree's real-GPU pytest suite)
      makes every reading uninterpretable. Confirm the card is free before the
      first step (`nvidia-smi` ≈ baseline, and `ledger.engines_holding` from
      `GET /api/sidecar/health` showing only this sidecar's reservations).

## Procedure

Ordered so shared setup happens once and engine swaps happen as few times as
possible. A19 → A20 (with A36 riding) → A5 → A16 run as one mixed-cast session
on the same card and book, because A19 stages the Qwen+Coqui co-residency
A20's first bullet needs, A5 and A16 already share the Russian-book fixture,
and A16's banner/auto-load check is a near-zero-cost add to a session that
already has the book open. A28 follows the same session's completed renders
(its stranded pool is exactly what a finished chapter leaves behind). A25
re-uses the same warm card for its contended-eviction `/health` measurement.
A34 and A35 are independent but cheap to run while the sidecar and book are
up.

### A19 · Mixed Qwen+Coqui evict fails soft (#1893) — steps 1–2

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:847-932`
> (the correction block at `:879-908` is the authoritative current state);
> [`onbox-acceptance-staleness-audit.md`](onbox-acceptance-staleness-audit.md) `:777-812`.
> Re-resolved: #1893 closed 2026-07-27T23:44:24Z; #1898 merged
> 2026-07-27T23:44:23Z. The forced-evict scenario itself has never been run.
> The unforced case completed 71/71 at 3.7 GB combined (row's own 2026-08-01
> quiet-box correction), so this row's real question — whether a **failed**
> evict makes co-residency worse — is still open.

1. **(A19.1) Forced-evict mixed render.** Point `SIDECAR_URL` at the proxy that
   500s `POST /unload` (or stop the sidecar's unload path by hand), then render
   the mixed-cast chapter (Qwen + Coqui, Russian Coalfall). Observe: the
   chapter **completes**, and the server log carries verbatim
   `fs-60 Qwen→Coqui evict failed; continuing into the Coqui phase`.
   - Result:
2. **(A19.2) Classify the outcome + pause-during-stalled-evict.** Record which
   of the three outcomes the co-residency produced — **clean completion**, a
   **self-describing sidecar OOM** that fails the chapter with its own message,
   or a **crash/recycle storm** (the third means the fail-soft policy needs
   retry-then-abort instead of warn-and-continue — file it back on #1893).
   Then start the render again with the evict stalled and press **Pause**:
   observe the abort is forwarded to the fetch and the run stops **promptly**,
   not after the 10-minute ceiling (register `:922-923`).
   - Result:

### A20 · Idle Coqui is reclaimed under VRAM pressure (#1894) — steps 3–5

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:934-976`;
> the spec at `docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` §6;
> TTL rationale in the comment on `_COQUI_IDLE_TTL_DEFAULT` in `tts-sidecar/main.py`.
> Re-resolved: #1894 closed 2026-07-28T05:48:34Z; #1921 closed
> 2026-07-28T11:27:04Z; `_COQUI_IDLE_TTL_DEFAULT = 30.0` still the shipped
> default. None of the four on-box bullets has been exercised — this row
> carries no observation block at all.

3. **(A20.1) Idle reclaim admits a blocked Qwen op.** Load Coqui from the UI so
   it is resident, then start a Qwen-only render that would not otherwise fit
   on the 8 GB card. Observe: the render **proceeds** and the sidecar log
   carries `Coqui model unloaded.`; record whether the reclaimed ~3 GB actually
   admitted the op, or was immediately taken by something else.
   - Result:
4. **(A20.2) Chapter-boundary TTL observation.** Render the mixed Qwen+Coqui
   book and watch the chapter boundaries. Observe which it is: an
   **evict→reload cycle repeating across chapters** means `COQUI_IDLE_TTL` is
   too short (each reload ~90 s); a render that still fails `NoCapacityError`
   with an idle Coqui resident means it is too long. Record the observed
   interval between the evict and the next Coqui use, so the default can be
   moved off 30 s with evidence rather than a guess.
   - Result:
5. **(A20.3) Stop-button crash fix + control timing.** Press **Stop** on Coqui
   while a chapter is rendering through it. Observe: the chapter continues to
   **completion** (before #1894 this could kill it with
   `AttributeError: 'NoneType' object has no attribute 'tts'`). Record what the
   Stop control itself reports — it must show a disabled **"Stopping…"** state
   for the whole wait and complete without an error banner — and how long the
   eventual unload actually took.
   - Result:

### A5 · fs-60 XTTS per-language engine eligibility (plan 249) — step 6

> **Criteria source:** [`../features/249-fs60-xtts-language-eligibility.md`](../features/249-fs60-xtts-language-eligibility.md)
> `:53-66` (five-step walkthrough). Re-resolved: plan frontmatter `status: active`;
> body `:9` "Live-GPU acceptance owed (mock-mode e2e only)… stays `active`,
> not `stable`, until that walkthrough runs" — re-read verbatim, still true.
> STILL OWED.

6. **(A5) Coqui-fallback banner, engine picker, real render, hard-block check.**
   On the same Russian Coalfall book, open the undesigned character's row and
   observe the Coqui-fallback banner (not a hard block); confirm the engine
   picker offers Coqui; confirm the voice-readiness gate offers "Proceed
   anyway"; render that character's line and confirm the player shows a
   "Fallback (Coqui)" pill. Then switch to a still-unsupported language
   (Chinese, no fixture change needed beyond the book's language field) and
   confirm the **old hard block** still applies there — this is the
   "supported-but-undesigned falls back, unsupported still blocks" contrast
   the row exists to prove.
   - Result:

### A16 · fe-16 Qwen auto-load on a Russian book (plan 165) — step 7

> **Criteria source:** [`../features/archive/165-fe-15-16-language-and-revision-e2e.md`](../features/archive/165-fe-15-16-language-and-revision-e2e.md)
> `:9` (Status line) + ship notes ("live GPU acceptance is the only owed
> item"). Re-resolved 2026-08-19: frontmatter `status: active` (`:2`), body
> `> Status:` line (`:9`) reads `stable (shipped together; manual acceptance
> owed only for the live Qwen auto-load)` — the contradiction the register
> flags is real and unchanged.
>
> **Not in this pack's assigned issue list (#2462), but binned here by the
> plan of record** (`onbox-sitting-plan.md` §3), which is the authoritative
> document for this chain's row assignment. **Blocked on a decision: plan 165's
> own status is `active` in frontmatter vs. `stable` in its body — that
> contradiction is a docs-reconciliation call for the operator, not resolved
> here. Run the live-GPU step regardless**, per the plan's explicit
> instruction; only the frontmatter/body reconciliation is deferred.

7. **(A16) Qwen auto-load banner + analyzer eviction.** On the same Russian
   Coalfall book's cast view, confirm the Qwen banner shows and Qwen loads in
   the background. Observe the analyzer (Ollama) log/process for eviction —
   confirm it is evicted to make room, not left co-resident causing contention.
   - Result:
   - **Separately, flag for the operator:** plan 165 frontmatter says `active`,
     body says `stable` — needs reconciliation, not resolved by this pack.

### A25 · `/health` stays live through a contended eviction (#1919) — step 8

> **Criteria source:** run sheet
> [`sidecar-evict-latency-onbox-acceptance.md`](sidecar-evict-latency-onbox-acceptance.md)
> §§2–3 — cited, not restated, per the plan-of-record rule against copying a
> criteria list that then drifts from the original. Re-resolved: #1919 closed
> 2026-07-31T00:32:59Z. STILL OWED — the run sheet itself has empty `Result:`
> lines.

8. **(A25) Run the sidecar-evict-latency run sheet's procedure §3, steps 1–6**
   (its "optional second pass," step 7, is skippable — not required to clear
   this row). Its own preconditions are already satisfied by this session's
   Preconditions above (same card, same Qwen-design-then-render sequence). Fill
   in that run sheet's own §5 `Result` block directly — do not duplicate its
   fields here.
   - Result: _(filled in `sidecar-evict-latency-onbox-acceptance.md` §5, not here)_

### A28 · Stranded VRAM pool reclaimed on the admission-failure path (#1976, PR #1993) — step 9

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:1321-1355`
> (PR #1993's description + the C1/M3 review findings it quotes). Re-resolved:
> #1976 still **OPEN** (`Refs #1976`, not closed by this PR — the
> render/unload-completion reclaim is a separate, not-yet-built lever); PR
> #1993 merged 2026-07-31T09:22:51Z. STILL OWED.

9. **(A28) Stranded-pool reclaim + the two C1 guards.** Using the chapter
   render just completed in A19/A20/A5 (or A16), let the engine report
   unloaded and confirm via `nvidia-smi` and `GET /api/sidecar/health`'s
   `vramReservedMbByDevice` that a reserved-but-unallocated pool is left
   behind (~3.9 GB on this 8 GB card is #1976's own measured shape). With that
   pool present and nothing resident, issue an ASR `/transcribe` or a voice
   design that would otherwise be refused; confirm it is **admitted** and
   `nvidia-smi` drops to near-baseline afterward. Then confirm the two C1
   guards: (a) start a genuine render and, from a second client, issue a
   refused op on the same card — the reclaim log line `stranded-cache reclaim`
   must **not** appear while the render is in flight; (b) issue two refused
   ops on the same card within 30 s of each other and confirm the reclaim log
   line appears **only once**.
   - Result:

### A34 · Supervisor respawn survives a refused spawn attempt (#2037) — step 10

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:2014-2055`;
> code contract `scheduleRespawnAttempt` (`server/src/tts/sidecar-supervisor.ts`)
> and `onSpawnRefused` (`server/src/tts/spawn-sidecar.ts`). Re-resolved: #2037
> closed 2026-08-05T00:37:01Z. STILL OWED — real OS socket-teardown timing is
> untestable in CI.

10. **(A34) Kill the sidecar mid-render, watch respawn.** With a chapter
    actively rendering, kill the sidecar's OS process directly —
    `taskkill /PID <pid> /T /F` against the pid in `.run/tts.pid` (**do not**
    use `POST /api/sidecar/restart`, which actively restarts rather than
    passively observing the recovery this row is about). Grep the running
    server's log for a fresh `[sidecar] spawned pid=` line appearing on its
    own within the backoff window (`[2s, 5s, 15s]`, capped at 5 attempts ≈
    52 s total); confirm the new pid differs from the killed one. While
    recovery is in flight, poll `GET /api/setup/models-status` and confirm it
    never reports the TTS engine ready while nothing is listening on `:9000`.
    Confirm the in-flight chapter either rides out the respawn or fails
    cleanly and is resumable.
    - Result:

### A35 · Design-wins VRAM contention timeout vs. a real 0.6B cold load (#2070) — step 11

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:2057-2086`;
> `unload_design`'s docstring and the `_DESIGN_CONTENTION_WAIT_S_DEFAULT`
> comment in `server/tts-sidecar/main.py`. Re-resolved: #2070 closed
> 2026-08-05T05:54:35Z. STILL OWED — the 150 s bound is sized off the design
> path's documented budget, not an on-box measurement.

11. **(A35) Overlapping design + render, then a forced timeout.** Start a
    voice design (cast review → Design a new voice) on one browser
    tab/session, and — timed to land mid-design, before the design's forward
    completes — trigger an ordinary chapter render on a *different* voice from
    the second tab/session. Confirm the render's synth call **waits** for the
    design to finish (no error, delayed start only) rather than the design
    failing with "VoiceDesign model was unloaded before this design could
    render." Confirm the design itself completes and its audition plays. If
    practical, force a genuinely wedged design and confirm the waiting synth
    times out into the `design_in_flight` 503 somewhere in the 150 s
    neighbourhood, not immediately and not never.
    - Result:

### A36 · ASR warm-reservation figure vs. a real resident `/transcribe` peak (#2094) — step 12

> **Criteria source:** [`onbox-acceptance-register.md`](onbox-acceptance-register.md) `:2088-2127`;
> the `asr.warm` seed comment in `SEED_FOOTPRINTS_MB` and `_device_free_mb`'s
> docstring (`server/tts-sidecar/main.py`). Re-resolved: #2094 closed
> 2026-08-05T05:54:36Z. STILL OWED. **Rides along with A20** — this step reuses
> the same rendered chapter and warm sidecar; no separate sitting block.

12. **(A36) Resident ASR under repeated `/transcribe`.** With
    `ASR_DEVICE=cuda` and `SEG_ASR_ENABLED=1` set (per Preconditions), and
    using the chapter already rendered in A19/A20, trigger several
    `/transcribe` calls back-to-back (a re-record round is the natural
    trigger). Confirm none 503 `noCapacity` on a card that has genuine room.
    Watch `FootprintTable`'s learned `asr.warm` p95 after ≥5 real observations
    (`_FOOTPRINT_MIN_SAMPLES`) and record what it converges to — double digits
    to low hundreds of MB is a sane, uncontaminated read; hundreds of MB to
    GB points at a foreign process on the card.
    - Result:

## Excluded on re-resolution

None excluded. All nine rows were re-resolved against live repo/issue/PR
state on 2026-08-19 and remain owed:

- **A5** — plan 249 frontmatter `status: active`; body `:9` re-read, still
  "Live-GPU acceptance owed." STILL OWED.
- **A16** — plan 165 frontmatter `status: active` (`:2`), body `> Status:`
  (`:9`) reads `stable`. Contradiction confirmed live, unchanged from the
  register's note. STILL OWED, and the frontmatter/body contradiction is
  flagged for the operator rather than resolved here (see §A16).
- **A19** — `gh issue view 1893` → closed 2026-07-27T23:44:24Z; `gh pr view
  1898` → merged 2026-07-27T23:44:23Z. Forced-evict scenario confirmed never
  run. STILL OWED.
- **A20** — `gh issue view 1894` → closed 2026-07-28T05:48:34Z; `gh issue view
  1921` → closed 2026-07-28T11:27:04Z. `_COQUI_IDLE_TTL_DEFAULT = 30.0`
  confirmed still the shipped default in `tts-sidecar/main.py`. STILL OWED.
- **A25** — `gh issue view 1919` → closed 2026-07-31T00:32:59Z. Run sheet
  `sidecar-evict-latency-onbox-acceptance.md` §5 confirmed all `Result:`
  fields still blank. STILL OWED.
- **A28** — `gh issue view 1976` → **still OPEN** (this PR only `Refs`, not
  `Closes`, it); `gh pr view 1993` → merged 2026-07-31T09:22:51Z. STILL OWED.
- **A34** — `gh issue view 2037` → closed 2026-08-05T00:37:01Z. STILL OWED.
- **A35** — `gh issue view 2070` → closed 2026-08-05T05:54:35Z. STILL OWED.
- **A36** — `gh issue view 2094` → closed 2026-08-05T05:54:36Z. STILL OWED.

## Teardown

- [ ] Evict the warm engines (Qwen Base, Qwen VoiceDesign, Coqui, ASR) so the
      next sitting starts cold.
- [ ] Restore `server/.env`'s `COQUI_DEVICE` / `QWEN_DEVICE` / `ASR_DEVICE`
      pins back to `cuda:1` (the owner's box policy) if they were changed for
      this sitting.
- [ ] Remove the `/unload`-failing proxy or restore the sidecar's real unload
      path (A19).
- [ ] Clear `SEG_ASR_ENABLED` / `ASR_DEVICE=cuda` if they were set only for
      this sitting and are not the box's standing default.
- [ ] Close the second browser tab/session (A35) and the extra shells.
- [ ] Confirm the card returns to baseline (`nvidia-smi` ≈ idle) before
      ending the sitting.
