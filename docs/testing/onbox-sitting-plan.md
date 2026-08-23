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

### 2.1 Operator sittings (48 rows, 8 packs)

These need the operator's GPU box — a live card, real engine residency, a real
TTS sidecar, a real analyzer, or a real phone/browser on the LAN. Each is one
sitting; A1 is several sittings inside one pack.

| Pack file | Rows (each pack file's own current heading labels) | Est. min |
|---|---|---|
| [`onbox-sitting-two-card-boot.md`](onbox-sitting-two-card-boot.md) | A2, A3, A8, A18 | 110 |
| `onbox-sitting-vram-contention.md` | A5, A16, A19, A20, A24, A26, A31, A32, A33 | 155 |
| `onbox-sitting-voice-design.md` | A4, A6, A7, A14, A15, A17, A27 | 155 |
| `onbox-sitting-qa-gate.md` | A9, A10, A11, A12, A13, A21, A22, A34 | 145 |
| `onbox-sitting-cloning-identity.md` | A23, A25, A28, A29, A30, A40, A41, A42, A43 | 185 |
| `onbox-sitting-multilanguage.md` | D1, D2, A35, E4 | 165 |
| `onbox-sitting-device-browser.md` | E1, E2, E3, E6, E7, E8 | 135 |
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

> **Correction, 2026-08-23 (`check:register-citations` mechanical sweep).**
> `main`'s A38 discharge (register row A38, "ORT marker refuses — not
> repairs — a clobbered venv") renumbered A39→A38 through A44→A43,
> contradicting this table again: it read `A32, A33, A34` for
> `onbox-sitting-vram-contention.md` (that pack's own heading is `A31`, not
> `A34` — a **pre-existing** mismatch this sweep also caught, unrelated to
> the A38 discharge), `A30` for `onbox-sitting-voice-design.md` (that pack's
> own heading is `A27`, same pre-existing shape), `A35` for
> `onbox-sitting-qa-gate.md` (own heading `A34`, same shape), and `A36` for
> `onbox-sitting-multilanguage.md` (own heading `A35`, same shape). The table
> above is now reconciled to each pack file's own CURRENT heading labels
> again. **Not fixed here, and flagged separately:** those same current pack
> labels (`onbox-sitting-cloning-identity.md`'s `A40`–`A43`, in particular)
> are themselves off by one against today's register — e.g. its `A43`
> heading carries the `#1969` audition-centroid content, which the register
> now files under `A42` (`A43` is `#2246`'s voice-design language gate). That
> pack's own internal renumbering — several correction notes deep, spanning
> at least two distinct historical `A43` discharges — is a bigger, riskier
> edit than this table fix and is out of scope for this sweep; it needs its
> own pass rather than a blind shift.

<!-- The seven rows above are plain code spans, not links, until their pack
files exist — review of PR #2470 (attempting to fix this a different way)
found that this repo's docs/testing link-scan guard (test:hooks) walks the
WHOLE tree on every commit, so a real .md link to a not-yet-written sibling
fails every intermediate commit in this chain, not just the one that would
add the dangling link. #2454's final commit (once all eight packs exist)
flips these back to real links. See #2463 for the incident this avoids. -->

**Row count:** 4 + 9 + 7 + 8 + 9 + 4 + 6 + 1 = **48** (was 49 before this
wave's re-bin — see the 2026-08-23 correction below moving E5 to wave-3
agent-runnable).

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
> match; the rest of this plan (§1, §4, §5, §6) is otherwise unaffected. **Addendum, 2026-08-22:** §3's A16 narrative received a fifth-correction note documenting how PR #2588 and PR #2585 offset each other.
>
> **Correction, 2026-08-22 (folding in `main`'s PR #2588 and PR #2585).**
> Two independent changes on `main`, both now folded in here. PR #2588 added
> a new wave-3 agent-runnable row for the `speaker-qa.txt` reqHash fix's
> one-time real-venv reinstall — sidecar-venv-only, no GPU requirement. It
> landed on `main` as A48 (old numbering); folded into this wave's
> contiguous renumbering it is **A45**. Wave-3 set +1. Separately, PR #2585
> discharged and removed the Cast/analysis `characterId` drift row (this
> plan's old B3, `#2040`) after `#2536`'s fix landed — wave-3 set −1. Net:
> wave-3 set stays **15**, total stays **67** — the two changes offset.
>
> **Correction, 2026-08-23 (wave 5 step 5, `#2611`) — the device-browser
> pack's rows re-derived one at a time; six confirmed operator-only, one
> (E5) moves out.** The pack was binned wholesale as an operator sitting
> because its rows are "browser-shaped." Agents in this campaign have
> browser automation, so that reasoning was checked against each row's own
> `Needs:`/criteria line rather than accepted on the pack's framing. The
> line applied: **listening, physical hardware, or a live GPU** is
> operator-only; "needs a click-through" is not, by itself.
>
> - **E1** stays operator-only: its own text needs *"a clean macOS machine
>   with Pinokio, plus a short Windows follow-up"* — a specific separate
>   physical macOS machine (zero prior on-box exercise) plus native-Stop
>   process reaping on the Windows box, neither reachable from a browser.
> - **E2** stays operator-only: its own text needs *"a real phone [that]
>   installs the mkcert root CA and completes pairing"* — physical
>   hardware.
> - **E3** stays operator-only: it runs *"same session as E2 — shares the
>   phone + host setup"*, so it inherits E2's real-phone requirement.
> - **E6** stays operator-only, **unchanged from the existing 2026-08-20
>   correction above, which this note does not undo**: wave-3 step 7 found
>   its rendered-half observations (1, 2, 4, 5, 6) need a real browser
>   *watching a real card render* over a genuine multi-minute bootstrap —
>   live process-timing observation, not a DOM click-through — "same
>   boundary as A33/A43." Observation 6 (the failure path) is this row's
>   one remaining debt and is still owed to the operator for the same
>   reason.
> - **E7** stays operator-only: its own text needs *"a machine with Pinokio
>   installed, an existing pre-fix install, nvidia profile"* — a specific
>   physical machine in a specific pre-fix state, with the card set to the
>   nvidia profile to install Qwen3 — physical hardware and a live GPU.
> - **E8** stays operator-only: its own text needs *"a phone or second
>   machine paired over `castwright.local`"* and shares E2/E3's phone
>   session — physical hardware.
> - **E5 moves to wave-3 agent-runnable (§2.2).** Its own text: *"a
>   one-time DevTools touch-emulation check... minutes, any machine"* — no
>   real phone, no physical hardware axis, no GPU, no listening. The four
>   controls are driven via Chrome DevTools' device-toolbar touch emulation
>   (the same `Input.dispatchTouchEvent`/`.tap()` path wave-4 step 5d
>   already used to discharge the "Review ›" chip), which this campaign's
>   browser automation can drive directly. "Needs a click-through" is not,
>   by itself, operator-only — this is that case in both directions: three
>   of the four controls stay owed for an unrelated reason (0 books in this
>   worktree's workspace), but the row's *hardware axis* was never real to
>   begin with.
>
> **Effect on this plan's sets:** `onbox-sitting-device-browser.md` drops
> from 7 rows/140 min to **6 rows/135 min** (E1, E2, E3, E6, E7, E8);
> operator set 49 → **48**. E5 joins §2.2's wave-3 agent-runnable set,
> discussed there. **This is a re-binning, not a discharge — E5's own owed
> debt (three controls, per the register's own wave-4 correction) is
> unchanged; only which pass runs it moves.**

### 2.2 Wave-3 agent-runnable (16 rows: 14 runnable now + 2 opportunistic)

These need no GPU and no operator box. They are excluded from every pack above
and are run, on a machine of the agent's choosing, by the wave-3 pass — not by a
pack child in this chain. Two of the sixteen (G1, G2) cannot be run **on
demand** — see the opportunistic subsection below — but they are still part
of this set, not the operator set or the blocked set: neither needs the
operator's GPU box, hardware, or acquisition, only a real external event.

**Runnable now (14 rows):** A29, A39, A40, A41, A42, A45, B1, B4, C1, C2, C3,
C4, E11, **E5**. (Named by the number each row carried when last binned
here — A27 and E8, old numbering, are removed entirely, discharged/moved to
Blocked this wave; see the 2026-08-21 correction above. The register's own
current numbering renames several of these — e.g. old A29 is now A27 — see
the register's own correction note for the full renumbering. A45 — old
numbering A48, PR #2588 — added by the 2026-08-22 correction above. B3
(characterId drift, #2040) was discharged by PR #2585 and is removed
entirely. **E5** — the device-browser pack's DevTools touch smoke-check —
joins this wave, 2026-08-23, moved from the operator set; see the
correction note at the end of §2.1.)

**Opportunistic (2 rows) — not runnable on demand, cannot be manufactured:**

- **G1** — *"Needs: a real quarantined flaky test (naturally occurring, not
  manufactured) — the shared precondition left for both remaining halves.
  Cost: opportunistic — piggy-back on the next real quarantine event rather
  than manufacturing one."* (register §G1). Wave 3 recorded this row STILL
  OWED on both its debts, unresolved by the first live dispatch — an agent
  cannot summon a real flaky test into existence to close it.
- **G2** — *"Needs: nothing beyond a real `vX.Y.Z` tag push — i.e. the next
  release cut."* (register §G2). Wave 3 recorded this STILL OWED, no
  opportunity yet — an agent must not manufacture a release tag, and wave 3
  explicitly declined to.

Both rows were previously counted inside "wave-3 agent-runnable" without
distinguishing that neither can actually be executed by an agent picking up
that pass today — the pass would find nothing to run and the row would look
neglected rather than correctly blocked-pending-an-event. Moving them to a
clearly-labelled opportunistic subset does not discharge them and does not
remove them from the register's owed count: they stay OWED, exactly as wave
3 and wave 4 left them, and they stay inside the wave-3 set's row count
(neither is operator-GPU-bound or acquisition-blocked, the definitions of
the other two sets) — only the "runnable today" framing changes.

> **Correction, 2026-08-23 (wave 5 step 5, `#2611`).** G1 and G2 were listed
> among this set's 15 "wave-3 agent-runnable" rows even though the
> register's own text for both already says neither can be discharged on
> demand (G1: needs a real quarantined flaky test; G2: needs a real release
> tag push). Re-binned here into the opportunistic subsection above with
> their own rows quoted as evidence. **This is a re-binning, not a
> discharge — both rows stay OWED, and the wave-3 set's total row count is
> unchanged by this move** (E5 joining separately, per §2.1's correction,
> is what took the set from 15 to 16).


**Row count:** 6 (group A: A29, A39, A40, A41, A42, A45 — A27 discharged,
removed) + 2 (B: B1, B4 — B2, B3 retired/discharged, removed) + 4 (C) + 1 (E11 — E8
moved to Blocked, removed) + 1 (E5, joined 2026-08-23 from the operator set) +
2 (G, opportunistic — G1, G2) = **16** (was 15 before this wave's two moves,
16 before B3's discharge, 18 before wave 4's three removals).

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

**48** (operator) + **16** (wave-3) + 3 (blocked) = **67**. Every register row
appears exactly once. (Before wave 4 (the 2026-08-21 correction above), this
read 52 + 18 + 4 = 74 — wave 4's retirements/discharges/reclassifications
account for the full delta: −3 operator, −3 wave-3, −1 blocked, net −7,
74 → 67. PR #2588 then added A45 · `speaker-qa.txt` reqHash fix, which is
sidecar-venv-only with no GPU requirement, joining the wave-3 agent-runnable
set: 49 + 15 + 3 → 49 + 16 + 3, **67 → 68**. However, PR #2585 discharged
B3 (characterId drift, #2040), which reduced wave-3 from 16 back to **15**,
restoring the total to **67**. The merge that brought both PRs in did not
fully account for this, creating a temporary 68-row miscounting now corrected.
**Correction, 2026-08-23 (wave 5 step 5, `#2611`).** The device-browser
pack's rows were re-derived one at a time: E5 (DevTools touch smoke-check)
has no real-hardware axis and moves from operator to wave-3 agent-runnable —
operator 49 → **48**, wave-3 15 → 16. Separately, G1 and G2 were re-binned
from wave-3's plain "agent-runnable" framing into a labelled opportunistic
subsection of the same set — no row count change from that move alone. Net:
49 + 15 + 3 → 48 + 16 + 3, **still 67** — a re-binning, not a discharge; no
row's OWED/DISCHARGED status changed.)
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
2026-08-22 (folding in `main`'s PR #2588 and PR #2585), added A45 to the wave-3 set
while discharging B3 (characterId drift, #2040) — wave-3 set +1 and −1
offsetting — keeping the total at **49 operator + 15 wave-3 + 3 blocked = 67** — see §7 for
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
  185 + 165 + 135 = **1,050 minutes (~17.5 hours)** (was 1,055 before this
  wave — device-browser's E5 (5 min) moved to wave-3 agent-runnable,
  2026-08-23, see §2.1's correction; was 1,130 before wave 4 — qa-gate's
  old-A22 (10 min), cloning-identity's old-A43 (~20 min) and A33's shrink
  (~15 min), and device-browser's old-E6 (30 min) all dropped out — see
  §2.1's wave-4 note).
- **Excluded from that total:**
  - **A1** — "multi-hour" (the row's own unchanged estimate; not a single number).
  - **F1** — discharged 2026-08-21 (repo owner, live end-to-end on a real
    device); Group F no longer exists in the register or this plan. The
    blocked pack now carries only the three remaining blocked rows'
    **50 minutes** (H1 + H2 + D3) for when the hardware lands.
- **Wave-3 agent-runnable:** 16 rows — 14 runnable now + 2 opportunistic
  (was 15 before this wave — E5 joined from the operator set and G1/G2 were
  re-labelled opportunistic within this same set, 2026-08-23, see §2.2; was
  18 before wave 4 — A27 discharged and old-E8 moved to Blocked and B2
  retired 2026-08-21, see §2.1/§2.2; then 15 → 16 as A45/PR #2588 joined
  2026-08-22, but 16 → 15 again when B3 was discharged by PR #2585
  2026-08-22), no GPU, run off-box by the wave-3 pass — not counted in
  operator minutes.

**Grand reconciliation:** 48 operator + 16 wave-3 + 3 blocked = **67 rows**, the
register's full owed count, each exactly once.