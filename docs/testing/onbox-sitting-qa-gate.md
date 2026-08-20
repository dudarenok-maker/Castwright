# On-box sitting — QA gate, loudness provenance & re-record

> **This is a working document.** Fill in the `Result:` lines AS you run this
> on the box, with the real GPU + real TTS sidecar. Do not pre-fill them.
>
> Plan of record: [`onbox-sitting-plan.md`](onbox-sitting-plan.md) (§2.1, §5 pack
> format), step 5 of the [#2453](https://github.com/dudarenok-maker/Castwright/issues/2453) chain.
> Register rows: [`onbox-acceptance-register.md`](onbox-acceptance-register.md)
> A9, A10, A11, A12, A13, A21, A22, A23, A37.
> Row plans: [`228-batch-qa-rerecords.md`](../features/228-batch-qa-rerecords.md),
> [`176-character-splice.md`](../features/176-character-splice.md),
> [`173-failure-taxonomy.md`](../features/173-failure-taxonomy.md),
> [`174-audio-qa-gate.md`](../features/174-audio-qa-gate.md),
> [`175-resource-telemetry.md`](../features/175-resource-telemetry.md),
> [`archive/274-loudness-measurement-provenance.md`](../features/archive/274-loudness-measurement-provenance.md),
> [`2055`](https://github.com/dudarenok-maker/Castwright/issues/2055) (A37 fix), [`2026`](https://github.com/dudarenok-maker/Castwright/issues/2026) (A37 repro source).
>
> **Running time total (recomputed):** 20 (A9) + 20 (A10) + 15 (A11) + 15 (A12) +
> 15 (A13) + 10 (A21) + 10 (A22) + 10 (A23) + 40 (A37) = **155 minutes**,
> matching the plan of record's §2.1 estimate for this pack.

---

## Re-resolution note

Every row below was re-resolved against live state on 2026-08-20, not taken from
the staleness audit as given: `gh issue view`/`gh pr view` re-run for every
issue/PR the audit cites, and each row's plan file re-read for its current
`status:` frontmatter and Ship notes. All nine rows still match the audit's
verdicts exactly — no row is discharged or self-contradictory. No row is
excluded.

**A22 is AMBIGUOUS** per the audit and the plan of record: whether #1909's
"no change" closure (decided on a subjective A/B listen) retires A22's own
`tp`-per-chapter distribution criterion, or leaves it independently owed. This
pack does **not** resolve that — it is marked in Step 8 below as blocked on a
decision, and its procedure is written so the operator can still capture the
data if they choose to run it.

---

## Preconditions

- [ ] Single 8 GB card (`CUDA_VISIBLE_DEVICES=0`), rides the same book/voice
      residency the earlier sittings in this wave established (voice design →
      cloning/identity → this sitting, per plan §4 step 6).
- [ ] A rendered real book with at least one chapter already through the full
      generation + QA gate pipeline (for A21's badge-agreement check) and
      spare chapters available to re-render (for A9, A12, A23).
- [ ] `SEG_ASR_ENABLED=1` set for the whole sitting except the A37 leg, which
      additionally needs the Coqui/XTTS engine selected — see Step 9's own
      engine-swap note.
- [ ] A second shell free for `gh`/log tailing and for triggering the
      sidecar-kill in Step 3.
- [ ] Access to `#/admin` → "Resource trends" (A13) and to a chapter's
      Generate + Listen rows (A9, A11, A12, A21).
- [ ] A non-English (Russian ideal) book or chapter available for A37 —
      required only for that step, sequence it last (Step 9).

---

## Procedure

### 1. Batch QA re-record RTF (A9 — plan 228)

**Do:** Regenerate a QA-flagging Qwen chapter (e.g. KotLC "Chapter Three") with
the full gate stack on (`SEG_ASR_ENABLED=1`, signal-QA + ASR re-records at 2).

**Observe:** RTF for the run, compared against the ~1.2 target (down from the
pre-fix ~1.9–2.0 regression) — plan 228 §"Acceptance" (`:97-99`). Confirm the
same suspect/asrSuspect flagging behaviour appears as on any other chapter.

Result: _(fill in — measured RTF)_
Result: _(fill in — suspect/asrSuspect flags present as expected: yes/no)_

### 2. Per-character re-record / splice, +3 dB gain (A10 — plan 176)

**Do:** On the rendered book from Step 1 (or another already-rendered book),
open a character's profile → Fix audio → apply the **+3 dB gain** across all
that character's chapters. Then re-record one chapter's lines for that
character.

**Observe (gain step):** the result is audibly louder, chapter duration is
unchanged, `.previous.*` backup files are written, A/B playback (before/after)
works, and the chapter's loudness stays ≈ −16 LUFS after the gain.
**Observe (re-record step):** timing integrity holds — no seam at the
re-recorded lines' boundaries, no doubled chapter title (this is the
regression class fs-10/`#412` fixed and pinned; confirm it does not recur on a
real render).

Result: _(fill in — louder, duration unchanged, backups written, A/B works: yes/no)_
Result: _(fill in — post-gain LUFS reading)_
Result: _(fill in — re-record seam/doubled-title check: pass/fail, detail)_

### 3. Structured failure taxonomy, ≥2 real failure modes (A11 — plan 173, fs-19)

**Do:** Force two distinct real failure modes against a live render:
1. **`sidecar-unreachable`** — stop the TTS sidecar process mid-render.
2. **`vram-spill`** — oversubscribe VRAM (e.g. start a second concurrent
   admission on the same card while the first is mid-forward) so the engine
   raises an out-of-memory condition.

**Observe:** for each, the Generate row and the toast both show the friendly
message plus its remediation line (not a raw stack trace or generic error).

Result: _(fill in — sidecar-unreachable: message + remediation shown, verbatim)_
Result: _(fill in — vram-spill: message + remediation shown, verbatim)_

### 4. Post-synthesis audio QA gate, deliberately degraded render (A12 — plan 174, srv-27)

**Do:** Craft a chapter render that deliberately fails one of `DEFAULT_QA_THRESHOLDS`
(plan 174 `:22`) — e.g. force a near-silent result (well under −40 LUFS) or a
truncated/clipped one. The easiest reliable recipe: pause a source paragraph on
an already-known-quiet voice, or truncate the sidecar's output stream before
loudnorm.

**Observe:** the amber **"Suspect"** badge appears on both the Generate row and
the Listen row for that chapter, with the correct reason (near-silent /
clipped / truncated) as its tooltip.

Result: _(fill in — degraded condition used)_
Result: _(fill in — Suspect badge shown on Generate row: yes/no, reason text)_
Result: _(fill in — Suspect badge shown on Listen row: yes/no, reason text)_

### 5. Resource trends admin panel, multi-chapter run (A13 — plan 175, fs-20)

**Do:** Run a real multi-chapter render on the GPU box (the Step 1 and Step 2
renders together should already qualify if run back-to-back; otherwise render
2+ chapters here).

**Observe:** `#/admin` → "Resource trends" shows RTF / QA / VRAM / wall-time
rows for the run, and the sparkline actually tracks RTF across the chapters
rendered (not flat / not the mock's placeholder value).

Result: _(fill in — RTF/QA/VRAM/wall-time rows present: yes/no)_
Result: _(fill in — sparkline tracks real per-chapter RTF: yes/no, describe)_

### 6. Suspect-badge / Listen-badge dBTP agreement (A21 — plan 274 §6 row 1)

**Do:** Using the full multi-chapter render already produced in Steps 1–2/5,
check every chapter that carries a true-peak-related Suspect reason.

**Observe:** for each such chapter, the Suspect badge's true-peak reason and
the Listen-view loudness badge's dBTP figure quote the **same number**. Note
any chapter where they disagree.

Result: _(fill in — chapters checked, and per-chapter dBTP agreement: match/mismatch, figures)_

### 7. Real-corpus true-peak distribution (A22 — AMBIGUOUS, plan 274 §6 row 2) — optional, do not resolve

**Blocked on a decision:** whether #1909's 2026-07-31 closure ("current
pipeline preferred, no code change" — decided on a subjective 4-pass A/B
listen, not a per-chapter `tp` distribution) retires this row, or whether the
real-corpus `tp`-vs-`QA_CLIP_TP_DB` observation A22 asks for remains
independently owed for any future retune. This pack does not decide that.

**Do (optional, if the operator chooses to capture the data anyway):** across
the real book rendered in Steps 1–2/5, record the measured `tp` (true-peak)
value per chapter.

**Observe:** whether any chapter's `tp` approaches the `QA_CLIP_TP_DB` default
ceiling (`-0.1` dBTP).

Result: _(fill in, if run — per-chapter tp spread; "not run — left to operator decision" otherwise)_

### 8. Measurement-failure path renders as untrusted (A23 — plan 274 §6 row 3) — opportunistic

**Do:** Opportunistically, across the renders already produced in this
sitting, watch for (or attempt to force, e.g. via a corrupted/short audio
segment that would make `ebur128` fail its pass) a chapter whose loudness
measurement pass genuinely fails.

**Observe:** such a chapter carries `measurementSource: 'loudnorm'` — no,
carries the **absence** of a trustworthy measurement — and both the
Listen-view badge and the report-card row show "No measurement" rather than a
fabricated `-1.5`-style figure. This row is hard to force naturally (plan 274
`:872`); a genuine miss (no failure observed this sitting) is an acceptable
outcome, but record the attempt.

Result: _(fill in — failure forced or caught: yes/no; if yes, badge + report-card behaviour observed)_

### 9. Catastrophic-WER override on a real Coqui language-collapse (A37 — #2055) — **engine swap, run last**

**Engine swap:** switch the sidecar to the Coqui/XTTS engine with ASR
content-QA on (`SEG_ASR_ENABLED=1`, Coqui selected) — this is why this step is
sequenced last in the sitting, so the swap happens once.

**Do:** With a Russian (or French/Spanish) book, reproduce #2026's own
language-collapse recipe — short lines (e.g. two-word Russian phrases),
repeated synthesis of the same short lines on a stock catalogue voice (#2026
used `Damien Black`, `xtts_v2`, `language: ru`); the collapse is intermittent
(#2026 needed 6 repeated runs to hit it once), so budget several repeats
rather than a single pass. Then, across the same or a longer healthy-content
render, confirm ordinary hard-to-transcribe-but-correct lines (invented
character names, foreign phrases, background noise) do **not** trigger the
override.

**Observe:** on a genuine collapse, the segment carries `asr.verdict: drift`
with a reason mentioning "catastrophically wrong" (was `inconclusive` and
shipped unflagged before #2055). On the healthy-content pass, no new
false-positive re-records versus the pre-#2055 baseline. Criteria: the
`CATASTROPHIC_WER` / `qa.asr.catastrophicWer` comment in
`server/src/tts/segment-asr-qa.ts`.

Result: _(fill in — collapse reproduced: yes/no, attempts taken)_
Result: _(fill in — if reproduced, verdict + reason text on the collapsed segment)_
Result: _(fill in — healthy-content pass false-positive count, vs. pre-#2055 baseline)_
**Run by:** _(fill in)_ **Date:** _(fill in)_

---

## Teardown

- Evict the Coqui/XTTS engine loaded for Step 9 if nothing later needs it
  resident.
- Unset `SEG_ASR_ENABLED` if the next sitting does not want it on by default.
- Clear any deliberately-degraded fixtures created for Steps 4/8 so they do
  not linger in the book's chapter list.
- Leave the admin "Resource trends" panel as-is (read-only view, nothing to
  restore).

_(Once every row above is actually run, mark the corresponding rows A9, A10,
A11, A12, A13, A21, A23, A37 discharged in `onbox-acceptance-register.md` with
a summary of each result — and record the A22 decision once the operator makes
it — and remove them from the "owed" count. This pack does not do that.)_
