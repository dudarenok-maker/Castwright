# On-box sitting plan — the plan of record for wave 2 of #2435

> **Plan of record.** This document bins **all 67 rows** of
> [`onbox-acceptance-register.md`](onbox-acceptance-register.md) into exactly one
> of three sets — an operator sitting pack, a wave-3 agent-runnable row, or a
> blocked-on-acquisition row — and fixes the **shared pack format** every later
> child in the #2453 chain obeys.
>
> Chain: #2453 (parent) → **#2464 (this step, the plan)** → #2463–#2455 (the nine
> pack children) → #2454 (`[claude][verify]`, opens the single PR).
> Audit input: [`onbox-acceptance-staleness-audit.md`](onbox-acceptance-staleness-audit.md).

---

## 1. Purpose

A **sitting pack** is a runbook: a single, ordered, self-contained procedure the
operator can execute start to finish on the box **without deciding anything**.
Each pack covers one sitting — one contiguous block of box time that shares its
hardware setup, its engine residency and its book/voice fixtures, so that
expensive setup (plugging the eGPU, warming Qwen, loading a real book) happens
**once** and every row that needs it rides on the same boot.

**Packs are runbooks, not discharges.** Filling in a pack's `Result:` lines is
the on-box run; it retires nothing by itself. A row leaves the register only when
the acceptance was actually run and recorded, or the owner confirms it — exactly
the rule the register already states.

**No row is retired by this wave.** The register is unchanged. This plan and the
nine packs that follow it are the runbooks that make running the owed acceptance
cheap and ordered; they do not edit `onbox-acceptance-register.md`, the live-view
HTML, the staleness audit, or any existing run sheet.

---

## 2. The three sets

Every one of the 67 register rows appears **exactly once** across the three sets
below. The arithmetic is stated under each table and reconciled in §6.

### 2.1 Operator sittings (51 rows, 8 packs)

These need the operator's GPU box — a live card, real engine residency, a real
TTS sidecar, a real analyzer, or a real phone/browser on the LAN. Each is one
sitting; A1 is several sittings inside one pack.

| Pack file | Rows (as numbered when each pack was written) | Est. min |
|---|---|---|
| [`onbox-sitting-two-card-boot.md`](onbox-sitting-two-card-boot.md) | A2, A3, A8, A18 | 110 |
| `onbox-sitting-vram-contention.md` | A5, A16, A19, A20, A24, A26, A32, A33, A34 | 155 |
| `onbox-sitting-voice-design.md` | A4, A6, A7, A14, A15, A17, A30 | 155 |
| `onbox-sitting-qa-gate.md` | A9, A10, A11, A12, A13, A21, A22, A35 | 145 |
| `onbox-sitting-cloning-identity.md` | A23, A25, A29, A30, A31, A41, A42, A43, A44 | 185 |
| `onbox-sitting-multilanguage.md` | D1, D2, A36, E4 | 165 |
| `onbox-sitting-device-browser.md` | E1, E2, E3, E5, E6, E7, E8 | 140 |
| `onbox-sitting-fs38-wave3.md` | A1 | multi-hour, several sittings |

