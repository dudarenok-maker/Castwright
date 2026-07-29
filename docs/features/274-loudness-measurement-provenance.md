---
status: active
shipped: null
owner: null
---

# Real loudness measurement as a first-class value (#1922 + #1923)

status: **approved** (rev 3 — all four decisions locked by the repo owner, 2026-07-29)
Design pass only. No production code was written. Issues: #1922 (srv-67, bug), #1923 (fe-58, bug).
Out of scope, must not be foreclosed: #1909.

**Locked decisions** (§3, do not re-open): **(1)** grandfather legacy sidecars — option A′.
**(2)** do NOT measure when loudnorm is disabled. **(3)** do NOT retune `QA_CLIP_TP_DB`
in this PR. **(4)** per-record trust, not per-field.

**Rev 2 changelog.** Review returned *rework*. Changed: the centrepiece test was a
placebo and is rebuilt (T8); the true-peak overshoot is now **measured at five
ceilings** rather than assumed from one data point (§1.8); the fail-soft table was
contradicted and is rebuilt around **three** shapes of `loudnormStats` (§1.9, §2.2);
the UI fixture-corpus cost was under-budgeted by ~35 edits (T6); `relufs-existing.mjs`
was missed (T5); three comments that go stale *because of* the hoist were missed
(T7); Decision 1 is reframed around the confirmed regression; a fourth decision
(per-field vs per-record trust) is escalated. Confirmed sound in review and **not**
re-litigated: §1.4, §1.5, §1.6, §1.7, hoist safety, #1909 not foreclosed.

---

## 0. TL;DR of the design

