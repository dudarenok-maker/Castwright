---
status: stable
date: 2026-06-21
topic: OSS-gap backlog triage + Must-bucket reframe
source: brand/oss-gap-backlog-2026-06-20.md (OSS gap analysis, git-ignored)
---

# OSS-gap backlog triage + Must-bucket reframe

A triage record, not a feature spec. It captures the decisions that turned the
OSS-gap proposal (`brand/oss-gap-backlog-2026-06-20.md`) into concrete backlog
changes: a **reframed Must bucket**, **8 new issues**, a **consistent sub-group
taxonomy** across Should/Could, and a **priority realignment** with four
Could→Should promotions.

## 1. The reframe: what Must now means

| | Definition |
|---|---|
| **Old** | "Must — blocks v1 ship or hurts existing users" (a beta-stability frame). |
| **New** | "Must — the **beta → full-product spine**: what makes Castwright **marketable and discoverable**." |

The sorting criterion changes from *don't break existing beta users* to *what
moves us from beta to a sellable full product*: the moats made **visible/provable**,
the parity that **wins comparison shoppers**, and the **adoption-friction removers**
that widen the funnel. No current Must item was demoted — every one still
qualifies under the new definition (installers + iOS = adoption funnel; `fs-38` =
deepest moat). The `moscow:must` GitHub label description was updated to match.

Category C (positioning & discoverability) was **already executed** by other
agents as direct repo/README edits, so no C issues were filed. Category D
(explicit cedes) was out of scope this round.

## 2. The 8 new issues filed (2026-06-21)

| ID | # | Bucket | Title |
|---|---|---|---|
| `fe-40` | [#972](https://github.com/dudarenok-maker/Castwright/issues/972) | **Must** | Surface & prove series memory |
| `fs-51` | [#973](https://github.com/dudarenok-maker/Castwright/issues/973) | **Must** | Per-book performance-QA report |
| `fs-50` | [#974](https://github.com/dudarenok-maker/Castwright/issues/974) | **Must** | Language packs ES/FR/DE/ZH/JA |
| `fs-52` | [#975](https://github.com/dudarenok-maker/Castwright/issues/975) | **Must** | Caption/SRT export |
| `fs-53` | [#976](https://github.com/dudarenok-maker/Castwright/issues/976) | **Should** | Automatic text normalisation |
| `srv-46` | [#977](https://github.com/dudarenok-maker/Castwright/issues/977) | **Could** | OCR ingest for scanned PDFs |
| `fs-54` | [#978](https://github.com/dudarenok-maker/Castwright/issues/978) | **Could** | Audiobookshelf export / hand-off |
| `side-18` | [#979](https://github.com/dudarenok-maker/Castwright/issues/979) | **Could** | Nonverbal performance cues (spike first) |

All carry `area:*` + `moscow:*` + `type:feature` + `needs-plan`. Dependency
noted at filing: **`fs-51` depends on `srv-36`** (drift-threshold calibration) for
its drift figures to be defensible.

## 3. Consistent sub-group taxonomy (Should + Could)

"Net-new capabilities" was dissolved — it described *provenance*, not *function*,
and had become a grab-bag. The shared functional taxonomy (a theme appears in a
bucket only if it has items there; Must keeps marketability sub-themes carried by
its intro):

Agents & integrations · Ingest & languages · Voice & cast · Voice & cast sharing ·
TTS engines · Listener experience & playback · Revisions & regen · Reliability &
observability · Security & hardening · Ops & maintenance · Companion app.

Renames: Could "Cast, voice & duplicates" → **Voice & cast** (matches Should);
both maintenance/ops groups → **Ops & maintenance**; Should "UI & accessibility"
dissolved (its lone item `fs-14` is a *language* item → Ingest & languages); new
**TTS engines** group homes `fs-48`/`fs-49`/`side-18`.

## 4. Priority realignment (top = most useful for full-product)

Sorting principle: highest leverage for beta→full-product; act on what's doable
now over what's externally blocked.

### Must
- *Moats, made marketable:* `fe-40` → `fs-51` → `fs-38`
  (the two cheap/fast amplifiers ship the marketing claims **ahead of** the large
  in-flight `fs-38` — user call (a)).
- *Reach & perception:* `fs-50` → `fs-52`
- *Adoption (ship-now first):* `ops-2` → `ops-1` → `ops-15` → `app-12`
  (`ops-2` Docker leads because it's the **only adoption item with no
  licensing/cert dependency** — the cert/Apple-account procurement is the long
  pole that gates the others — user call (b)).

### Should
1. *Ingest & languages:* `fs-41` → `fs-53` → `fs-14`
2. *Agents & integrations:* `fs-44` — **latent moat**: agent-driven generation is
   *not something rivals ship*; prime **Should→Must candidate** next round (user
   call (c): ingest leads, then `fs-44`).
3. *Voice & cast:* `fs-24` → `fe-7` → `fs-35`
4. *Listener experience & playback:* `fs-3`
5. *Reliability & observability:* `srv-36`
6. *Ops & maintenance:* `srv-40` → `srv-4` → `ops-17`
7. *Companion app:* `app-10`

### Could (unchanged ordering, promotions removed)
Listener experience (`fs-17`→`fs-27`→`fe-26`→`fs-10`→`fs-9`→`fe-39`) · Voice &
cast (`fe-12`→`fs-6`→`fe-30`→`srv-7`→`srv-23`→`fe-35`→`fs-36`) · Ingest &
languages (`srv-46`) · TTS engines (`fs-49`→`fs-48`→`side-18`) · Reliability
(`srv-30`→`fs-45`→`side-17`) · Revisions & regen (`fs-5`) · Agents & integrations
(`fs-54`) · Voice & cast sharing (`side-13`→`fs-28`→`fs-29`/`fs-30`→`fs-31`) ·
Security & hardening (`side-12`→`srv-41`) · Ops & maintenance
(`fs-42`→`fe-1`→`ops-18`→`ops-14`).

## 5. Could → Should promotions (4)

| Item | Why |
|---|---|
| `fs-41` auto-detect language | Completes the multi-language "second half"; pairs with the Must language packs. |
| `fs-24` pronunciation lexicon | Fixes the **#1 fiction narration-quality complaint**; quality is marketability (re-promoted after a 2026-06-08 demotion). |
| `fs-3` streaming "listen as it generates" | The **magic-moment demo feature** audiobook tools sell on. |
| `srv-36` drift-threshold calibration | **Credibility dependency for the Must `fs-51` QA report** — placeholder thresholds make a "0 drift" claim hollow. |

`fs-17` read-along was considered but **stays Could** — differentiating but Large
and unplanned; top re-promotion candidate once it has a plan. `fs-48`/`fs-49`
stay Could (spike-gated; spikes have not passed).

## 6. Observed (not fixed this round)

`srv-44` is used as an ID by **two** open issues (#960 and #941) — a
duplicate-ID glitch against the "IDs never reused" rule. Flagged for a separate
cleanup pass; out of scope here.