> **Wave-4 note (#2551 step 6), 2026-08-21.** This wave's retirements/
> discharges renumbered the register (see its own "At a glance" correction
> note). The COUNT changes below reflect real losses: `onbox-sitting-qa-gate.md`
> lost the row it called A22 (real-corpus true-peak distribution, retired
> 2026-08-21, 10 min — the register's old A23, "measurement-failure path
> renders as untrusted," is now A22 in that pack); `onbox-sitting-
> cloning-identity.md` lost the row it called A43 (discharged 2026-08-21,
> ~20 min) and shrank A33 (now A31) from ~30 to ~15 min (its §8.8 half
> discharged, only §8.7 remains); `onbox-sitting-device-browser.md` lost the
> row it called E6 (moved to Blocked, 30 min; the old E7/E9/E10 that followed
> it are now E6/E7/E8). **Addendum, same day (docs fold-in pass):** the
> "Rows" column above has now been reconciled to each pack file's current,
> post-renumbering row labels — it no longer names rows by the number they
> carried when originally written.

<!-- The seven rows above are plain code spans, not links, until their pack
files exist — review of PR #2470 (attempting to fix this a different way)
found that this repo's docs/testing link-scan guard (test:hooks) walks the
WHOLE tree on every commit, so a real .md link to a not-yet-written sibling
fails every intermediate commit in this chain, not just the one that would
add the dangling link. #2454's final commit (once all eight packs exist)
flips these back to real links. See #2463 for the incident this avoids. -->

**Row count:** 4 + 9 + 7 + 8 + 9 + 4 + 7 + 1 = **49** (was 52 before wave 4's
retirements/discharges — see the 2026-08-21 correction below).

> **Correction, 2026-08-20 (wave-3 step 9 of `#2497`).** `#2497`'s wave-3
> plan (`docs/testing/onbox-wave3-plan.md` §§2-3) re-derived A33 and A43 —
> both binned below in §2.2 as "wave-3 agent-runnable" — and found both
> actually need a real TTS render + human listening and/or a live-browser
> Cast-screen observation, which is not agent-runnable by this plan's own
> definition of the boundary (§1: "a live card, real engine residency... or
> a real phone/browser"). Both move here, to
> `onbox-sitting-cloning-identity.md`, joining A32 (the same character-
> identity family, on the same real workspace). §2.2 and the arithmetic in
> §6 are corrected to match; nothing else in this plan changes.

> **Correction, 2026-08-20 (rework of wave-3's own recording, `#2497`).** E7
> is **split**: wave-3 step 7 discharged its server/poll wiring for real, but
> its rendered-half observations (register row E7, items 1, 2, 4, 5, 6) need
> a real browser watching a real card render — not agent-runnable, same
> boundary as A33/A43 above. E7 was left counted whole in §2.2's wave-3
> agent-runnable set even though half its debt isn't agent-runnable at all.
> E7 moves here, to `onbox-sitting-device-browser.md`, joining E1, E2, E3,
> E5, E6, E9, E10 (the same no-GPU, browser-shaped sitting). §2.2 and the
> arithmetic in §6 are corrected to match.

> **Correction, 2026-08-21 (wave 4, #2551 step 6).** Wave 4 retired/
> discharged/reclassified several rows, changing the register's own total
> from 74 to **67** (see the register's own "At a glance" correction note
> for the full per-group arithmetic). Effects on this plan's sets:
> **A22** (real-corpus true-peak distribution, binned in
> `onbox-sitting-qa-gate.md`) retired — operator set −1. **A27** (Kokoro/Qwen
> install surfaces, wave-3 agent-runnable) discharged — wave-3 set −1.
> **A43** (Cast-screen orphan link, binned in
> `onbox-sitting-cloning-identity.md`) discharged — operator set −1.
> **B2** (per-model analyzer keep-alive, wave-3 agent-runnable) retired
> (its step 7 moved to Blocked) — wave-3 set −1. **E6** (old numbering —
> ffmpeg floor, binned in `onbox-sitting-device-browser.md`) moved to
> Blocked — operator set −1. **E8** (old numbering — golden-assembly second
> ffmpeg build, wave-3 agent-runnable) moved to Blocked — wave-3 set −1.
> **F1** (Android companion app, the whole blocked-on-acquisition Group F)
> discharged by the repo owner — blocked set −1, and Group F no longer
> exists. Net: operator 52→**49**, wave-3 18→**15**, blocked 4→**3**,
> total 74→**67**. §2.2 and §2.3 below, and §7's totals, are corrected to
> match; the rest of this plan (§1, §3, §4, §5, §6) is otherwise unaffected.
>
> **Correction, 2026-08-22 (merge with `main`, #2551 wave 4 close-out /
> PR #2588).** PR #2588 added a new wave-3 agent-runnable row for the
> `speaker-qa.txt` reqHash fix's one-time real-venv reinstall — sidecar-venv-
> only, no GPU requirement. It landed on `main` as A48 (old numbering);
> folded into this wave's contiguous renumbering it is **A45**. Wave-3 set
> **15→16**, total **67→68**.

### 2.2 Wave-3 agent-runnable (15 rows)

These need no GPU and no operator box. They are excluded from every pack above
and are run, on a machine of the agent's choosing, by the wave-3 pass — not by a
pack child in this chain.

A29, A39, A40, A41, A42, A45, B1, B4, C1, C2, C3, C4, E11, G1, G2. (Named
by the number each row carried when last binned here — A27 and E8, old
numbering, are removed entirely, discharged/moved to Blocked this wave; see
the 2026-08-21 correction above. The register's own current numbering
renames several of these — e.g. old A29 is now A27 — see the register's own
correction note for the full renumbering. A45 — old numbering A48, PR #2588
— added by the 2026-08-22 correction above. B3 (characterId drift, #2040)
was discharged by PR #2585 and is removed entirely.)


**Row count:** 6 (group A: A29, A39, A40, A41, A42, A45 — A27 discharged,
removed) + 2 (B: B1, B4 — B2, B3 retired/discharged, removed) + 4 (C) + 1 (E11 — E8
moved to Blocked, removed) + 2 (G) = **15** (was 16 before B3's discharge,
18 before wave 4's three removals).

### 2.3 Blocked-on-acquisition (3 rows, 1 pack)

These need hardware or material the operator does not yet have on the bench —
real full-length CJK manuscripts. They get a pack so the procedure is ready
the moment the hardware lands, but the sitting cannot be scheduled until
acquisition.

| Pack file | Rows | Est. min |
|---|---|---|
| `onbox-sitting-blocked-prerequisites.md` | H1, H2, D3 | 50 |

**Row count:** **3** (was 4 — **F1** discharged by the repo owner 2026-08-21,
confirmed live end-to-end on a real device; Group F no longer exists in the
register). (Plain code span, not a link — same not-yet-written-sibling reason as §2.1's table; see the note there.)

### Arithmetic

**49** (operator) + **15** (wave-3) + 3 (blocked) = **67**. Every register row
appears exactly once. (Before wave 4 (the 2026-08-21 correction above), this
read 52 + 18 + 4 = 74 — wave 4's retirements/discharges/reclassifications
account for the full delta: −3 operator, −3 wave-3, −1 blocked, net −7,
74 → 67. PR #2588 then added A45 · `speaker-qa.txt` reqHash fix, which is
sidecar-venv-only with no GPU requirement, joining the wave-3 agent-runnable
set: 49 + 15 + 3 → 49 + 16 + 3, **67 → 68**. However, PR #2585 discharged
B3 (characterId drift, #2040), which reduced wave-3 from 16 back to **15**,
restoring the total to **67**. The merge that brought both PRs in did not
fully account for this, creating a temporary 68-row miscounting now corrected.)
---

## 3. A16 — re-derived binning and reasoning

The audit bins **A16** (`fe-16 Qwen auto-load on a Russian book`, plan 165) as
`Hardware still required: real workspace, no GPU`. **That field is wrong**, and
the audit's own evidence contradicts it:

- The plan's walkthrough **step 4** (line 94) is labelled **`(owed, real backend
  + GPU)`** and reads: *"Open a real Russian book's cast → the Qwen banner shows
  and Qwen loads in the background (analyzer evicted)."*
- The plan's **ship notes** (line 108): *"fe-16 Qwen auto-load is wired and
  unit-covered; **live GPU acceptance is the only owed item**."*
- The audit's own **Remains owed**: *"…confirm the Qwen banner shows and Qwen
  auto-loads with the analyzer evicted … on real hardware."*

Qwen is a GPU-resident model; "Qwen loads" means it loads into VRAM. "Analyzer
 evicted" is VRAM contention — the analyzer is reclaimed to make room for Qwen.
That is unambiguous GPU work, identical in kind to the eviction rows in the
VRAM-contention pack (A19 mixed Qwen+Coqui evict, A20 idle Coqui reclaimed under
VRAM pressure, A24 `/health` through a contended eviction, A26 stranded VRAM
pool reclaimed). The audit's `no GPU` field appears to have followed the row's
*frontend* framing ("open a cast view, see a banner") rather than what the
owed step actually exercises on the box.

**Decision: A16 moves from wave-3 agent-runnable to the operator sitting
`onbox-sitting-vram-contention.md`** (its "Qwen auto-loads, analyzer evicted"
observation is the same VRAM-contention family). This is a one-row correction to
the coordinator's proposal, which had 52 operator / 22 wave-3; the corrected
split (as of this decision) was **49 operator + 21 wave-3 + 4 blocked = 74** (the
four blocked rows are broken out as their own set in §2.3, where the proposal
had counted them inside the operator total). A **second** correction, dated
2026-08-20 (wave-3 step 9 of `#2497`, see §2.1/§2.2), moved A33 and A43 from
wave-3 to the operator set, changing this to **51 operator + 19 wave-3 + 4
blocked = 74**. A **third** correction, same day (rework of wave-3's own
recording, `#2497`), moved E7's rendered half the same direction, changing
this to **52 operator + 18 wave-3 + 4 blocked = 74**. A **fourth**
correction, 2026-08-21 (wave 4, `#2551` step 6), retired/discharged/
reclassified A22, A27, A43, B2, old-E6, old-E8 and F1, changing this to
**49 operator + 15 wave-3 + 3 blocked = 67**. A **fifth** correction,
2026-08-22 (merge with `main`, PR #2588), added A45 to the wave-3 set,
changing this to **49 operator + 16 wave-3 + 3 blocked = 68** — see §7 for
the current totals.

> A16 is also one of the three **AMBIGUOUS** rows — its plan frontmatter says
> `status: active` while its body says `Status: stable`. That ambiguity is about
> the plan's *status* (whether the whole plan is open, or only the live-GPU item
> remains), **not about its hardware**, so it does not prevent binning. The pack
> child that writes the VRAM-contention pack marks A16 in its procedure: *"blocked
> on a decision: plan 165 frontmatter says `active`, body says `stable` — run the
> live-GPU step regardless, and flag the frontmatter contradiction for the
> operator."*

---

## 4. Suggested order for the operator's sittings

The ordering rule is **minimise setup churn**: the eGPU is not hot-pluggable, so
the two-card sitting is a natural bookend; the single-card sittings are then
ordered by what shares engine residency and book fixtures.

1. **Two-card boot** (`onbox-sitting-two-card-boot.md`) — open with it. The eGPU
   is plugged in once, the two-card rows run while both cards are present, then
   the eGPU can be removed for the rest. Equally valid as the closing bookend if
   the operator prefers to clear the single-card work first; the only hard rule
   is that the eGPU is seated for this sitting and not for the others.
2. **VRAM contention** (`onbox-sitting-vram-contention.md`) — single card, the
   eviction family. Shares the warmed-Qwen + real-book state that several later
   sittings also want, so run it while Qwen is resident.
3. **Voice design** (`onbox-sitting-voice-design.md`) — same card, Qwen
   VoiceDesign warm-resident; rides the residency the previous sitting
   established.
4. **Cloning & character identity** (`onbox-sitting-cloning-identity.md`) —
   clone-voice derive + cast identity, same card and sidecar.
5. **Multi-language render + ASR** (`onbox-sitting-multilanguage.md`) —
   non-English books, Coqui/XTTS and ASR content-QA; needs the non-English
   fixtures loaded.
6. **QA gate, loudness & re-record** (`onbox-sitting-qa-gate.md`) — the loudness
   measurement + re-record loop; runs after a render exists to measure against.
7. **Device & browser** (`onbox-sitting-device-browser.md`) — phone/Mac/browser
   and the Pinokio/ffmpeg-floor items; mostly off-card, so it can be slotted any
   quiet window, but grouping it keeps the device pairing setup to one pass.
8. **fs-38 Wave 3** (`onbox-sitting-fs38-wave3.md`) — **last**, and alone. It is
   multi-hour and several sittings over the existing run sheet; give it a
   dedicated block rather than crowding it against shorter sittings.
---

## 5. The pack format

Every pack child in this chain produces one file following the shape of
[`sidecar-evict-latency-onbox-acceptance.md`](sidecar-evict-latency-onbox-acceptance.md)
— the model run sheet. It is five parts:

1. **Header** — what this sitting covers: the register rows, the plans of record,
   the linked issues, and the **running time total** for the sitting (the sum of
   the est. minutes in §2.1 for this pack's rows). State the box/card it targets.
2. **Preconditions** — a checkbox list stated **once for the sitting**, not
   repeated per row. Hardware (which card, `CUDA_VISIBLE_DEVICES`, residency),
   engine selection, env flags, which book/voice must exist and be loaded, how
   many shells are needed, what must be warm vs. cold.
3. **Procedure** — numbered and **ordered so shared setup happens once and engine
   swaps happen as few times as possible**. Each step says what to **do** and what
   to **observe**, concretely. Where a run sheet already carries a row's
   criteria, **cite the file and section number** — do not copy the criteria
   list, because a copy drifts from the original. **Concrete observations, not
   "verify it works":** a step whose expected outcome is a judgement ("sounds
   right", "looks correct") must state what the judgement is **against** — the
   comparison, the threshold, or the prior recording.
4. **`Result:` lines — left empty.** The run sheets carry the instruction *"Fill
   in the `Result:` lines AS you run this on the box… Do not pre-fill them."*
   Honour it. Each procedural step that produces an observation gets a blank
   `Result:` line for the operator to fill at run time.
5. **Teardown** — what to stop, unload or restore so the next sitting starts
   clean (evict the warm engine, clear the env flags, unpair the device, close
   the book).

---

## 6. The re-resolution rule

The staleness audit is trustworthy but not proven — its verify pass (#2451)
**sampled** the STILL-OWED rows' citations rather than re-running all 69, and the
one defect it caught proves what that leaves open: row **A2**'s audit Evidence
wrote up a `grep` as returning no matches when the pattern in fact matches at
line 16 — *inside the very header range the row cites as its own evidence*. A
false claim of that shape survives any amount of reading and only a real re-run
surfaces it.

**So: every pack child re-resolves its rows' citations itself.** For each row in
its pack, the child opens the plan of record and reads its `status:` and Ship
notes, runs `gh issue view <N> --repo dudarenok-maker/Castwright --json
state,title,closedAt` and `gh pr view <N> --repo dudarenok-maker/Castwright
--json state,mergedAt` for the row's linked issues/PRs, and **re-runs any command
the audit quotes a result for** and compares. If a row turns out **already
discharged, or self-contradictory**, the child excludes it from the pack and
records it under a `## Excluded on re-resolution` heading with the evidence — it
does not write steps for a sitting that should not happen. The **A2 false-grep
incident** is the reason this rule exists and is named here.

---

## 7. Running totals

- **Operator sittings:** 8 packs (A1's pack is several sittings inside one file).
- **Total estimated operator minutes (runnable packs):** 110 + 155 + 155 + 145 +
  185 + 165 + 140 = **1,055 minutes (~17.6 hours)** (was 1,130 before wave 4 —
  qa-gate's old-A22 (10 min), cloning-identity's old-A43 (~20 min) and A33's
  shrink (~15 min), and device-browser's old-E6 (30 min) all dropped out —
  see §2.1's wave-4 note).
- **Excluded from that total:**
  - **A1** — "multi-hour" (the row's own unchanged estimate; not a single number).
  - **F1** — discharged 2026-08-21 (repo owner, live end-to-end on a real
    device); Group F no longer exists in the register or this plan. The
    blocked pack now carries only the three remaining blocked rows'
    **50 minutes** (H1 + H2 + D3) for when the hardware lands.
- **Wave-3 agent-runnable:** 15 rows (was 18 before wave 4 — A27 discharged
  and old-E8 moved to Blocked and B2 retired 2026-08-21, see §2.1/§2.2; then
  15 → 16 as A45/PR #2588 joined 2026-08-22, but 16 → 15 again when B3 was
  discharged by PR #2585 2026-08-22), no GPU, run off-box by the
  wave-3 pass — not counted in operator minutes.

**Grand reconciliation:** 49 operator + 15 wave-3 + 3 blocked = **67 rows**, the
register's full owed count, each exactly once.