There is exactly **one** real `ebur128` measurement per chapter
(`measureLoudnessFile`, added by #1880). Today it runs *after* the atomic rename,
*after* QA has judged, and *after* `segments.json` is written — so its value reaches
only the `.lufs.json` sidecar. Everything else still reads loudnorm's self-reports.

**Move that one measurement to immediately after the encoded bytes hit the temp
file, and let three consumers read the same result:** the QA verdict, the
`.lufs.json` sidecar (written once instead of twice), and a new
`measurementSource: 'ebur128' | 'loudnorm'` provenance field.

That single move resolves #1922 and supplies exactly the signal #1923 needs, which
is why they are one design.

**Read §0.1 and §1.8 first.** The measured true-peak behaviour constrains what the
centrepiece test can assert and materially changes what #1922's fix delivers.

---

## 0.1 BOTH OF THESE ARE TRUE AFTER THIS CHANGE — read before writing the PR

> 1. **The chapter QA true-peak check now consumes a real `ebur128` measurement of
>    the encoded file**, instead of the fabricated ceiling loudnorm was asked for.
> 2. **The chapter QA true-peak check still cannot fire under shipped defaults.**

Both. Simultaneously. Neither cancels the other.

**Why #2 survives the fix.** It was never a data-plumbing problem — it is arithmetic
between two independent knobs. Dynamic loudnorm pins the encoded peak at roughly
ceiling +0.1…+0.3 dB (§1.8, measured at five ceilings). The default ceiling
(`audio.loudnorm.truePeak = -1.5`) therefore yields a real peak near `-1.2`, while the
default trigger (`QA_CLIP_TP_DB = -0.1`) sits 1.1 dB above it. Feeding the check a
*true* number does not close a gap that exists between the ceiling and the threshold.

**Why we are shipping it anyway.** Three defects close here regardless of whether the
check ever fires:

- QA and the Listen badge stop describing the same chapter two different ways (§1.2).
- A correctly-normalised chapter can no longer render as a red "off target" pill
  (§1.10 — the most user-legible bug in this plan).
- `output_tp` is proven unusable as a peak figure in **both** loudnorm modes (§1.3),
  so nothing downstream should ever trust it again.

**The remaining inertness is a threshold/ceiling question, and it is owned by
[#1909](https://github.com/dudarenok-maker/Castwright/issues/1909)** — not by this PR.
Per Decision 3, retuning now would calibrate against a `-16 LUFS` / `-1.5 dBTP` config
that #1909 may itself change; tuning twice is worse than tuning once, later.

### Hard writing requirement (not optional, and not satisfied by a passing test suite)

#1922 is titled *"chapter QA true-peak check can never fire under the default loudnorm
config."* **A reader who sees that issue auto-closed will reasonably conclude the check
now fires. It does not.** Shipping without saying so is shipping a misleading fix.

The both-true statement above MUST appear, in substance, in all four places:

| surface | requirement | task |
|---|---|---|
| this plan's summary | §0.1 (here) | — |
| acceptance criteria | §8 AC-6 | T10 |
| **the PR body** | its own short section, not a parenthetical | T10 |
| **the release note** (both files) | user-facing line must not imply detection improved | T10 |

And a comment on **#1909** recording the coupling + the §1.8 table, so whoever picks it
up inherits the evidence rather than re-measuring it (T10).

---

## 1. Premise verification

Method: read from the working tree at `C:\Claude\Projects\Audiobook-Generator`, plus
the committed golden baselines, plus one new measurement run (§1.8) executed
**through the production call path** — `encodePcmToAudio` with
`resolveLoudnormOptions()`-shaped options and the real `measureLoudnessFile`. No
hand-rolled ffmpeg invocation produced any number in this document.

### 1.1 SURVIVED — the clip check is inert

- `audio-qa.ts:52` — `clipTpDb: -0.1`; check at `:101` (`input.truePeakDb >= t.clipTpDb`).
- `finalize-chapter-write.ts:151` — `truePeakDb: measured ? measured.tp : null`,
  where `measured` is `loudnormStats`.
- `loudnorm.ts:383-388` / `registry.ts:934-940` — requested ceiling default `-1.5`.

`-1.5 >= -0.1` is false. Confirmed by direct measurement in §1.8: at the default
ceiling loudnorm reports `output_tp = -1.5` **verbatim**.

### 1.2 SURVIVED — the two surfaces disagree on the same chapter

`golden-chapter.baseline.json`: requested `-1.5`, measured `tp: -1.2`. Reproduced
independently in §1.8. Today the badge renders `-1.2` while QA judges `-1.5`.

### 1.3 RESOLVED — linear mode is also bounded, and is a *worse* predictor

#1922 flagged this as unverified. **Resolved, and now measured.**

- **Dynamic:** `output_tp` echoes the requested ceiling verbatim — measured at all
  five ceilings in §1.8, `output_tp == requested` exactly, every time.
- **Linear:** `output_tp` is a genuine prediction (`input_tp + gain`), not the
  ceiling restated, and it is `<= TP` by construction because breaching `TP` is
  precisely what triggers ffmpeg's dynamic fallback.

**New, and stronger than the earlier inference:** §1.8's 4.0x rows put linear mode
under direct measurement. Requested `-1.5`, loudnorm predicted `output_tp = -5.85`,
audio actually measured `-1.7` — the prediction **under-reports the real peak by
4.15 dB**. So linear's `output_tp` is not merely "the ceiling restated"; it is a
badly calibrated prediction. Either way it stays below the requested ceiling, so the
clip check is inert in **both** modes and the fix needs no mode-conditional branch.
`output_tp` is unusable for QA under every mode — which is the whole point of T2.

> **STANDALONE FINDING L — loudnorm's `output_tp` under-reports the real peak by
> 4.15 dB in linear mode.** Measured: requested `-1.5`, `output_tp` reported `-5.85`,
> `ebur128` measured `-1.7`.
>
> Recorded separately because its significance is **independent of whether the clip
> check ever fires**. `output_tp` is the field a reader would naturally reach for when
> asking "how hot did this chapter get?", and in linear mode it is wrong by more than
> 4 dB — not conservative-by-a-hair, but wrong enough to invert a judgement. In dynamic
> mode it is not a measurement at all (it echoes the request verbatim). **Nothing
> downstream should consume `output_tp` as a peak figure, for any purpose.** This is
> the strongest argument for consuming a real measurement even in a world where the
> threshold is never crossed, and it is worth knowing before anyone trusts that field
> for #1909's A/B, for telemetry, or for a future export gate.

### 1.4 DID NOT SURVIVE — "QA gates whether the rename is even reached"

*(Confirmed sound in review; retained as the record.)* This premise is **false**, and
it is the sole justification #1880/#1926 gave for deferring the fix.

- `evaluateChapterQa` has **one** production call site:
  `finalize-chapter-write.ts:32,147`. Nothing else in `server/src` calls it.
- `routes/generation.ts` has **already converged** onto `finalizeChapterAudioWrite`
  (`:1849-1862`); it no longer inlines its own tail. The stale claim that it does
  lives at `finalize-chapter-write.ts:10-12` and is the likely origin of the premise.
- Between `:147` and `await rename(tmpAudio, audioPath)` (`:215`) there is **no
  branch, throw, or early return** on the verdict. The only conditional in the span
  is `if (input.embeddings)` (`:211`). The verdict is only *stored* — `:201`
  (`segmentsFile.qa`) and `:265` (`state.json.audioQa`).
- **No consumer branches on it:** `generation.ts:1877-1883` only `console.warn`s and
  forwards it on the SSE tick; `chapter-splice.ts:384` and `chapter-qa-repair.ts:599`
  do not even destructure it.
- The gate that *does* drive re-records is a different function — `evaluateSegmentPcm`
  (`server/src/tts/segment-qa.ts`): per-sentence, raw PCM, pre-assembly, no
  `truePeakDb` parameter, no loudnorm dependency. Conflating the two is the most
  plausible source of the error.

**The real constraint is narrower:** `segments.json` embeds the verdict and is
written pre-rename (`:210`), while the measurement runs post-rename (`:230`). That is
data flow, not control flow — and §2.1 dissolves it without moving any write.

### 1.5 DID NOT SURVIVE — #1923-as-filed is unreachable

*(Confirmed sound in review.)* Single-pass output **cannot ship**.
`resolveLoudnormOptions()` hardcodes `twoPass: true` — *"it is not a user-facing
knob"* (`loudnorm.ts:393-400`), re-confirmed at runtime in §1.8
(`{"target":-16,"lra":11,"tp":-1.5,"twoPass":true}`).

- No registry knob exists (`registry.ts` has only
  `audio.loudnorm.{enabled,targetLufs,lra,truePeak}`); `git log -S
  "AUDIO_LOUDNORM_TWO_PASS" --all` is empty. It never was one.
- `finalize-chapter-write.ts:124` is the **only** `encodePcmToAudio` call passing a
  `loudnorm` option at all. The other four (`setup-readiness.ts:192`,
  `voice-library.ts:673`, `voice-sample.ts:274`, `design-voice-core.ts:240`) pass none
  and emit no sidecar.
- `scripts/relufs-existing.mjs:229-237` deliberately writes `twoPass: true`.

So every `.lufs.json` on disk has `twoPass: true`, the gate always passes, and the
figures already display. **#1923's stated harm cannot occur.** It should be closed as
not-reproducible — but only after §1.10 is re-filed, because that is the live bug
hiding underneath it.

### 1.6 DID NOT SURVIVE — the openapi sentence is already fixed

`openapi.yaml:5595-5603` already says `twoPass` *"Does NOT gate whether i/lra/tp are
real measurements"*. Corrected by #1926. **No openapi correction is owed** — only the
additive provenance property (T4). Stale prose does survive elsewhere (T7).

### 1.7 DID NOT SURVIVE — expect ZERO golden re-blessings

*(Confirmed sound in review.)* `writeBaseline` records only `i/lra/tp/normalizationType`
plus audio-derived figures; this design leaves the filter string, target, ceiling,
mode, and encoder untouched, so audio is byte-identical and all four recorded fields
are unchanged. The new sidecar property is additive and neither `writeBaseline` nor
the L2 comparison reads it.

**Inverted into a safety property — the most valuable check in this plan: if the
golden assembly suite goes red, that is evidence of an unintended audio change and
must be investigated, never blessed away.** See T9.

### 1.8 NEW MEASUREMENT — the true-peak overshoot, at five ceilings

Review correctly flagged that the design rested on **one** data point (`-1.5` →
`-1.2`). Measured through the production call path (`encodePcmToAudio` +
`measureLoudnessFile`, golden fixture, 24 kHz, mp3 q2):

| source | requested tp | loudnorm `output_tp` | mode | **measured tp** | measured i | overshoot | fires at `-0.1`? |
|---|---|---|---|---|---|---|---|
| 1.0x | -1.5 | -1.5 | dynamic | **-1.2** | -16.2 | +0.3 | no |
| 1.0x | -1.0 | -1.0 | dynamic | **-0.7** | -16.2 | +0.3 | no |
| 1.0x | -0.5 | -0.5 | dynamic | **-0.4** | -16.1 | +0.1 | no |
| 1.0x | -0.3 | -0.3 | dynamic | **-0.2** | -16.1 | +0.1 | no |
| 1.0x | -0.05 | -0.05 | dynamic | **+0.1** | -16.0 | +0.15 | YES |
| 4.0x | -1.5 | **-5.85** | linear | **-1.7** | -15.4 | +4.15 | no |
| 4.0x | (-1.0 … -0.05) | -5.85 | linear | -1.7 | -15.4 | +4.15 | no |

**Four conclusions, each load-bearing:**

1. **The overshoot is real but small, and shrinks as the ceiling tightens**
   (+0.3 → +0.3 → +0.1 → +0.1). It does not scale up.
2. **There is NO ceiling at which `requested < -0.1 <= measured`.** The window the
   original T7 assumed does not exist. Review's suggested `-0.5` gives measured
   `-0.4`, still below `-0.1`. The only firing row is requested `-0.05`, where
   `-0.05 >= -0.1` is already true pre-fix — **exactly the placebo.** T8 is rebuilt
   on a different axis as a result.
3. **A hotter source does not produce a hotter output.** At 4.0x, loudnorm must
   *attenuate* to reach `-16 LUFS`, flips to linear, and the peak lands *lower*
   (`-1.7`). Amplifying the fixture can never manufacture clipping — worth ruling out
   explicitly so nobody retries it.
4. **After the fix, the clip check remains inert under default config, for structural
   reasons.** Dynamic loudnorm pins the peak just above the requested ceiling; the
   default ceiling (`-1.5`) sits 1.4 dB below the default threshold (`-0.1`). #1922's
   fix makes QA **truthful and consistent with the badge**; it does **not** make it
   fire. Making it *active* requires Decision 3. State this plainly in the PR body —
   otherwise the silence reads as a broken fix.

Reproduction harness kept alongside this plan at `measure-tp-overshoot.mts` (run with
the server's `tsx`, cwd = `server/`). ffmpeg/CPU only; no GPU, no model.

### 1.9 NEW — `loudnormStats` has THREE shapes, not one

Review contradicted rev 1's claim that `loudnormStats.i` is always a genuine
post-normalisation measurement. **Confirmed wrong.** The reachable shapes:

| shape | when | `i` / `lra` / `tp` | `twoPass` | `normalizationType` |
|---|---|---|---|---|
| **A — second pass parsed** (`mp3.ts:441-455`) | happy path | `output_i`/`output_lra`/`output_tp`. `i` genuinely post-filter; **`tp` is the requested ceiling** | `true` | set |
| **B — second-pass JSON missing, unparseable, or non-finite** (`mp3.ts:436-476`; provisional at `:302-308` survives) | ffmpeg log-shape drift, parse failure | `input_i`/`input_lra`/`input_tp` — **PRE-FILTER**. On the fixture `i = -21.7` against a `-16` target: 5.7 LU off | `true` | **undefined** |
| **C — single pass** (`mp3.ts:318-331`) | unreachable in production (§1.5) | pure nominal | `false` | undefined |
| *(null)* — first-pass measurement unusable (`mp3.ts:311-316`) | dead-silent input | callback never fires; `loudnormStats` stays `null` | — | — |

**Shape B is what breaks rev 1's fail-soft table.** Feeding its `i` to QA means
judging *pre-normalisation* loudness against `nearSilentLufs: -40` — a book whose raw
input sits at `-45 LUFS` would be flagged near-silent even though the normalised
output is a fine `-16`. A spurious-suspect bug rev 1 would have introduced.

**Shape B is detectable.** `normalizationType === undefined && twoPass === true`
uniquely identifies it — the same discriminator `golden-assembly.golden.test.ts:499-506`
already relies on (*"`twoPass === true` does NOT imply a mode is present … the
fallback branches leave it untouched"*). §2.2 uses this.

### 1.10 NEW FINDING (widened) — the fallback renders fabricated numbers as measured

**The most important thing in this document, and neither issue names it.**

> **This is a CURRENT, USER-VISIBLE BUG that this change fixes — not an internal
> data-shape note.** Concretely, today: a chapter that normalised perfectly to
> `-16 LUFS` can display a **red "off target" pill** in the loudness report card,
> because the sidecar is holding the chapter's *pre-normalisation* input loudness
> (`-21.7 LUFS` on the golden fixture) and `classifyDrift` is dutifully comparing that
> to the `-16` target and finding it 5.7 LU adrift. The audio is fine. The badge says
> it is not. **This is the most user-legible thing in the whole plan** and should lead
> the release note, ahead of anything about true peak.

`measureLoudnessFile` fails soft (`finalize-chapter-write.ts:236-246`): on failure the
sidecar keeps loudnorm's figures, still stamped `twoPass: true`, and the UI renders
them as real. Review's finding 3 widens this — the fallback is not one shape but two:

- **Fallback onto Shape A** → the badge displays the *requested ceiling* (`-1.5`) as a
  measured true peak. Structurally a wish, not a reading.
- **Fallback onto Shape B** → the badge displays **pre-filter input loudness**
  (`-21.7 LUFS` on the fixture) as the chapter's measured integrated loudness, and
  `classifyDrift` buckets it against a `-16` target as **5.7 LU "off target"**. The
  report card shows a red "off target" pill for a chapter that is in fact on target.
  A user-visible false alarm.

Both are reachable today with `twoPass: true`, and **nothing on the wire can
distinguish them from a real measurement.** This — not single-pass frequency — is the
justification for the provenance field, and it is what must be re-filed if the user
picks Decision 1 = (B).

---

## 2. The design

### 2.1 Hoist the single measurement to just after the temp write

In `finalizeChapterAudioWrite`, move `measureLoudnessFile` from `:230` to immediately
after `await writeFile(tmpAudio, audioBuffer)` (`:205`), against `tmpAudio`, and feed
one result to three consumers: QA, the sidecar, the provenance flag. **Nothing else
moves.**

**Why this dissolves §1.4's constraint.** The measurement never needed the file at its
*final path* — it needs the encoded bytes on disk. The rename is a same-directory move
that preserves bytes exactly, so measuring `tmpAudio` and measuring `audioPath` are the
same measurement of the same artifact. Hoisting puts the value in scope before the
verdict is computed and before `segments.json` is written, so no write reorders and
crash-tear semantics are untouched.

**Hoist safety** *(confirmed in review)*: the new call site sits **before**
`preserveExistingAsPrevious` (`:209`), so the destructive window is unchanged and a
measurement failure leaves the previous take intact. No lost-chapter risk.

Also strictly cheaper: the sidecar is written twice today (once from loudnorm in
`onLoudnessMeasured`, once rewritten post-rename). This collapses to one ffmpeg spawn
and one sidecar write.

### 2.2 Fail-soft policy — rebuilt around §1.9's three shapes

`realLoudness` = the `ebur128` result (`MeasuredLoudness | null`).

**When `realLoudness` is non-null (the overwhelmingly common case): use it for both
`i` and `tp`, unconditionally.** Shape does not matter. This is the only branch that
runs in practice.

**When `realLoudness` is null**, the fallback is per-field *and* per-shape:

| shape | QA `lufs` | QA `truePeakDb` | sidecar `i`/`lra`/`tp` | `measurementSource` |
|---|---|---|---|---|
| **A** (`normalizationType` set) | `loudnormStats.i` — genuinely post-filter | **`null`** — `output_tp` is the requested ceiling (§1.3) | keep Shape A values | `'loudnorm'` |
| **B** (`normalizationType` undefined, `twoPass: true`) | **`null`** — pre-filter; risks a spurious `nearSilent` trip (§1.9) | **`null`** | keep Shape B values | `'loudnorm'` |
| **C** (`twoPass: false`) | **`null`** — nominal | **`null`** | keep Shape C values | `'loudnorm'` |
| *null stats* | `null` | `null` | no sidecar written | — |

Two principles, so a cold implementer can extend the table:

1. **QA must never *judge* on a number that is not a measurement of the output.**
   Absent beats silently wrong — `audio-qa.ts` already skips any check whose input is
   `null`.
2. **The sidecar may still *display* a fallback number, provided it is labelled.**
   Blanking the badge on every failure loses information; labelling is what stops it
   lying.

Discriminator, per §1.9: `stats.normalizationType !== undefined` ⟹ Shape A.

### 2.3 The provenance field

Add to `LoudnormSidecarJson` (`loudnorm.ts:74-99`) and `ChapterLoudness`
(`openapi.yaml:5604`, beside `normalizationType`):

```
measurementSource?: 'ebur128' | 'loudnorm'
```

Enum, not boolean: it names both states, matches the neighbouring `normalizationType`
precedent, and leaves room for a third producer without a schema break. **Optional** —
absence means a pre-change sidecar, read as untrusted. Safe direction, no migration.

### 2.4 Scope fences

- **No change to loudnorm's mode, target, ceiling, or filter string.** #1909 stays
  fully open (§5).
- **No measurement when loudnorm is disabled.** The `if (loudnormStats)` guard stays;
  see Decision 2.
- **The clip check does not become active under defaults** (§1.8 conclusion 4).

---

## 3. Decisions — ALL FOUR LOCKED by the repo owner (2026-07-29)

Recorded with the evidence that produced them. **Do not re-open during
implementation.** If an implementer believes a decision is wrong, stop and escalate —
do not quietly implement the alternative.

### 3.1 DECISION 1 — #1923: provenance field + UI swap, or not?

Review: the abstract Option 1/2 framing buried the thing actually being decided.

**What you are really deciding: accept a confirmed, user-visible regression in
exchange for closing a confirmed, user-visible lie.**

- **The regression (certain, not a risk):** every `.lufs.json` written before this
  change lacks `measurementSource`, so under the new predicate **every existing chapter
  in every existing book loses its loudness badge and its report-card row**, showing
  "No measurement" until re-rendered. Re-rendering a book is expensive. This is the
  direct consequence of the safe-direction default in §2.3.
- **The lie it closes (§1.10, also certain when it occurs):** on `ebur128` failure the
  UI presents the requested ceiling as a measured true peak, or — Shape B — presents
  pre-filter loudness that renders a correctly-normalised chapter as a red "off target"
  pill.
- **The originally-stated reason is void:** single-pass never ships (§1.5), so nothing
  is currently being discarded.

Mitigation for the regression: treat a **missing** `measurementSource` on a sidecar
that has `normalizationType` set (Shape A, two-pass, pre-change) as `'loudnorm'` but
still *displayable* — grandfather legacy rows rather than blanking them. Trades a
little honesty about old books for no visible regression. **This sub-choice is the
crux and is why this needs the user.**

| | (A) Full Option 1 | (A′) Option 1 + grandfather legacy | (B) #1922 only | (C) Nothing |
|---|---|---|---|---|
| closes §1.10 lie | yes | for new renders; legacy still trusted | no — must re-file | no |
| existing badges | **all lost until re-render** | preserved | preserved | preserved |
| tasks | T5, T6, T7 | T5, T6, T7 + one predicate clause | drops T5–T7 | drops T5–T8 |

**DECIDED: (A′) — grandfather legacy rows.** A sidecar with **no** `measurementSource`
is treated as trustworthy-by-assumption and still rendered. Only newly-written sidecars
carry explicit provenance. No mass visible regression across every existing book.

**The honesty cost, stated plainly — this is a real concession, not a free lunch.**
A grandfathered row may be displaying **the very fabricated numbers this change exists
to stop displaying**: a pre-change sidecar whose `ebur128` pass failed carries either
the requested `-1.5` ceiling as its "measured" true peak, or (Shape B) pre-filter
loudness that renders as a false red "off target" pill (§1.10). **There is no way to
tell those apart retrospectively** — the distinguishing information was never written
to disk, so no migration can reconstruct it. We are choosing to keep showing possibly-
wrong old numbers rather than blank every existing book's badges. The exposure shrinks
monotonically as chapters are re-rendered, and it is bounded to books rendered before
this change.

**Migration path for anyone who wants real provenance on old chapters:**
`scripts/relufs-existing.mjs` re-measures a rendered chapter with a fresh `ebur128`
pass and rewrites its sidecar — after T5 it will stamp `measurementSource: 'ebur128'`,
upgrading a grandfathered row to a genuinely-attested one. **It is NOT being run as
part of this work**, on any book. It stays an opt-in operator tool; this PR only makes
it emit the field.

T1–T4 and T8–T10 are identical under every option. **This does not block starting
implementation.**

### 3.2 DECISION 2 — measure when loudnorm is disabled?

`AUDIO_LOUDNORM_ENABLED=false` yields no sidecar, no measurement, fully inert QA.

- **For:** with no normalisation nothing holds the peak down — the one configuration
  where clipping is genuinely likely, and per §1.8 the only realistic route to a firing
  clip check.
- **Against:** `.lufs.json` files would appear for books that have none; the report card
  would light up where it now shows the empty state; `target` would have to be
  synthesised for a chapter never targeted at anything.

**DECIDED: no.** Out of scope; the `if (loudnormStats)` guard stays exactly as it is.
It is a feature, not a defect — sidecars must not start appearing for books that have
none. Backlog it separately if wanted; no task in this plan implements it.

### 3.3 DECISION 3 — retune `clipTpDb`? *(sharpened by §1.8)*

**§1.8 makes this pointed:** after T2 the check is correct but still cannot fire under
defaults, because dynamic loudnorm pins the peak at ceiling +0.1…0.3 dB and the ceiling
is 1.4 dB below the threshold. Measured realistic peak under defaults: **-1.2 dBTP** vs
threshold **-0.1**.

Options: leave it (honest but permanently quiet); move `clipTpDb` to ≈ `-1.0` (would
flag the measured overshoot on this fixture); or raise the ceiling (#1909's territory).

**DECIDED: leave `QA_CLIP_TP_DB` exactly as it is. Do not retune in this PR.**

Rationale: retuning now means calibrating against the current `-16 LUFS` / `-1.5 dBTP`
config, and #1909 may move the ceiling or the mode — which would shift the whole peak
distribution and force an immediate recalibration. **Tuning twice is worse than tuning
once, later.** Ship the honesty fix; accept that the check stays structurally inert
under defaults.

**This decision is what makes §0.1's writing requirement mandatory.** Because we are
knowingly shipping a fix that does not make the check fire, the PR body and both
release notes must say so — otherwise #1922's auto-close reads as a claim we have not
earned. The remaining inertness is explicitly handed to #1909, with the §1.8 table
attached (T10). On-box row 2 (§6) gathers the real-corpus peak distribution that a
future retune will need.

### 3.4 DECISION 4 *(new — review finding 6)* — per-field or per-record trust?

One flag gates a UI whose main path reads only `i`: `classifyDrift`
(`loudness-report.tsx:39-51`) compares `i` against `target`; `tp` is not in the drift
path at all. Meanwhile §2.2 says `i` can be trustworthy (Shape A) exactly when `tp` is
not. A single record-level flag conflates them.

- **(a) Record-level** `measurementSource` — simple; slightly over-conservative (blanks
  a usable `i` when only `tp` is untrustworthy).
- **(b) Per-field** (`measurementSource: { i, tp }`) — precise; chunkier schema, more UI
  logic, more test surface.

**DECIDED: (a) — per-record trust, not per-field.** `listen-player-region.tsx:538-539`
builds a **single tooltip** containing `i`, `target`, `lra`, and `tp` together, so the
record is *presented* to the user as one unit and must be trusted as one unit.
Per-field trust would produce a tooltip that is half-honest — worse than one that is
uniformly labelled. `measurementSource` stays a single scalar on the record
(§2.3); do not introduce a nested per-field shape.

---

## 4. Task breakdown (10 tasks)

T1–T4 and T8–T10 unconditional. T5–T7 gated on Decision 1 ∈ {A, A′}.
Branch `fix/server-loudness-measurement-provenance`; worktree per CLAUDE.md, with
`npx husky` and **both** `node_modules` junctions before the first commit.

---

### T1 — Hoist the measurement; collapse the double sidecar write

**Change** (`server/src/audio/finalize-chapter-write.ts`): move `measureLoudnessFile`
to immediately after `writeFile(tmpAudio, audioBuffer)` (`:205`), against `tmpAudio`;
hold it as `const realLoudness: MeasuredLoudness | null`. Delete the post-rename block
(`:222-247`). Reduce `onLoudnessMeasured` to capturing `loudnormStats` only (no sidecar
write); move the single `writeChapterLufsFile` to after the measurement. Keep the
`if (loudnormStats)` guard and the fail-soft `console.warn`s.

**Verify.** `cd server && npx vitest run src/audio/finalize-chapter-write.test.ts src/audio/measure-loudness.test.ts`.
The existing assertions at `finalize-chapter-write.test.ts:191-207` (`sidecar.tp` ≈ a
fresh `measureLoudnessFile` of the output; `sidecar.tp !== resolveLoudnormOptions().tp`)
must **pass unchanged** — they are the guard that hoisting changed nothing.

**Probe risk.** `tmpAudio` is `<slug>.<ext>.tmp-<pid>-<ts>`, so ffmpeg probes by
content. Fine for `ogg` (`OggS`) and `m4a` (`ftyp`); mp3 relies on frame-sync probing.
T8's format matrix exists to prove this. Fallbacks in order: append the real extension
to the temp name (nothing in `server/src` globs `.tmp-` — checked); or keep the
measurement post-rename and instead move the QA call and the `segments.json` write
after it (§1.4 shows that is safe, but it perturbs crash-tear ordering).

---

### T2 — Feed QA the measured true peak; implement the three-shape fail-soft

**Change.** Same file, the `evaluateChapterQa` call (`:147-152`), implementing §2.2:

```ts
const shapeA = loudnormStats?.normalizationType !== undefined;   // §1.9 discriminator
const qaLufs = realLoudness ? realLoudness.i
             : shapeA      ? loudnormStats!.i
             : null;
const qaTp   = realLoudness ? realLoudness.tp : null;            // NEVER falls back
```

Update the `audio-qa.ts:15-20` header, which describes the inputs as loudnorm-sourced.

**Verify.** T3 + T8; plus `npm run test:server`.

**Ordering.** T1 must land first (`realLoudness` must be in scope above the QA call).
T1+T2 are one logical change; one commit.

**Paired test — the Shape-B guard** (`finalize-chapter-write.test.ts`): stub
`measureLoudnessFile` to return `null` **and** force Shape B (second-pass JSON absent),
with a fixture whose *input* loudness is below `-40 LUFS` but whose normalised output is
not. Assert `audioQa.measuredLufs === null` and that no reason matches `/near-silent/i`.
**Mutation:** change the `qaLufs` fallback to unconditional `loudnormStats.i` — the
pre-filter value trips `nearSilentLufs` and the test fails. This is the only test
covering §1.9's spurious-suspect bug.

---

### T3 — Regression test: the two surfaces can never disagree again

The strongest invariant here; it kills #1922's comment outright.

**Test** (`finalize-chapter-write.test.ts`, real ffmpeg, no mocks):

```
result.audioQa.truePeakDb === sidecar.tp                      // one number, two surfaces
result.audioQa.truePeakDb !== resolveLoudnormOptions().tp     // and it is not the requested ceiling
```

**Mutation — revert T2's `qaTp` line to `measured ? measured.tp : null`.** QA then
reports `-1.5` while the sidecar holds `-1.2` (§1.2, §1.8), so **both** assertions fail.
This test could not have passed before T2 on the committed fixture.

---

### T4 — `measurementSource` on the wire

**Order matters — `openapi.yaml` is the source of truth, `api-types.ts` is generated:**

1. `openapi.yaml` — add optional `measurementSource` to `ChapterLoudness` (`:5604`),
   documenting that absence means a pre-change sidecar.
2. `npm run openapi:types` → regenerates `src/lib/api-types.ts`.
3. `loudnorm.ts:74-99` — add the field to `LoudnormSidecarJson`.
4. `finalize-chapter-write.ts` — stamp `realLoudness ? 'ebur128' : 'loudnorm'`.

**Verify.** `npm run typecheck` (both projects — vitest and pre-commit are blind to
types; this repo has been bitten by exactly that). `git diff src/lib/api-types.ts` must
show only generator output.

---

### T5 *(Decision 1)* — producers: finalize **and** `relufs-existing.mjs`

*Review finding 5.* `scripts/relufs-existing.mjs:229-237` writes `twoPass: true` with no
`measurementSource`. Its entire purpose is writing real `ebur128` measurements, so
without this it emits sidecars the new UI renders as "No measurement" — the script's
output invalidated by the script's own feature.

**Change.** Add `measurementSource: 'ebur128'` to its payload (it only ever writes a
successful measurement).

**Verify.** **The script already has a test — `scripts/tests/relufs-existing.test.mjs`.**
Extend it: assert the emitted payload carries `measurementSource: 'ebur128'`.
**Mutation:** drop the field from the payload → the assertion fails. Note the script
legitimately omits `normalizationType` (ebur128 has no mode) — do not add one.

**Why this matters under A′:** grandfathering means old sidecars keep rendering, so
`relufs-existing.mjs` is the *only* way an operator can convert an unknowable legacy row
into an attested one (Decision 1). If it emitted no provenance, running it would leave
the row exactly as untrustworthy as before — the migration path would be a no-op.

---

### T6 *(Decision 1)* — predicate swap **and the fixture corpus**

*Review finding 4: rev 1 budgeted one new test case for what is ~35 edits.*

**Production predicate** — replace `lufs.twoPass !== true` with a `measurementSource`
test **including the locked Decision-1 = A′ grandfather clause**. The predicate is
three-valued, and the third case is the grandfather clause:

```ts
if (!lufs) return 'no-data';
if (lufs.measurementSource === 'ebur128')  return render;    // attested real measurement
if (lufs.measurementSource === 'loudnorm') return 'no-data'; // attested fallback — the ONLY new neutral
// undefined → pre-change sidecar. A′: reproduce the OLD rule exactly, byte for byte.
return lufs.twoPass === true ? render : 'no-data';
```

**The grandfather branch must delegate to the old predicate, not to `render`.** Writing
it as an unconditional `render` would make single-pass legacy sidecars (`twoPass: false`)
start displaying — the one thing the pre-#1880 gate was genuinely right about, and it
would break `e2e/listen-loudness-report.spec.ts`'s chapter-11 assertion. Delegating
preserves current behaviour for *every* existing record.

**Net effect: only a newly-written fallback sidecar goes neutral.** No existing chapter
changes appearance anywhere. Sites to update:

- `loudness-report.tsx` — `classifyDrift` (`:39-51`), drift computation (`:160`), target
  pick (`:178`), table cells (`:277`, `:280`).
- `listen-player-region.tsx:526` — **note the issue cites `:483`, which is now a
  Regenerate button; the file has drifted.**

**Fixture corpus — re-budgeted under the locked A′ decision.** Rev 2 costed ~35 edits
against option (A). **A′ removes almost all of them:** every existing fixture has
`measurementSource: undefined`, so the grandfather branch reproduces today's verdict
exactly and the corpus stays green *untouched*.

| surface | rev 2 (option A) | **A′ (locked)** |
|---|---|---|
| `src/components/loudness-report.test.tsx` | 8 edits | **0** — grandfathered |
| `src/components/listen/listen-player-region.test.tsx` | 6 edits | **0** — grandfathered |
| `src/store/chapters-slice.test.ts:1013` | 1 edit | **0** — grandfathered |
| `src/lib/api.ts:929-947` mock seed | 17 rows | **0** — grandfathered; ch11 (`twoPass:false`) and ch14 (null) still resolve to `no-data` via the delegated old rule |
| `e2e/listen-loudness-report.spec.ts:79-89` | 3 assertions | **0** — ch1 renders, ch11/ch14 absent, all unchanged |
| `src/lib/types.ts:61-63` | comment | **1** — comment only; now false (moved to T7) |

**That the corpus needs no edits is itself the acceptance evidence for A′** — if any
existing fixture goes red, the grandfather branch was implemented wrong (almost
certainly as an unconditional `render`). Treat a red legacy fixture as a defect in the
predicate, not as a fixture to update.

**New coverage owed (this is the real T6 test work):**

1. `measurementSource: 'loudnorm'` + `twoPass: true` → `no-data`. This is §1.10's lie;
   first test in the repo to catch it. **Mutation:** revert the predicate to
   `twoPass !== true` → the case has `twoPass: true`, classifies on-target, fails.
2. `measurementSource: 'ebur128'` + `twoPass: true` → renders. Guards the happy path.
3. **`measurementSource: undefined` + `twoPass: false` → `no-data`** (the A′ delegation
   guard). **Mutation:** change the grandfather branch to unconditional `render` → this
   case renders and fails. Without this test, the delegation bug ships silently and only
   surfaces in e2e.
4. One `e2e/` assertion that a `loudnorm`-sourced chapter shows no badge (per CLAUDE.md's
   UI-visible/e2e bar). Requires one **new** mock seed row carrying
   `measurementSource: 'loudnorm'` — the single mock-data addition in this task.

**Verify.** `npm run test` (frontend) + `npm run test:e2e`. The pass condition is
"all four new cases green **and** zero pre-existing cases modified."

---

### T7 *(Decision 1)* — stale prose, including three the hoist itself creates

*Review finding 7: rev 1 fixed three stale comments and silently created three more.*

**Goes stale *because of* T1** — all three assert the measurement runs after the file is
on disk at its final path:

- `measure-loudness.ts:12-14` — *"the audio is already on disk by the time this runs"*.
- `measure-loudness.ts:64-68` — the same claim, and it is the **stated rationale for the
  120 s timeout** (*"a wedged ffmpeg here buys nothing but a stuck promise"*). After the
  hoist this runs **before** `preserveExistingAsPrevious`, so a wedged ffmpeg now stalls
  a render that has not yet displaced the previous take. The timeout **value** stays
  correct; its **justification** must be rewritten, not just its wording.
- `loudnorm.ts:65-73` — *"encoded and renamed into place"*.

**Already stale, unrelated to the hoist:**

- `loudness-report.tsx:9-12`, `:42-44`, and the user-visible footnote `:298-304`
  (*"Single-pass renders surface as 'No measurement'…"* — doubly wrong per §1.5/§1.6).
- `audio-qa.ts:15-20` — describes QA's inputs as loudnorm-sourced.
- `finalize-chapter-write.ts:10-12` — the stale "generation.ts still inlines the
  equivalent tail" claim that **produced #1922's false premise** (§1.4). In a file this
  branch already touches, correction unarguable → clears the incidental-findings fix-now
  bar. Declare under "Also fixed, found in passing" in the PR body.

`openapi.yaml` needs **no** correction (§1.6).

**Verify.** `npm run lint`; no behaviour change, no new test owed.

---

### T8 — THE CENTREPIECE, rebuilt: clipping fires, clean stays quiet

*Review finding 1: rev 1's arm passed identically with and without the fix.* **Confirmed
and discarded.** §1.8 also proves the suggested repair (`-0.5`) does not work — there is
no ceiling where `requested < -0.1 <= measured`.

**The fix: move the THRESHOLD into the requested/measured gap, not the ceiling.**
`QA_CLIP_TP_DB` is an existing env override read lazily per call (`audio-qa.ts:71`). Both
arms then run at the **default** loudnorm config, which is also more faithful to
production audio.

At the default ceiling, measured `= -1.2`, requested `= -1.5` (§1.8). A threshold anywhere
in `(-1.5, -1.2]` yields:

- **pre-fix:** QA is fed `-1.5` → `-1.5 >= -1.35` false → `ok`
- **post-fix:** QA is fed `-1.2` → `-1.2 >= -1.35` true → `suspect`

**Arms** (`finalize-chapter-write.test.ts`, real ffmpeg, real finalize path):

- **Clean arm.** Default `QA_CLIP_TP_DB` (`-0.1`), default ceiling. Assert
  `status === 'ok'`, no reason matches `/clip/i`, and `audioQa.truePeakDb ≈ -1.2` (not
  `-1.5`).
- **Clipping arm.** Same audio, same ceiling; `QA_CLIP_TP_DB` set inside the gap.

**Make the threshold self-calibrating**, so ffmpeg-version drift cannot silently close
the window (the golden harness already carries TIGHT/LOOSE modes for exactly this):

1. run finalize once at defaults; read `sidecar.tp` (= measured) and
   `resolveLoudnormOptions().tp` (= requested);
2. **guard:** if `measured <= requested + 0.1`, **fail** the test with an explicit
   message that the overshoot window has collapsed on this ffmpeg build — do **not** skip
   silently;
3. set `QA_CLIP_TP_DB = measured - 0.05` and re-run finalize;
4. assert `suspect` + `/clip/i`.

**Mutation — exactly one, and it is the real one: revert T2.** QA is then fed the
requested `-1.5`, which is below `measured - 0.05` by construction whenever the step-2
guard passes, so the clipping arm returns `ok` and **fails**. No fabricated mutations
(`truePeakDb: -1.5` hardcoded, `measureLoudnessFile → null`) are needed or permitted —
their presence in rev 1 was the tell that the arm was a placebo.

**Second mutation, for the clean arm's non-vacuousness:** invert `audio-qa.ts:101` to
`<=` → the clean arm flips to `suspect` and fails. Without this the clean arm could pass
for the wrong reason.

**Format matrix** (covers T1's probe risk): run finalize for `mp3`, `aac-m4a`, `opus`;
assert `audioQa.truePeakDb !== null` for each.
**Mutation:** give `tmpAudio` a name ffmpeg cannot probe → the affected format fails.

**Honesty note for the PR body:** this proves the check *can* fire and that QA reads the
real number. It does **not** claim the check fires in production — §1.8 conclusion 4 says
it will not under default config, without Decision 3.

---

### T9 — Golden assembly: expect NO re-bless

**Run** `npm run test:golden-audio:assembly` (GPU-free).

**Expected: green, no re-blessing** (§1.7). Audio byte-identical; `i`, `lra`, `tp`,
`normalizationType` unchanged; the new field is additive and unread by `writeBaseline`/L2.

**If red, do NOT `--bless`.** Red means audio actually changed, which this design does not
intend; blessing bakes the regression in permanently. Investigate first.
`npm run test:golden-audio:assembly` bypasses the runner and *cannot* bless — keep it that
way. Record the zero-re-bless outcome in the PR body so the next reader knows it was
checked, not forgotten.

---

### T10 — Ship paperwork

- **Plan doc.** This design pass was originally scoped as "no new `docs/features/`
  file — localized bug fixes; issue + tests are the spec." That was superseded by the
  decision to land this design pass itself as a document of record:
  `docs/features/274-loudness-measurement-provenance.md`. **Also update**
  `docs/features/272-golden-assembly-comparison.md:232-252`, which explicitly defers
  both issues as follow-ups — point it at this PR, and correct its restatement of the
  "QA gates the rename" premise (§1.4).
- **PR body — MANDATORY section, per §0.1.** Not a parenthetical, not a footnote. It must
  state both: the check now consumes a real `ebur128` measurement, **and** the check still
  cannot fire under shipped defaults, because the default ceiling (`-1.5`) sits below the
  default threshold (`-0.1`) and loudnorm pins the peak near the ceiling. Name #1909 as the
  owner of the remaining inertness. Include the §1.8 measured table. Also declare the
  incidental comment fixes (T7) under "Also fixed, found in passing", and record T9's
  zero-re-bless outcome.
- **Release notes — both files, and the ordering is specified.** Lead with §1.10's
  user-legible fix (*a correctly-normalised chapter could show a red "off target" pill —
  fixed*), which is the change a user can actually perceive. The true-peak line must **not**
  imply detection improved: QA now reports the same real figure the badge shows; it does not
  newly detect clipping. `docs/release-notes-next.md` (technical, PR-refed) carries the
  both-true statement in full; `RELEASE_NOTES.md` (brand voice) carries the user-legible fix
  and must avoid any "now catches clipping" phrasing. **Note `RELEASE_NOTES.md` lives at the
  repo root, not under `docs/`** — see §9.
- **Comment on #1909 (required, not optional).** Record the coupling and hand over the
  evidence: the §1.8 five-ceiling table, the conclusion that dynamic loudnorm pins the peak
  at ceiling +0.1…+0.3 dB, **Finding L** (linear `output_tp` under-reports by 4.15 dB, so
  #1909's A/B must read `ebur128`, never `output_tp`), and the note that `QA_CLIP_TP_DB` was
  deliberately left untuned so #1909 can settle the ceiling/mode first (Decision 3). Whoever
  picks up #1909 should inherit this rather than re-measure it.
- **Issue links.** `Closes #1922` and `Closes #1923` (Decision 1 = A′ delivers both).
  **Guard against the misread:** #1922's title says the check "can never fire under the
  default loudnorm config" — the PR body section above is what stops its auto-close from
  reading as a claim we have not earned.
- **On-box acceptance.** §6.
- **Code review.** Mandatory gate, Premium tier. Multi-scope (`server` + `frontend`) under
  Decision 1 ∈ {A, A′} → effort `high`; single-scope `fix(server)` under (B) → `medium`.

---

## 5. Interaction with #1909 (not foreclosed)

#1909 proposes changing loudnorm's **mode or target** (linear + `alimiter`, or lowering
`targetLufs` from `-16`). This plan touches neither.

- **No conflict.** `buildSecondPassFilterString` (`loudnorm.ts:299-311`), the target, the
  ceiling, and mode selection are untouched.
- **This makes #1909 easier.** Its A/B needs trustworthy numbers; after this lands, QA and
  the badge report the same real measurement. Today an A/B would compare a real badge
  against a fabricated verdict.
- **#1909 *will* re-bless both golden arms** (mode/target changes alter audio). That is its
  cost, not this plan's — and §1.7's zero-re-bless expectation keeps them cleanly
  separable: baseline movement during *this* work is a bug signal, not #1909 leaking in.
- **§1.8 is direct input to #1909.** Linear mode at 4.0x measured `-1.7 dBTP` against a
  `-1.5` ceiling (1.2 dB unused headroom — relevant to whether `alimiter` is needed at
  all); and linear's `output_tp` under-predicts the real peak by **4.15 dB**, so any #1909
  analysis reading `output_tp` will be badly misled — it must use `ebur128`.
- **Ordering caution.** Decision 3 defers threshold retuning precisely because #1909 may
  shift the peak distribution. If #1909 lands first, retune against its post-change
  measurements, not the `-1.2` recorded here.

---

## 6. On-box acceptance

The core is provable in-repo with real ffmpeg (no GPU) — §1.8 was measured that way. What
genuinely needs a box:

1. **A real book, end-to-end.** That QA verdicts and Listen badges agree across a full
   multi-chapter render of real synthesised speech, not recorded-PCM fixtures. *Observe:*
   for every chapter, the Suspect badge's true-peak reason (when present) and the loudness
   badge's dBTP figure quote the **same number**. *Prereq:* working TTS engine + a real book.
2. **Real-corpus peak distribution** *(feeds Decision 3).* Across a real book, record the
   measured `tp` spread. *Observe:* whether any chapter approaches `-0.1`, or whether
   §1.8's "pinned just above the ceiling" holds on real material. This is the evidence
   Decision 3 currently lacks.
3. **The measurement-failure path** *(Decision 1 ∈ {A, A′} only).* A chapter whose
   `ebur128` pass fails renders as untrusted, not as `-1.5`-measured. *Observe:* sidecar
   carries `measurementSource: 'loudnorm'`; badge and report row show "No measurement".
   Hard to force naturally; T6 covers it at unit level, this row confirms on real hardware.

Per CLAUDE.md step 3, **recording blocks the merge; running does not.** All three rows land
in `docs/testing/onbox-acceptance-register.md` in the shipping PR, and the live HTML
register linked from that file's header is updated **via the `url` recorded there** — never
republished from scratch — with derived counts recomputed. Run
`npm run check:onbox-register` (it backstops internal arithmetic only; it cannot tell you a
row is missing).

---

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| ffmpeg cannot probe the extension-less temp file | low (mp3 highest) | T8 format matrix; T1 fallbacks |
| Overshoot window closes on another ffmpeg build, silently disarming T8 | **medium** | T8 step 2 guard **fails loudly**; never skips |
| Someone `--bless`es a red golden baseline | low, high cost | T9 states the inversion; `:assembly` cannot bless |
| Legacy chapters lose badges | **eliminated** by Decision 1 = A′ | Grandfather branch delegates to the old predicate; T6 case 3 + an unedited corpus prove it |
| Grandfathered rows keep displaying possibly-fabricated old numbers | **certain, accepted** | The explicit cost of A′ (§3.1). Unknowable retrospectively; shrinks as books re-render; `relufs-existing.mjs` is the opt-in migration |
| PR/release note implies the clip check now fires | **medium — the likeliest way this ships wrong** | §0.1 writing requirement; AC-6; `code-review` must read the prose, since no test can catch it |
| Shape-B fallback trips spurious near-silent | low but real | T2's paired test; §2.2 sets `lufs: null` for Shape B |
| Additive field breaks a strict consumer | low | optional; `chapter-audio.ts:79` and `book-state.ts:399` already read loosely |
| Clip check still never fires post-fix | **certain under defaults** | §1.8 conclusion 4; stated in PR body; Decision 3 |

---

## 8. Acceptance criteria

Done means all of these, not "the tests are green."

| # | criterion | proven by |
|---|---|---|
| AC-1 | The QA verdict's `truePeakDb` is a real `ebur128` measurement of the encoded bytes, never loudnorm's `output_tp` | T3 |
| AC-2 | QA and the `.lufs.json` sidecar can never report different true peaks for one chapter | T3 (`audioQa.truePeakDb === sidecar.tp`) |
| AC-3 | The clip check demonstrably fires on audio measuring above the threshold and stays quiet below it, with **revert-T2** as the sole mutation | T8 |
| AC-4 | A correctly-normalised chapter can no longer render as a false red "off target" pill (§1.10 / Shape B) | T2's Shape-B test + T6 case 1 |
| AC-5 | No existing chapter changes appearance anywhere (A′ grandfathering) | T6 — pre-existing corpus green **with zero edits**; T6 case 3 |
| **AC-6** | **The PR body and both release notes state that the check consumes a real measurement AND still cannot fire under shipped defaults** (§0.1) | T10 — reviewer checks the text, not a test |
| AC-7 | #1909 carries the coupling note + the §1.8 table + Finding L | T10 |
| AC-8 | Golden assembly green with **zero** re-blessings | T9 |
| AC-9 | `npm run typecheck` clean across both projects | T4 |

**AC-6 is a merge gate with no automated backstop.** Nothing in CI can detect a
misleading release note. The `code-review` pass must read the PR body and both release
notes against §0.1 explicitly.

---

## 9. Scope boundary (files this plan may touch)

Recorded exactly, because another agent is active on this machine.

**Inside `server/src/**`:** `audio/finalize-chapter-write.ts`,
`audio/finalize-chapter-write.test.ts`, `audio/measure-loudness.ts`, `tts/audio-qa.ts`,
`tts/loudnorm.ts`.
**Inside `src/**`:** `components/loudness-report.tsx`,
`components/loudness-report.test.tsx`, `components/listen/listen-player-region.tsx`,
`components/listen/listen-player-region.test.tsx`, `lib/api.ts` (one new mock row),
`lib/types.ts` (comment), `lib/api-types.ts` (**generated** by `npm run openapi:types` —
never hand-edited).
**Root:** `openapi.yaml`.
**Inside `e2e/**`:** `listen-loudness-report.spec.ts`.
**Inside `docs/**`:** `features/272-golden-assembly-comparison.md`,
`release-notes-next.md`, `testing/onbox-acceptance-register.md`.

**TWO FILES FALL OUTSIDE the boundary as stated — flagging explicitly:**

1. **`RELEASE_NOTES.md` — repo ROOT, not `docs/`.** Required by CLAUDE.md's
   Before-shipping step 5 (user-facing brand-voice line). Unavoidable; T10.
2. **`scripts/tests/relufs-existing.test.mjs`** — the boundary named
   `scripts/relufs-existing.mjs` only, but that script **already has a test** and T5's
   paired assertion belongs in it. `scripts/tests/**`, T5.

**Touched by no task:** anything under `server/tts-sidecar/**`, `apps/android/**`,
`server/src/routes/**`, `server/src/config/**`, `.github/**`, `brand/**`, `mockups/**`.
No new dependency, no registry knob, no CI change. `scripts/relufs-existing.mjs` is
**modified but never executed** against any book (Decision 1).

**One artifact outside git:** the live HTML on-box register linked from
`docs/testing/onbox-acceptance-register.md`'s header, updated via the `url` recorded
there (§6).

---

## 10. Premise scorecard

| Premise | Verdict |
|---|---|
| #1922: clip check inert under defaults | **survived** — re-measured at 5 ceilings (§1.8) |
| #1922: badge vs QA disagree on one chapter | **survived** — `-1.2` vs `-1.5`, reproduced |
| #1922: linear `output_tp` likewise bounded | **resolved — yes**, and it under-predicts by 4.15 dB (§1.3) |
| "QA gates the rename on some paths" | **FALSE** — one call site, no branch; stale comment is the source |
| #1923: single-pass chapters lose measurements | **FALSE** — `twoPass` hardcoded `true`; unreachable |
| #1923: openapi still asserts the stale sentence | **FALSE** — already fixed by #1926 |
| Brief: both issues re-bless one baseline | **FALSE** — expect **zero**; red = bug signal |
| rev 1: `loudnormStats.i` is always post-filter | **FALSE** — three shapes; Shape B is pre-filter (§1.9) |
| rev 1: T7 clipping arm discriminates the fix | **FALSE** — placebo; rebuilt as T8 on the threshold axis |
| rev 1: some ceiling gives `requested < -0.1 <= measured` | **FALSE** — measured; no such ceiling (§1.8) |
| *(new)* fallback renders fabricated numbers as measured | **found** — the real justification for the field (§1.10) |
