# On-box acceptance register

Shipped behaviour that can only be proven on real hardware — a live GPU, a real
sidecar, a real analyzer, a real book, a real phone — and that was **not** proven
at PR time.

A row here is a debt: the code is merged and users have it, but nobody has
watched it work. Empty register = done.

`npm run check:onbox-register` (CI: `.github/workflows/onbox-register-check.yml`,
ops-43) mechanically checks this file's own internal arithmetic — glance-table
counts against body row headings, and the stated total against the glance
table — on every PR that touches it. It cannot tell you a row is missing,
only that the ones already here don't add up.

This exists because complex work routinely cannot be accepted inside its own PR.
The box is often contended, an acceptance run can take hours, and a PR should not
sit open waiting for one. **Owed acceptance never blocks a merge — it converts
into a row here.** What is not acceptable is the debt evaporating silently, which
is exactly what happened before this file existed: the sweep that produced this
register found debt going back to **2026-06-01** recorded nowhere but in plan-doc
prose.

## Live view (update this, never re-publish)

<!-- CANONICAL ARTIFACT — do not mint a new one. -->

**https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a**

This file has a browsable HTML twin at the URL above. Artifact URLs are
server-assigned UUIDs — they cannot be renamed, aliased, or re-slugged — so
**that exact URL is the artifact's identity**. Update it by passing it as the
`url` argument; publishing the register without it mints a *second*, competing
register and orphans this one. That is the single most likely way this register
goes wrong.

The twin carries derived figures — owed count, per-group counts, oldest debt —
that must be **recomputed** on every edit. Rows can be right while the summary
strip lies.

The governing rule lives in [`CLAUDE.md`](../../CLAUDE.md) under "Testing
discipline" and as Before-shipping checklist step 3. In short:

- **Add a row** in the same PR that ships the unverified behaviour. Not later.
- **Remove a row** only when one of two things has actually happened:
  1. the acceptance was **run on the box** and the result recorded, or
  2. **the repo owner explicitly confirms** it was exercised on a live book or
     books during normal use.
- Either way, record *what was observed*, by whom, and when — in the plan's Ship
  notes, the run sheet, or the issue. "Tests pass, so it's presumably fine" is
  never a reason to remove a row.
- **All three surfaces move in the same PR** — this file, the per-feature run
  sheet, and the live view above. Recording the state is a merge gate even
  though *running* the acceptance is not.

Rows are grouped by **hardware prerequisite**, not by feature, because the point
is to batch: one uncontested session should discharge everything that shares a
setup rather than repeatedly loading and evicting models.

> **How this register goes stale, and how to check.** Its first version was built
> by reading plan headers and issue bodies at face value, and three entries were
> wrong within a day — a prerequisite named as a blocker that was already
> satisfied, a "still draft" PR that had merged six weeks earlier, and a step
> count out of date since before the register was written. Plan prose and issue
> bodies are frequently **not updated after later work discharges them**. Before
> scheduling a session, spot-check each row against closed issues and merged PRs
> touching the same subject. A stale row is worse than a missing one: it sends
> you to run something already done.

---

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | The GPU box (single 8 GB for most; the 2-card boot for a few) | 25 |
| **B** | Local Ollama analyzer only, no TTS sidecar | 2 |
| **C** | One *Ночной дозор* re-analysis session | 3 |
| **D** | Multi-language TTS render + ASR | 2 |
| **E** | Not the GPU box (a phone, a Mac, a browser) | 8 |
| **F** | A real Android device, optionally + a head unit | 1 |
| **G** | GitHub Actions itself (no physical hardware — the runner IS the prerequisite) | 1 |
| — | **Blocked** (hardware absent) | 1 |
| — | **Unconfirmed** (not debts until substantiated) | 2 |

**42 owed.** Oldest: **2026-06-01** (plans 160, 161, 165).

---

## Group A — the GPU box

Most rows need only a **single GPU with Qwen resident**. A few specifically need
the **2-card boot** (8 GB RTX 4070 + 16 GB RTX 5070 Ti over OcuLink) — and the
eGPU is **not hot-pluggable**, so do all 2-card work in one sitting and all
single-card work in another rather than interleaving.

### A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · **16 of 60 run 2026-07-29 · ~44 still owed**

**Partially discharged.** First execution 2026-07-29 by Claude Code on the
dual-GPU box, SHA `2503bca6`, clean tree, real sidecar + real Qwen weights, no
mock mode. **16 tests executed: 15 pass, 1 blocked.** Results are recorded in
the run sheet `docs/testing/fs38-wave3-onbox-acceptance.md` (§2 preconditions
filled, per-test `Result:` lines and §7.1 completed for the tests run). PR #1837
shipped the template (3a/3b1/3b2, 51 tests); Wave 3c added **Section E** (9
tests) — Section E remains entirely unrun, see the blockers below.

**The run found one Critical defect, now fixed.** Every freshly cloned Qwen
voice returned HTTP 500 on its first synthesis until the sidecar restarted —
including the clone wizard's own completion-screen audition, i.e. the first
thing a user does after cloning. `clone_voice` cached a bare prompt where
`_load_voice_prompt` unpacks a `(prompt, language)` tuple
(`ValueError: not enough values to unpack`). Filed as **#1941**, fixed in
**PR #1942**, verified live on-box (clone → immediate synth in the same process
now returns 200). *This is the case for this register existing:* the feature's
central path was broken on shipped `main`, and no automated suite could see it
because unit tests mock the engine and no pytest exercised clone→synth in one
process against the real cache.

**Discharged (do not re-run):** A-01…A-06 (ingest + the full quality-gate tier
set — including the 60s truncation landing at 2,880,044 bytes, delta 0), A-10
(write-time consent guard: 422/400/404, nothing written), A-11 (`/revoke`
stamps `revokedAt`, rest of consent intact, entry survives), A-12 (sample route
403s a revoked clone, healthy control 200), B-01 (route + on-disk half —
UI assertions still owed), B-04 (ECAPA cosine is real: three distinct finite
values, two clones of the same fixture gave 0.8914 vs 0.8813 — not a mock
constant), B-07 (assign writes both qwen **and** coqui slots per Task 24, drops
the stale `variants` map, leaves `voiceUuid` untouched; all 13 characters
diffed, only the target changed), **C-10** ⭐ (total erasure on revoke — 7
artifacts across 3 locations all gone including both cached mp3s and the
original recording; wildcard sweep 0 files; entry + `voice.json` survive with
`revokedAt`), **C-11** (409-with-usage then `{deleted:true}`, entry dir removed,
both cast slots cascade-cleared), C-19 first half (1.7B tier renders a cloned
voice; its erasure is covered by C-10).

**Also proven — the wave's central claim, measured not asserted.** A cloned
voice renders inside a real book: `wren`'s segments re-recorded into Coalfall
ch.3, `characterSnapshots.wren.resolvedVoiceName` = the clone's storage key,
segments carrying `asr.verdict: ok` / **WER 0**. Speaker identity via the
production `/embed`: 20s audition vs human source **0.822**; in-book segments
**0.564** and **0.706**; designed-voice control **0.158**. The by-ear
confirmation (B-03, E-06) is still owed — a human must listen.

**Resolved without on-box acceptance — B-06 (#1945, 2026-07-30).** B-06's own
measurement was already conclusive: the clone-fidelity cosine scores
clone-vs-source *faithfulness*, so degrading the source degrades the clone
equally and the number does not fall (measured: clean 0.891, band-limited
0.881, two speakers overlaid 0.773; a genuinely different speaker measured
0.158). **Disposition:** `CLONE_FIDELITY_MIN = 0.3` is kept as a documented
catastrophe-only backstop, not recalibrated or deleted — see
`server/src/tts/clone-fidelity.ts`'s header comment. B-06's manual step (which
could never pass as written) is retired in favour of an automated test,
`server/src/routes/voice-library.clone-fidelity.test.ts`, which stubs the
`/embed` boundary directly and asserts both sides of the threshold in CI. No
further on-box run is owed for this item — it no longer needs real hardware
to prove.

**Still owed (~44), and why:**
- **Browser/mic (4):** A-07 (recorder webm/opus), A-08 (mic-denial fallback),
  A-09 (consent gates Continue), B-02 (record-path clone). Need a real browser
  with a real microphone.
- **By ear (2):** B-03, E-06. No instrument substitutes; ECAPA cosines above are
  the objective half only.
- **Section E, all 9 — UNBLOCKED 2026-07-30 (#1944 fixed, PR #1962).** Still
  owed as tests, but the blocker is gone: Coqui/XTTS could not load in a
  sidecar that had already served ECAPA `/embed`, and cloning always calls
  `/embed` for the fidelity check. **Acceptance run on the dev box**, both
  halves on `cuda:1` on a dedicated port so the live sidecar was untouched,
  and with `COQUI_PIN_IMPORT_ORDER=0` throughout so the `sys.modules` disarm —
  not the boot-order pin — was the thing under test:

  | Tree | `/embed` | `POST /load {coqui}` |
  |---|---|---|
  | `main` @ `0edde146` (before) | 200 | **500** — `ImportError: Lazy import of LazyModule(… speechbrain.integrations.k2_fsa …) failed` |
  | `fix/sidecar-speechbrain-lazy-proxies` @ `d6af415d` (after) | 200 | **200** — `{"status":"ready"}`, `Coqui ready — 58 speakers in manifest` |

  The after-run's log records the pin explicitly skipped and names all 7
  evicted proxies, so the disarm is what carried it. `coqui_import_ok` went
  `null → true` on the real import.

  **What this does NOT discharge:** Section E's nine tests themselves — they
  are now runnable and remain owed. Nor the pin's own default-on path, which
  was deliberately disabled for this run; it is covered by unit tests only,
  and since PR #1962 it is additionally gated on the XTTS weights being
  present, so Qwen-only and Kokoro-only installs never exercise it at all.

  **Superseded advice:** the old note here said to treat
  `coqui_package_installed: true` with suspicion when planning, because that
  `find_spec` probe never imports and is how this row was once mis-scoped as
  unblocked. Still true of that field — but `/health` now also carries a
  sticky `coqui_import_ok` reflecting a real import attempt, which is the one
  to read. Note #1963: `models-status`'s `importable` is still the old
  find_spec value.
- **C-02, D-02 and any full-book work — BLOCKED by the side-11 host-memory
  leak.** Two full-chapter render attempts died: one at the QA gate (ASR could
  not get VRAM alongside Kokoro), one with `recycle-storm` after the sidecar
  recycled 3× (committed memory peaked at 29,395 MB). The sidecar's own log
  names it: *"expected for the variable-shape leak; the restart ceiling is the
  real guard"*. **Workaround that works today:** the per-character re-record
  (splice) path renders one character's lines without the full-chapter memory
  churn — that is how the central claim above was proven.
- **The rest of Section C (18) and Section D (3):** not reached. C-08/C-12
  (deliberate mid-write sidecar kills) and C-01/E-03 (revoke racing an in-flight
  derive) are untouched and remain the highest-risk unproven behaviour here.

**Two findings that are NOT defects, recorded so they are not re-filed.** (1)
`ASR_DEVICE` and `ASR_COMPUTE_TYPE` in `server/.env` must agree — flipping the
device to `cpu` while `ASR_COMPUTE_TYPE=int8_float16` remains pinned makes every
`/transcribe` 500. `_compute_type()` is correct; nothing enforces the pairing.
(2) `npm start` appears to launch two sidecars but does not — the venv
`python.exe` is a launcher that re-execs the base interpreter as a child. Only
one holds :9000. Separately, `npm run stop` repeatedly reported
`[GONE] tts pid=… (already exited)` for a pid matching neither live process, so
its pid tracking drifts across restarts — minor, unfiled.

**Also opened by this run:** #1943 (consent record cannot name the real
attester — `attestedBy` is overwritten with `personName`, which inverts
`guardian-of-minor`).

Starred, highest-risk — **C-10 is now discharged (passed 2026-07-29)**; the rest
remain: **C-01** revoke mid-derive leaves no live `.pt` and `revokedAt` survives ·
**C-08** a transient failure does not brick a voice · **C-17**
designed-voice self-heal preserves persona · **C-12** a killed mid-write leaves
no truncated `.pt` · **E-01** clone → cast on Coqui → generate · **E-02**
audition-then-revoke refuses Play on the Coqui path · **E-06** the one place
D-B's synthetic-clip-vs-catalogue quality question can actually be judged, by
ear · **E-07** a forced designed-derive failure still renders the chapter
(fail-soft, the opposite policy from cloned's fail-loud).

**E-01 was attempted and is blocked, not failed.** A Coqui splice reported
`splice_complete` but wrote no `voices\xtts\` artifacts and left
`characterSnapshots.wren.voiceEngine` as `qwen` — the character's own
`ttsEngine: 'qwen'` overrides the requested `modelKey`. To attempt Section E,
first flip the target character's engine to coqui (or use the Russian Coalfall
twin, which routes there natively), **and** start from a sidecar that has never
called `/embed` (#1944). Reassuringly, the post-splice audio still measured as
the cloned speaker (0.66 / 0.61 vs source), so **no silent substitution
occurred** — the never-substitute guarantee held even on the path that failed to
reach XTTS.

C-08 and C-12 deliberately kill the sidecar mid-write — nothing else in flight.
D-01 deliberately runs two concurrent book renders sharing one cloned voice.
E-03 deliberately races a revoke against an in-flight Coqui derive.

*Also needs:* Whisper weights, ECAPA `/embed`, the
Coalfall fixture with ≥2 speaking characters/chapter, the 9 audio fixtures in §4,
and (for Section E) a Coqui-capable sidecar plus a non-English (e.g. Russian)
book fixture that actually routes to Coqui.
*Prerequisites confirmed present on the box 2026-07-29:* Qwen 0.6B/1.7B-Base +
VoiceDesign, `faster-whisper-base`, ECAPA `spkrec-ecapa-voxceleb`, coqui-tts
0.27.5 + xtts_v2 weights, both GPUs (the eGPU was attached, so 2-card rows are
runnable), and Coalfall already imported and analysed in 7 languages incl. the
Russian twin. **The §4 audio fixtures now exist** at `C:\fixtures\fs38\` —
public-domain LibriVox, two distinct narrators, F-1…F-9 built and verified
against the `clone-quality.ts` thresholds — so a follow-up session does not need
to rebuild them. Note the box runs `LAN_HTTPS=1`, so the server is on
`https://localhost:8443`, **not** the `http://localhost:8080` the run sheet's
§3 probes assume.
*Plans:* 267, 268, 271 — all `status: active`, Ship notes now record this
partial run. *Cost:* multi-hour; the 2026-07-29 session spent roughly half its
time on the three environment blockers above rather than on tests.

**Six checks added by the post-32 follow-up campaign, same box/setup as
above — batch them into the same session:**

1. **The `preparing-voice` phase (#1813).** Render a chapter with a
   Repairable cloned voice or a self-healing designed voice (same setup as
   C-06/C-07/E-01) and confirm the Generate screen shows a "Preparing
   voice — `{character}`" step, with its own pill, *before* synthesis
   begins — mirroring the existing `recovering` phase, replacing the
   multi-second silent pause `docs/testing/fs38-wave3-onbox-acceptance.md`'s
   KL-f documents. Then render a chapter for a character with no library
   voice at all and confirm the phase never appears. Not yet folded into
   that run sheet's own step list or KL-f's now-stale "expected" text —
   update both when this is next revised.
2. **A cloned voice actually rendering on XTTS end to end** — the wave's
   central claim, already exercised by E-01 above but worth restating
   concretely: play the rendered chapter and confirm the dialogue is
   recognisably the cloned speaker, not a stock catalogue voice, and that
   `cast.json` records the character's `overrideTtsVoices.coqui.libraryUuid`
   matching the clone's uuid with `provenance: 'cloned'`.
3. **Revoke-then-render.** Revoke consent for a voice already cast on
   Coqui, then render a chapter that uses it (same shape as C-01/C-02 on
   the Qwen side, E-02/E-03 on Coqui), and confirm the chapter fails loud —
   `UnresolvableClonedVoiceError`, zero audio produced for that chapter —
   rather than silently substituting a stock catalogue voice.
4. **VRAM partitioning across a mixed chapter — no existing test names
   this explicitly.** Cast one character in a chapter to a Qwen cloned/
   designed voice and another to a Coqui cloned/designed voice in the same
   book, then watch `nvidia-smi` through the resolver pre-pass while that
   chapter renders. Qwen and Coqui must never both hold GPU memory
   resident at the same time — the pre-pass partitions cloned-voice derives
   by engine specifically to preserve this serialization (`fix(server):
   partition cloned-voice derives by engine to preserve VRAM
   serialization`). A spike showing both models resident simultaneously is
   a regression, not a variance.
5. **The `voice_language_mismatch` advisory reaches the screen on all three
   streams.** The frame is emitted by `generation.ts`, `chapter-splice.ts`,
   and (since `f879407c`) `chapter-qa-repair.ts` when a non-English book's
   reused DESIGNED voice is cleared for a baked-manifest-language mismatch.
   Only mock-mode coverage exists for the two newer frontend consumers, so
   confirm on the box: open a **non-English** book that has at least one
   reused designed voice designed for a *different* language, then (a) run a
   per-character re-record from the cast profile drawer's "Fix … audio", and
   (b) hit the repair button on a `suspect` chapter row in the Listen view.
   Each must raise ONE amber toast reading "…designed voice(s) were cleared
   because they were designed for a different language…", naming the cleared
   character — once per run, not once per chapter — and the run must still
   complete rather than fail. An English-only book must raise no such toast
   on either path. Server-side emission is already covered by
   `server/src/routes/chapter-qa-repair.test.ts`; what is owed here is that
   the real (non-mock) stream reaches the real toast stack.
6. **Preview plays on the ready engine, not always Qwen.** The My-voices card's
   Preview button used to always request the Qwen artifact; a voice whose Qwen
   copy is stale/failed but whose Coqui copy is ready 409'd on every Preview
   even though it could genuinely play. Confirm on the box: get a cloned or
   designed voice into a state where `engines.qwen.status` is not `ready` but
   `engines.xtts.status` is `ready` (e.g. a revoked-then-restored Qwen leg, or
   a Coqui-only clone with no Qwen derive yet), then press Preview on its
   My-voices card and confirm real Coqui audio plays instead of a 409 toast. A
   voice with both engines ready should still preview on Qwen (the primary
   engine, and the one carrying the session's 1.7B tier pin). Only mock-mode
   coverage exists (`voice-library-card.test.tsx`); what is owed is the real
   sidecar round trip.

*Pass/fail criteria for all six:* `docs/features/271-fs38-wave3c-xtts.md`.
*Hardware:* the same single 8 GB box as the rest of Group A, XTTS weights
installed (`install-coqui.mjs`/`.ps1`/`.sh`), no additional prerequisites
beyond what A1 already lists above.

### A2 · Capacity-aware GPU placement (plan 264) · **two distinct debts**

**The gate to `stable`/archive** is the plan header's own words (`:14-22`): the
**evict-under-contention rows 6–8** — cold-`/load` device steer, `design_voice`
evicts Ollama, GPU-ASR 503→evict→retry — were *not* force-driven on-box and
"rest on automated coverage for now." Deferred by choice, **not blocked**;
runnable on demand.

**Separately owed:** walkthrough **step 9**, the on-box confirmation of the
#1730 cross-card device-steer fix. The code merged (PR #1732, 2026-07-19) but
its confirmation never ran. The plan calls this "still owed before the
concurrent-multi-card flag flip." **2-card boot only.**

⚠️ *The plan contradicts itself* — the same paragraph lists `S6` among the items
already exercised on-box **and** item 6 among the rows not force-driven. Treat
6–8 as owed per the closing sentence, which is the more authoritative statement,
and fix the plan text while you are in there.

*Step 3* (eGPU fault-drop) is genuinely observe-only — yanking an OcuLink cable
is a hard crash. Mark Blocked/N-A unless it happens on its own.

*Criteria:* `docs/features/264-vram-aware-gpu-placement.md:129-179`, header `:9-22`.

### A3 · srv-57 Multi-GPU Wave 2 · **2-card boot**

Ten unchecked items in [#1230](https://github.com/dudarenok-maker/Castwright/issues/1230).
Real per-card UUIDs from torch · a starved card self-exits with code 43, `/health`
showing the breach first · `QWEN_DEVICE`/`KOKORO_DEVICE` on different cards run
concurrently, same-card pinning still blocks · three code-43 exits in ten minutes
**twice** — once card-specific (trips the streak guard), once not (manual-investigation
path).

Task 16/16.5 (auto-revert on a repeated bad pin) is designed but **unbuilt**, gated
on item 1 — it consumes the `tripEvent()` item 1 exercises.

### A4 · Audition engine + tier fidelity ([#1849](https://github.com/dudarenok-maker/Castwright/pull/1849))

Verified by tests and CI; never listened to.

- A character overridden to **Kokoro** in a **Coqui** book previews in Kokoro.
- A preview on a book set to **1.7B** renders at 1.7B, not 0.6B.
- Design a voice in **My voices**, then Play — first play is instant, no second
  synthesis (the design/play cache pairing that was made real; the two sides
  previously hashed different filenames).
- Force a capacity failure with **Coqui resident** — the error names Coqui and
  where its Stop button is, not just "free VRAM".

*Needs:* Kokoro, Coqui and both Qwen tiers, plus enough VRAM pressure for a real
capacity refusal. *Cost:* short.

### A5 · fs-60 XTTS per-language engine eligibility (plan 249)

Plan header: "**Live-GPU acceptance owed** (mock-mode e2e only)… This plan's
status stays `active`, not `stable`, until that walkthrough runs" (`:9,51`).

Five steps (`:53-66`): an undesigned character on a Russian book shows the
Coqui-fallback banner (not a hard block) · the engine picker offers Coqui · the
voice-readiness gate offers "Proceed anyway" · a **real render** shows a
"Fallback (Coqui)" pill · the same on a still-unsupported language (Chinese)
keeps the old hard block.

*Needs:* real sidecar, 8 GB-class GPU, a Russian book with an undesigned
character, and enough VRAM pressure to exercise Qwen/Coqui evict-and-reload.

### A6 · Bulk voice-design recycle resilience (plan 200)

Shipped direct-to-`main` **2026-06-10** (`274522d0`, closes bug #690). Ship notes:
"**Live-GPU acceptance … is the only remaining check.**"

On the 8 GB box with the sidecar started via `start-prod.bat` (so `.env` ceilings
are actually in effect): "Design full cast" over a multi-voice cast completes end
to end; then force a `/recycle` mid-run and confirm the pill rides through the
respawn rather than stalling.

*Note:* the flow gets exercised informally (bugs #1156, #1532, #1557, #1570 were
all found through real use) — but never this specific forced-recycle walkthrough.

### A7 · Design full cast — bulk Qwen voice design (plan 195)

Shipped 2026-06-07 (`7f0d5f4b`, PR #637); PR #638 filled the Ship-notes SHA but
left the acceptance bullet open (`:78-82`).

Pill survives navigation and a reload mid-run (resumes) · terminal summary counts
are right · series propagation reaches a sibling book · VRAM headroom holds across
a long run — **the exact combination that caused the plan-108 OOM** · a 2nd-tab
single design serialises correctly against a bulk run.

### A8 · GPU residency safety + coexistence (plan 222)

Five-step "USER-RUN, live GPU — OWED" walkthrough (`:54-59`). **Distinct from
B1/plan 216** — that one is the device probe, live ETA and truncation recovery;
this one is eviction and refusal behaviour. Don't conflate them.

8 GB box VRAM steady during analysis (no sawtooth) · eviction before sidecar load
at generation start · a clean **409 "GPU busy"** refusal instead of an OOM ·
eviction before voice design · and **no** eviction on a 12/16 GB box (step 5 needs
the roomier card).

*Shipped* 2026-06-16, PRs #839/#840/#841.

### A9 · Batch the QA re-record loops (plan 228)

"Acceptance (manual, on-box) — **OWED**" (`:95-100`). Regenerate a QA-flagging Qwen
chapter with the full gate stack on and confirm **RTF lands near ~1.2**, down from
~1.9.

*Never claimed done even at merge:* PR #1072's own body says "On-box RTF acceptance
(~1.2 target) to be confirmed on the next clean multi-chapter render."

### A10 · Per-character re-record / splice (plan 176)

"Manual (owed — live GPU + sidecar)" (`:50,55,59`). Still `status: active` as of a
2026-07-24 correction commit that says "Still owed: live-GPU re-record acceptance."

Rendered book → a character's profile → Fix audio → **+3 dB gain** across all
chapters: verify louder, duration unchanged, `.previous.*` written, A/B works,
chapter stays ≈ −16 LUFS. Then **re-record one chapter's lines** and verify timing
integrity — no seam, no doubled title. *Merged* 2026-06-03, PR #500.

### A11 · Structured failure taxonomy (plan 173, fs-19)

"Live multi-failure acceptance owed" (`:9,45`). Force **≥2 distinct real failure
modes** — stop the sidecar mid-run (`sidecar-unreachable`), oversubscribe VRAM
(`vram-spill`) — and confirm the friendly message plus remediation line on both
the row and the toast. *Shipped* 2026-06-03 (`affa489`, closes #469).

### A12 · Post-synthesis audio QA gate (plan 174, srv-27)

"Live acceptance owed … with a deliberately degraded render" (`:9,40`). Craft a
near-silent / clipped / truncated chapter and confirm the amber **"Suspect"** badge
appears on both the Generate and Listen rows. *Shipped* 2026-06-03 (`84a45ff`,
closes #465).

### A13 · Per-run resource telemetry + admin trend panel (plan 175, fs-20)

"Live acceptance owed … after a multi-chapter run on the GPU box" (`:9,44`).
Confirm `#/admin` → "Resource trends" shows RTF / QA / VRAM / wall-time rows and
the sparkline actually tracks RTF. *Shipped* 2026-06-03 (`ee22859`, closes #470).

### A14 · Qwen VoiceDesign persona-prompt rewrite (plan 160) · **oldest debt here**

"Code shipped, **GPU audition validation owed to the user**" (`:9`). Regenerate a
persona → Design voice → audition, and confirm the new pitch/purpose-clause wording
actually changes the rendered voice. *First landed* **2026-06-01**.

### A15 · A/B "current vs proposed" voice audition (plan 161)

"GPU audition validation owed" (`:9`). A non-destructive re-design — **Cancel must
leave the live `.pt` untouched** — plus an audible delta on approve. Directly
downstream of A14; run them together. *First landed* **2026-06-01**.

### A16 · fe-16 Qwen auto-load on a Russian book (plan 165)

Ship notes: "live GPU acceptance is the only owed item." Open a real Russian book's
cast view; confirm the Qwen banner shows and Qwen auto-loads with the analyzer
evicted.

⚠️ *Frontmatter says `status: active` while the body's own `> Status:` line says
`stable`* — worth reconciling while you are there. *Shipped* **2026-06-01**.

### A17 · Emotion-chip preview from the manuscript (plan 180, fe-31)

"Live GPU acceptance owed: the **audible** difference between a designed variant and
the base voice can only be confirmed on a real sidecar" (`:48`). Ship notes still a
placeholder — no shipped date recorded.

### A18 · Device-pin resolution survives a respawn ([#1870](https://github.com/dudarenok-maker/Castwright/pull/1870), closes [#1857](https://github.com/dudarenok-maker/Castwright/issues/1857)) · **2-card boot**

`buildSidecarEnv` now hands the sidecar the raw `cuda-uuid:` literal instead of a
translated `cuda:N`, so the sidecar re-resolves the pin against live torch
enumeration on every spawn. Verified by unit tests and CI; **never watched on real
cards.** The behaviour that matters most is the one no test can reach — a respawn
after the index actually changes.

- Pin Qwen to a specific card in Advanced settings, restart the server, and force a
  supervisor respawn (`POST /api/sidecar/restart`, or let a recycle fire). The engine
  lands on the **pinned** card both times.
- Then change the enumeration order — swap the cards, or set `CUDA_DEVICE_ORDER` —
  and confirm a respawn still finds the pinned card by UUID rather than failing
  `_validate_cuda_index` or landing on the wrong one. **This is the regression the
  change exists to prevent**, and it was previously reachable only when the user had
  opened Advanced settings during that server session.
- Pin `tts.qwen.codecDevice` to a card and confirm the codec is actually placed there.
  Before #1870 the pin was silently ignored — the literal failed inside torch's
  `.to()` and rolled back to CPU.
- Point the codec pin at a card that is **not** present and confirm the sidecar logs
  `QWEN_CODEC_DEVICE=… did not match any visible GPU` and leaves the codec on **cpu**
  — not on the model's card, which is what `auto` would have done.

*Needs:* both cards, and the ability to change enumeration order between boots (the
eGPU is not hot-pluggable, so batch this with A2 step 9 and A3). *Cost:* short.

### A19 · Mixed Qwen+Coqui evict fails soft ([#1893](https://github.com/dudarenok-maker/Castwright/issues/1893)) · **single 8 GB card**

fs-60's mid-chapter `/unload` is now best-effort: a failed evict logs a warning and
the Coqui phase renders anyway, instead of aborting the chapter. Unit tests prove the
chapter survives the failure; what they **cannot** reach is the consequence that
motivated the old fail-loud behaviour — Coqui loading while Qwen is still resident on
a card too small for both. Worth watching once, because the failure mode if the
judgement is wrong is a sidecar OOM, which is worse than the abort it replaced.

- Render a chapter that genuinely mixes Qwen and Coqui — a non-English book (the
  Russian Coalfall chapter) with one designed-Qwen character and one undesigned
  character that falls back to Coqui. Force the evict to fail: point
  `SIDECAR_URL` at a proxy that 500s `POST /unload` and passes everything else
  through, or stop the sidecar's unload path by hand.
- Confirm the chapter **completes** and the server log carries
  `fs-60 Qwen→Coqui evict failed; continuing into the Coqui phase`.
- The thing actually being judged: whether the sidecar then survives Qwen+Coqui
  co-residency on 8 GB. Record which it is — clean completion, a sidecar OOM error
  that fails the chapter with its own message, or a crash/recycle storm. **The third
  outcome means the fail-soft policy needs revisiting** (retry-then-abort rather than
  warn-and-continue) — file it back on #1893.
- Also confirm pausing the run **during** a stalled evict stops it promptly rather
  than waiting out the 10-minute ceiling — the abort is forwarded to the fetch now.

**Run this with A5** — same card, same Russian-book-with-an-undesigned-character setup,
and A5 already owes the evict-and-reload sequencing this row stresses. Doing them in one
sitting costs barely more than either alone.

*Needs:* the 8 GB card only, a non-English book with a mixed cast, and a way to make
`/unload` fail. *Criteria:* #1898; the fail-soft rationale is in the comment at the call
site in `server/src/tts/synthesise-chapter.ts`, and plan 249's accepted limitation #4
records what it weakened. *Cost:* short.

### A20 · Idle Coqui is reclaimed under VRAM pressure ([#1894](https://github.com/dudarenok-maker/Castwright/issues/1894)) · **single 8 GB card**

The sidecar's admission path now frees a resident-but-idle XTTS before reporting
`noCapacity`. Unit tests prove the branch fires and that it never evicts for a Coqui
op; what they cannot reach is whether reclaiming ~3 GB actually admits the blocked
operation on real hardware, and whether the 30 s TTL is tuned for real chapter gaps.

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0`. This box is dual-GPU
  (`cuda:0` 4070 8 GB, `cuda:1` 5070Ti 16 GB) and `_worst_device_key` picks the card
  with the **most** headroom, so an unpinned run calls `idle_evict("cuda:1")` while
  Coqui sits on `cuda:0`, `_same_card` declines, and the row passes or fails for
  entirely the wrong reason.
- Load Coqui from the UI, then start a Qwen-only render that would not otherwise fit.
  Confirm the render **proceeds** and the sidecar log carries `Coqui model unloaded.`
  Record whether the reclaimed ~3 GB actually admitted the op, or was immediately
  taken by something else.
- Then render a mixed Qwen+Coqui book and watch the chapter boundaries. **An
  evict→reload cycle repeating across chapters means `COQUI_IDLE_TTL` is too short**
  (each reload costs ~90 s); a render that still fails `NoCapacityError` with an idle
  Coqui resident means it is too long. Record which, with the observed interval
  between the evict and the next Coqui use, so the default can be moved off 30 s with
  evidence rather than a guess.
- Also confirm the Stop-button crash fix: press **Stop** on Coqui while a chapter is rendering
  through it. The chapter must continue to completion — before #1894 this could kill
  it with `AttributeError: 'NoneType' object has no attribute 'tts'`. Also record
  what the **Stop control itself** reports: `CoquiEngine.unload()` now acquires
  `_synth_lock` before dropping the model, so it blocks for the length of the
  in-flight forward — tens of seconds to minutes. Since #1921,
  `POST /api/sidecar/unload` carries its own 90 s budget (not the 2 s probe
  budget), and the pill shows a disabled "Stopping…" state for the whole wait.
  The expected observation is now: the Stop control shows "Stopping…" with the
  button disabled, and it completes without an error banner, once the in-flight
  forward and the unload both finish. Record whether that held, and how long
  the eventual unload actually took.

**Run this with A19 and A5** — same card, same mixed-cast book, and A19 already stages
the Qwen+Coqui co-residency this row's first bullet needs.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, and a mixed-cast
non-English book. *Criteria:* the spec at
`docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` §6; the TTL
rationale is in the comment on `_COQUI_IDLE_TTL_DEFAULT` in `tts-sidecar/main.py`.
*Cost:* short.

### A21 · Real-book QA/badge agreement after the loudness measurement hoist (plan [274](../features/archive/274-loudness-measurement-provenance.md), [#1922](https://github.com/dudarenok-maker/Castwright/issues/1922), [#1923](https://github.com/dudarenok-maker/Castwright/issues/1923))

Everything is proven in-repo with real ffmpeg (no GPU) against a recorded-PCM fixture
— what that cannot reach is a full multi-chapter render of genuinely synthesised
speech, where the hoisted `ebur128` measurement runs against real TTS output rather
than a single committed clip.

- Render a full book (any engine). For every chapter, confirm the Suspect badge's
  true-peak reason (when present) and the Listen-view loudness badge's dBTP figure
  quote the **same number** — they can no longer be two different readings of the
  same chapter.

*Needs:* a working TTS engine + a real book. *Criteria:* plan 274 §6 row 1.
*Cost:* short (rides along with any other real-book render session).

### A22 · Real-corpus true-peak distribution (plan [274](../features/archive/274-loudness-measurement-provenance.md)) · feeds [#1909](https://github.com/dudarenok-maker/Castwright/issues/1909)

Plan 274 §1.8 measured the requested/measured true-peak overshoot on ONE recorded
fixture (dynamic loudnorm pins the peak ~0.1–0.3 dB above the requested `-1.5` dBTP
ceiling). Decision 3 deliberately left `QA_CLIP_TP_DB` untuned because retuning
against a single fixture's peak distribution risked recalibrating twice once #1909
settles the ceiling/mode question.

- Across a real book render, record the measured `tp` spread per chapter. Confirm
  whether any chapter approaches the default `-0.1` dBTP clip threshold, or whether
  §1.8's "pinned just above the ceiling" pattern holds on real narrated material.

*Needs:* a working TTS engine + a real book (can ride along with A21). *Criteria:*
plan 274 §6 row 2 — this is the evidence #1909's eventual retune needs, not a
pass/fail gate on its own. *Cost:* short.

### A23 · Measurement-failure path renders as untrusted, not as a fabricated reading (plan [274](../features/archive/274-loudness-measurement-provenance.md))

T2/T6 cover the fail-soft fallback and the grandfather predicate at unit level with a
forced (mocked) `measureLoudnessFile` failure. Not yet observed: the real, hard-to-force
failure path on a live render.

- Force (or catch) a chapter whose real `ebur128` re-measurement fails on a genuine
  render. Confirm the sidecar carries `measurementSource: 'loudnorm'` and that both
  the Listen-view badge and the report-card row show "No measurement" rather than a
  fabricated figure.

*Needs:* a working TTS engine + a real book; this failure is hard to force naturally,
so treat it as opportunistic (catch one if ffmpeg genuinely fails during a render)
rather than something to engineer. *Criteria:* plan 274 §6 row 3. *Cost:* short,
opportunistic.

### A24 · A cloned voice renders a non-English book in the book's language (plan [275](../features/275-clone-voice-language.md), [#1951](https://github.com/dudarenok-maker/Castwright/issues/1951))

Before this fix a cloned Qwen voice rendered **every** book, in every language, as
English — `QwenEngine.synthesize` took the caller's language and ignored it, and a
clone's manifest always said `"English"`. The unit and pytest coverage asserts the
*mechanism* (the right language reaches `generate_voice_clone`). Only a real render
proves the *outcome*, and the outcome is what the bug destroyed.

The criterion is deliberately outcome-level, because a mechanism-level assertion is
exactly what would have let the original defect ship: the batch path carries the
language separately from the title beat, and a fix covering only one of them passes
every mechanism test while leaving the whole book wrong.

- Cast a **cloned** voice onto a character with dialogue in a non-English book and
  render one chapter. Transcribe the output through the sidecar's `/transcribe` with
  Whisper **auto-detect** (send no `x-language`). **Pass = the detected language is
  the book's, and `avg_logprob` is better than ≈ −0.5.** Measured 2026-07-30 on the
  pre-fix build for reference: detected `en`, `avg_logprob` **−1.303**,
  unintelligible; with the language corrected, `de` at **−0.366**; a natively
  designed German control scored **−0.201**.
- Confirm `characterSnapshots.<id>.resolvedVoiceName` is still the clone's storage
  key — the never-substitute guarantee must hold while the language changes.
- **Check the chapter title too, not just the sentences.** The title beat is the only
  `/synthesize` call in an otherwise batched chapter, so a regression there hides
  behind correct-sounding body audio.
- Render with a **designed self-healed** voice, restart the sidecar, render again —
  the two must be audibly identical. This is the cache-vs-disk divergence half;
  before the fix the warm cache and the on-disk manifest disagreed, so a restart
  silently changed the output.
- **Then open the chapter's QA report and check the cloned character has no
  `voice-mismatch` rows.** The speaker-drift detector compares each segment against
  a reference the server renders itself (`auditionCentroid`), and that reference now
  carries the book's language too — an English reference against a German chapter
  would flag the voice as drifting when nothing is wrong. Only reachable with a
  character thin enough on in-book anchors to trigger the audition fallback (a
  few-line character is the easy way), so treat it as opportunistic within this same
  render rather than something to engineer.

*Needs:* a single GPU with Qwen resident, a non-English book, and ASR available
(`ASR_DEVICE` and `ASR_COMPUTE_TYPE` must agree — a `cpu` device with a pinned
`int8_float16` makes every `/transcribe` 500). **Run with A1's remaining Section C/D
items** — same box, same book, same sidecar session. *Criteria:* plan 275
§"On-box acceptance". *Cost:* one chapter render plus a sidecar restart.

### A25 · Cloned-voice derive on Coqui no longer needs torchcodec ([#1967](https://github.com/dudarenok-maker/Castwright/issues/1967)) · **single 8 GB card + a real static-FFmpeg box; item 4 needs a Pinokio install**

`xtts_audio_io.py`'s poison test and its mechanism/fidelity tiers prove the patch swaps and restores correctly against a fake `TTS.tts.models.xtts`; what they cannot reach is whether the same patch actually rescues a real cloned-voice derive on a box whose only FFmpeg is genuinely static, or whether the replacement decoder is bit-faithful against real XTTS latents. **The dev box's own venv is currently hot-patched** — PyAV's FFmpeg DLLs were copied into `site-packages/torchcodec/` under canonical names to unblock A1's Section E — so none of items 1–2 below can be honestly run against it without first reverting that hot patch, which returns the box to broken for the duration; schedule the revert with the repo owner rather than doing it opportunistically (design spec §12).

- **1. Static-FFmpeg derive.** Delete the non-hash-suffixed `*.dll` from `site-packages/torchcodec/` (undoing the hot patch above) and confirm `.venv\Scripts\python.exe -c "import torchcodec"` fails again. Then run a Coqui cloned-voice derive. It must **complete** and write `voices/xtts/xtts-<uuid>.{pt,json}` — the exact case that failed unpatched, and the one that blocked all nine of A1's Section E items.
- **2. Latent equivalence.** On a box with a genuinely shared FFmpeg (so torchaudio's own loader also works there), derive the same cloned voice both with and without the patch active — e.g. by temporarily reverting the `patched_xtts_load_audio()` wrap — and compare the rendered output. Confirm the two are audibly equivalent: the stdlib `wave` + NumPy decode is a true substitution for torchaudio's loader, not a lookalike that merely produces *some* audio.
- **3. Install-time verification, both directions.** Run `install-coqui.mjs` against a healthy `coqui-tts` install and confirm the new "Verifying the clone path can decode reference audio" step passes. Then deliberately break it — e.g. monkeypatch or otherwise corrupt the installed `TTS.tts.models.xtts.load_audio` signature before the verification snippet runs — and confirm the installer exits 1 with a message naming the installed `coqui-tts` version and pointing at #1967, rather than completing and leaving a Coqui install that looks healthy but cannot clone.
- **4. Pinokio's torchcodec outcome.** On a real Pinokio install, run `import torchcodec` inside the nested `.venv` that `pinokio/install.js` provisions and record whether it succeeds or fails — genuinely unknown at design time (design spec §11): conda-forge's ffmpeg is built shared, but a *nested* venv created from the conda interpreter does not automatically inherit loadable access to the conda env's `Library/bin` DLLs, so shared-ness there does not imply loadable here. #1967's fix makes the answer moot for *behaviour* either way — a Coqui clone derives correctly on Pinokio regardless — but the outcome itself is still owed as a recorded fact; see the correction note on `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md:83`. **Batch with E1**, which already owns the Pinokio box.

*Needs:* items 1 and 3 want the 8 GB card with a real Coqui install (item 1 additionally wants that card's FFmpeg to be a genuine static build — the normal Windows install via `winget install Gyan.FFmpeg`, or the hot-patch reversion above); item 2 wants a box with a genuinely shared FFmpeg instead; item 4 wants a real Pinokio install (batch with E1). *Criteria:* [`docs/superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md`](../superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md) §12. *Cost:* short per item; item 1's cost is mostly the coordination to safely revert the shared hot patch.

---

## Group B — local Ollama analyzer only

A real Ollama daemon and a long (~110k-char) chapter. No TTS engine resident. Both
rows have a **CPU-only sub-case** — the only checks here that want the analyzer
*off* the GPU. Run those two together, and consider folding in E4.

### B1 · Analysing view honesty for local analyzers (plan 216)

Six steps (`:124-142`). A per-phase Gemini recitation-block falls back to local Qwen
with chip, swap, ticker and log all agreeing · a ~110k-char chapter's ETA reads
realistic minutes and **tightens within ~10s** of streaming, not at chapter-end · a
dense single-paragraph chapter that used to hard-fail with "truncated the response
(length)" now completes · **CPU-only:** the first-chapter ETA seeds slow (~15 chars/s)
rather than assuming GPU speed · `LiveChapterTicker` renders every in-flight chapter
at K=4 with a monotonic per-phase bar.

### B2 · Per-model analyzer keep-alive (plan 263)

**Eight** steps at `:242-299` — an earlier version of this register said seven and
missed step 8, which has been in the file since 2026-07-17.

Driven from the Model Manager with `ollama ps` open in a second terminal. **Step 4 is
the regression worth confirming:** with keep-alive at `0`, the model stays pinned
during a run, but a manual Load pill *outside* a run still warms with a 30s floor
rather than appearing to do nothing. `-1` keeps it resident indefinitely; the reset
(↺) restores the flat default. **Step 8:** a voice design with a custom analyzer
model and no override keeps persona keep-alive at `300`, unregressed by the per-model
resolver. **CPU-only:** a `RAM_HEAVY_MODELS` clamp overrides a configured positive
keep-alive back to `0`.

---

## Group C — one *Ночной дозор* re-analysis session

Three rows re-analyze the **same manuscript** for different reasons. One local pass
plus one cloud pass, captured with scene-break output, attribution output and
truncation/429 telemetry all in mind, discharges all three. No TTS or GPU synthesis.

Book: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор`.

### C1 · Manuscript scene separator — Russian re-run (plan 261)

Plan 261 could not measure this book in its original round: it was mid-re-analysis
and its `manuscript-edits.json` was deleted by the reparse (`:203-206`). The
marker-anchored rule change is claimed to *mechanically* eliminate the old
~92k-character forward-overshoot — that claim is what the re-run confirms. Failure
here is always cosmetic: a divider off by a sentence, never data corruption.

### C2 · srv-59 deterministic dialogue-structure attribution (plan 247)

"Manual acceptance walkthrough (on-box, owed post-merge)" (`:247-249,338-340`).
Re-analyze the same book — 9 chapters, 14,065 sentences — on the default pipeline.
Ship notes: "Not yet shipped: on-box acceptance is owed post-merge." Core engine
merged PR #1482 (2026-07-09); still unrun as of 2026-07-21.

### C3 · Cloud request sizing + local input-fraction calibration ([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685))

Three unchecked items. Uses the free-tier `GEMINI_API_KEY` **already configured** in
`server/.env` — a credential this run exercises, not a blocker.

Re-analyze end-to-end on `gemma-4-31b-it` **including the script-review pass** — the
pass that actually 429'd in the original incident (all 22 logged failures were
`task: script-review`) — and confirm a per-minute 429 is retried rather than
misclassified as daily-quota. Then calibrate `analyzer.stage2.localInputFraction`
(ships at 0.3) downward until a full local re-analysis completes with **zero**
stage-2 truncation drops, and record the working value.

---

## Group D — multi-language TTS render + ASR

### D1 · Non-English ASR content-QA calibration ([#1527](https://github.com/dudarenok-maker/Castwright/issues/1527), [#1084](https://github.com/dudarenok-maker/Castwright/issues/1084))

Render real audio in es/ru (then fr/de), run the ASR content-QA gate against it,
inspect the WER distribution per language, and set `qa.asr.maxWer.{es,fr,de,ru}` from
observed data — they currently all inherit the English-tuned `0.4` default.

Two named residual risks: gendered-number mismatch rate (es/fr/ru "one", ru "two"),
and Russian oblique-case declension mismatches. Also whether Whisper's German output
matches the single-fused-token assumption for compound numbers.

*Prerequisite satisfied:* the fs-61 per-language Coalfall demo books **are**
voice-designed — PR #1568 (merged 2026-07-13) ships "a language-matched Qwen cast
designed from the same English personas" for each of the five samples, 0 `.pt`
collisions across 101 files. Largely an unattended batch: render, then inspect.

### D2 · fs-61 zh/ja placeholder voices ([#1600](https://github.com/dudarenok-maker/Castwright/issues/1600))

The Qwen VoiceDesign pipeline is merged, but the **zh/ja** Coalfall placeholder
artifacts were never produced. Run the shipped pipeline against them. Distinct from
D1's five languages, which are done.

---

## Group E — not the GPU box

### E1 · ops-16 Pinokio installer ([#822](https://github.com/dudarenok-maker/Castwright/issues/822)) · **macOS is the gap**

PR #821 **merged 2026-06-15** (`90bc51eb`) — shipped code with acceptance debt, not
an unmerged feature. The issue body still says "draft PR #821" because it was filed
90 seconds before the merge and never updated. The 6-item matrix is all checked.

Real Windows on-box testing has substantially happened since: four closed bugs
(#1458, #1484, #1508, #1528, closed 2026-07-08→11) found and fixed real
Pinokio-runtime issues — module format, `shell.run` cwd resolution, the reserved
`pinokio/` folder name — and #1513 fixed the `server/.env` load path, now confirmed
in `pinokio-scripts/start.js`.

**What genuinely remains:** **macOS has had zero on-box exercise on any axis**
(install, venv-from-conda, API spelling are all Windows-only confirmations); plus two
Windows items never explicitly re-confirmed — **native Stop actually reaping the
sidecar**, and **confirming the pinned Node is the one actually used**.

> **Escalated 2026-07-27 by [#1859](https://github.com/dudarenok-maker/Castwright/issues/1859);
> the pin landed in a follow-up chore.** The Node question used to be "which Node does
> Pinokio's bundled kernel ship, and is it ≥ 22.22" — that's now moot: `install.js`
> step 1 conda-installs `nodejs=24` (matching `.nvmrc`/CI), and `update.js` re-asserts
> the same pin so a pre-existing install picks it up on its next Update rather than
> staying on whatever Node it started with. `pinokio-scripts/lib/node-pin.test.js`
> pins both the pin itself and that it satisfies `package.json`'s `engines.node` floor
> in code, so a future floor raise without a matching pin bump fails that test — this
> register row is now about what a test can't reach: the real Pinokio runtime.
>
> **What to observe, concretely:** on a machine with Pinokio installed, run a fresh
> Install, then from a `shell.run` step (or the Pinokio terminal, once the conda env is
> active) run `node --version` and confirm it reports **24.x**, not whatever Pinokio's
> kernel bundles — conda envs prepend to PATH, so the pinned Node should shadow the
> bundled one, but that shadowing is unverified outside this repo's reasoning. Then
> confirm Install → Start still completes end to end (this pin adds a package to the
> conda env; a bad channel/solve would surface here, not in any local test).
>
> **The mid-life-upgrade path, and the lag you should EXPECT rather than report as a
> bug.** Pinokio loads `update.js` from the release the user currently has checked out
> and iterates the `run[]` it loaded; `resolve-release.js` `git checkout`s the new tag
> *inside* that run, replacing the file on disk without affecting the loaded array. So
> updating **from a pre-pin release runs the OLD `update.js`** — no pin step — and does
> that update's `npm ci`/build on Pinokio's bundled Node. **This is expected.** The pin
> takes effect from the *next* Update.
>
> Concretely: take an install from a pre-pin release, Update once, and check
> `node --version` — reporting the **bundled** version here is the correct result, not a
> failure. Update a second time and it should report **24.x**. A tester who sees the
> first result and files "the pin doesn't work" has found the documented behaviour, not
> a defect. What genuinely wants confirming is that the second Update converges, and
> that `node_modules` still works across that Node-major swap (native-module ABI is the
> nominal risk, though every native artifact in both trees is a prebuilt N-API binary,
> and `npm ci` deletes and rebuilds `node_modules` anyway — so this should self-heal;
> unproven on-box).
>
> Criteria live in `docs/features/218-pinokio-installer.md` open-verification item 2
> (updated in the same PR). **The release notes for 1.15.0 deliberately do not promise
> Pinokio users this is handled** — an earlier draft did, and it was unsupported; the
> current entry describes the pin without claiming on-box confirmation.

*Needs* a clean macOS machine with Pinokio, plus a short Windows follow-up. Budget
20–40 min for the macOS install alone.

### E2 · LAN HTTPS on by default (plan 250)

"## On-box acceptance (owed)" (`:43-48`). Fresh install boots HTTPS on :8443 with the
cert-provisioned log line · the Open-Web-UI tab loads with no cert warning · **a real
phone** installs the mkcert root CA and completes pairing over `castwright.local` ·
forcing `LAN_HTTPS=0` or deleting the certs degrades to loopback HTTP without a crash.
*Shipped* 2026-07-12 after four review rounds.

### E3 · Pair from `castwright.local` (plan 256)

"On-box acceptance owed — pair a real phone from `https://castwright.local/#/admin`"
(`:48-52`). Authorize a device from the friendly hostname with no 403 · name-first
pairing from the Listen tab shows the chosen name in the admin list · a bare-LAN-IP
request still gets the loopback-only 403 guidance.

**Same session as E2** — shares the phone + host setup, and E2 is what made
`castwright.local` the natural URL this depends on.

### E4 · fe-51 engine-recommendation CPU caveat (plan 259)

"On-box acceptance item (real hardware, not mock mode) — owed" (`:183-191`). The
wizard's CPU caveat claims a low/no-VRAM user can force Qwen onto CPU via the
voice-engine device setting and still render — slow, not crashing. Never confirmed on
real hardware. The plan names its own fallback if it turns out false: soften
`CAVEAT_VRAM` at `server/src/tts/engine-recommendation.ts:34`.

*Needs a real box but specifically the **CPU** path* — pairs naturally with Group B's
CPU-only sub-cases.

### E5 · fe-39 touch press-feedback — DevTools smoke-check ([#1795](https://github.com/dudarenok-maker/Castwright/pull/1795))

The behavioural touch-flash is confirmed by construction but not by an automated test
(jsdom cannot compile the variant); a one-time DevTools touch-emulation check is the
spec's accepted proof. Four controls: continue-listening play badge, "Add book" tile,
wizard "Review ›" chip, voice-library drag icon. Minutes, any machine.

### E6 · ops-35 ffmpeg floor — below-floor + Re-check walkthrough ([#1877](https://github.com/dudarenok-maker/Castwright/issues/1877), plan [269](../features/269-ffmpeg-version-floor.md))

Every unit test drives the floor through a **mocked** `spawnSync`, so nothing here has
been exercised against a real old ffmpeg binary. Needs a box where ffmpeg can be swapped
(a 22.04 container with archive ffmpeg 4.4 is the cheapest route; any machine, no GPU).

Observe, in order:

1. With ffmpeg **4.4** on PATH, `npm run test:server` — preflight must **exit 1** printing
   "ffmpeg 4.4 is older than Castwright supports", with the host OS's upgrade command.
2. Same box, server running, open the Setup Wizard's ffmpeg step — the **amber outdated
   card** (`data-testid="step-ffmpeg-outdated"`), *not* the "isn't installed yet" card.
   Confirm the wizard still **advances** and `GET /api/setup/readiness` reports
   `ready: true` with `blockers.ffmpeg.status === 'warn'`.
3. Admin → diagnostics shows the ffmpeg row at status `warn` with the version in its detail.
   **Also confirm the top-bar Admin health dot goes amber and stays amber** — `diagnostics.ts`'s
   `worst()` bubbles the new `warn` into `overall`, which `admin-pill.tsx:84` renders on every
   screen with no dismiss. That is intended, but it is a permanent nag for a below-floor user and
   should be seen before it surprises someone.
4. **Upgrade ffmpeg to ≥ 6.0 and click Re-check WITHOUT restarting the server** — the card
   must flip to the green ready state. This is plan 269 invariant 6; if it stays amber, a
   cache has been reintroduced into `probeFfmpeg()`.
5. Set `castwright.ffmpeg.minimum` to `null`, repeat step 1 — preflight passes, no warning
   anywhere. (The documented rollback.)

6. **Check the upgrade advice actually works before trusting it.** The Linux copy deliberately
   does *not* name a one-command fix for 22.04, because none exists in-repo (the `ffmpeg` snap
   is 4.3.1, older than 22.04's own 4.4.2 — see plan 269 "Known limitations"). On the box,
   confirm that whatever route you take to ≥ 6.0 actually changes what `ffmpeg -version`
   reports **and** clears the wizard card. A route that installs a newer build but leaves it
   shadowed on `PATH` is the failure this hint exists to pre-empt.

Also owed, and **not** coverable by the above: the Pinokio `"ffmpeg>=6"` constraint on a
real conda env, install **and** update. Group with E1, which already owns the Pinokio box.
Expect the documented one-update lag — a user updating *from* a pre-ops-35 release runs
their old `update.js`, so the constraint applies from the update *after* that. That is not
a bug to report.

**Why every step above is owed:** all of ops-35's automated coverage drives the floor through
a **mocked `spawnSync`** (`server/src/diagnostics/ffmpeg.test.ts` stubs `node:child_process`;
`scripts/tests/ffmpeg-version.test.mjs` feeds the parser canned banner strings). Not one
assertion has met a real ffmpeg binary of any version. The parser is well covered against a
corpus of real-world banner shapes, but "the preflight exits 1 on a genuinely old build" and
"Re-check re-probes a genuinely upgraded one" are both unproven.

---

### E7 · fe-57 venv-bootstrap progress card — the fix nothing automated can prove ([#1883](https://github.com/dudarenok-maker/Castwright/issues/1883), plan [270](../features/270-openapi-setup-surface.md))

`src/components/venv-bootstrap.tsx` declared `status: 'installing'` — a value
`server/src/tts/venv-bootstrap.ts` **never emits** (its states are `detecting` /
`bootstrapping` / `installed` / `error`; `'installing'` is the sibling ollama/coqui/kokoro
vocabulary, copied here by mistake). So the in-progress branch was dead in production: through
a real multi-minute venv bootstrap the card never rendered and the user saw the idle
"Set up the voice engine runtime" button the whole time. **The suite stayed green because the
component's own tests mocked `'installing'` too** — a placebo over a wire value the server
cannot produce.

The fix is now typed against the generated contract, so that class of drift is a compile
error, and an `it.each(['detecting','bootstrapping'])` regression pins the card. **But every
one of those tests mocks `fetch`.** No automated test has ever driven this component from a
real bootstrap job, which is precisely how the bug survived in the first place.

Needs a box with **no** `server/tts-sidecar/.venv` (delete it, or a fresh clone). Any machine,
no GPU. ~2 GB download, several minutes — that duration is the point.

Observe:

1. Setup Wizard → voice-engine step with the venv absent → the "Set up the voice engine
   runtime" button.
2. Click it. **Within ~1.5 s the progress card must appear** — spinner, "Setting up the voice
   engine runtime…", and a live `job.step` line. Before this fix, nothing happened here.
3. Watch the step text **change** as the job advances (`Starting venv bootstrap…` → pip
   output). This proves the poll loop and the card are wired to the same job, not just that a
   card rendered once.
4. Let it finish → the green "Voice engine runtime ready" card, and `onBootstrapped` refetches
   so the parent's status flips without a reload.
5. **The `detecting` window is brief** — if you miss it, that is fine; step 2 covers the
   pre-terminal render. Do not report a missed `detecting` frame as a failure.
6. Failure path, if cheap to induce (e.g. no Python 3.12 on PATH): the red "Setup failed" card
   with the server's message, and a working "Try again".

---

### E8 · ops-36 golden-assembly on a second ffmpeg build ([#1880](https://github.com/dudarenok-maker/Castwright/issues/1880), plan [272](../features/272-golden-assembly-comparison.md))

Run `npm run test:golden-audio:assembly` on a box whose `ffmpeg -version` banner
differs from the baseline's. Record: which of L1/L2/L3 fire and their deltas;
whether L4 took the LOOSE path; and L4-loose's actual RMS-error.

**Why owed:** the cross-build half of the design — whether L1–L3's hard
assertions survive a *different* ffmpeg build — cannot be exercised on a box with
one ffmpeg, and the tier sits outside `verify.yml`, so CI never runs it.

The LOOSE branch itself is **not** unexecuted: the ops-36 demonstration forced it
with a synthetic banner mismatch plus 2.0 LU of drift and it rejected at 24.79 %
RMS-error against a 16 % tolerance. What no box here can prove is the part that
needs a *genuinely* different build — whether L1/L2/L3 hold across one, and what
L4-loose's error actually is when the encoder really differs rather than being
told it does.

Criteria: [`docs/features/272-golden-assembly-comparison.md`](../features/272-golden-assembly-comparison.md).

---

## Group F — a real Android device

### F1 · Android companion app — v1 live-device acceptance (plan 188) · **an entire untested axis**

Plan 188 carries "**Live device acceptance owed**" on essentially every shipped
module — app-3, 4, 5, 6, 7, 8, 13, 14 (`:41-49`, repeated in the Ship-notes table
`:796-816`), app-9 "Live device/head-unit acceptance owed" (`:51`), app-10 "On-device
acceptance (owed post-merge)" (`:504-508`). Status line: "build track: **complete** …
The other remaining work is the **batched live-device/head-unit acceptance pass**."

All the Dart unit and widget tests are green and CI-covered. **Zero of it has been
proven on a physical phone.**

**v1 core, single end-to-end scenario** (`:622-630`): pair a phone to the server via
QR (token + CA fingerprint auto-verified, no OS cert install) → browse the library by
author/series/book → download 2 books → play offline with background, lock-screen and
Bluetooth controls plus a sleep timer → switch between the 2 books, each resuming at
its own position → regenerate one chapter of book A on the server → return to home
Wi-Fi → the app auto-syncs only that chapter and pushes the in-car listening position
back to the server.

**app-9, head unit:** Android Auto / CarPlay media-browse tree navigation and playback
from a real head unit.

**app-10, stream over LAN** (`:504-508`): an undownloaded chapter with "Stream over
LAN" on starts instantly, mid-chapter seek works, lock-screen transport works, it
survives backgrounding, and no OS cert-install prompt appears; with streaming off or
off-Wi-Fi, a "download to play" message rather than a stall.

*Needs* a real Android phone (the plan names a Pixel 10 Pro), the GPU server reachable
on the same LAN, and — for app-9 — a real Android Auto / CarPlay head unit. Not
batchable with any other group.

---

## Group G — GitHub Actions itself

Not physical hardware — the prerequisite is a real dispatch of a specific workflow
on the real GitHub Actions runner, which local execution cannot substitute for
(a fresh `ubuntu-latest` image, real `GH_TOKEN`/`gh` wiring, real `apt-get`).

### G1 · Quarantine-lane health report — first live dispatch (ops-32, #1864, PR #1873) · **two distinct debts**

PR #1873's own body discloses both under "Known gaps — stated rather than
glossed" rather than leaving them to be rediscovered later.

**The workflow has never executed on Actions.** `.github/workflows/quarantine-health.yml`
parses as valid YAML and `scripts/quarantine-health.mjs` is verified standalone
(46 unit tests, mutation-checked), but the live runner environment — `gh
issue view` actually authenticating via the injected `GH_TOKEN`, the `apt-get
install ffmpeg` step succeeding, the job actually posting to
`$GITHUB_STEP_SUMMARY` — is unverified until the first dispatch (manual, via
the Actions tab, or the Monday 03:00 UTC cron). `continue-on-error: true` and
exclusion from every required check mean a failure here cannot block
anything, but "the job doesn't crash" is still unconfirmed. **What to
observe:** a manual dispatch (`gh workflow run quarantine-health.yml`)
completes and its job summary renders a well-formed report — either the
clean "nothing to run" no-op (today's empty register) or an actual bucketed
table if the register is non-empty by then.

**Genuine `intermittent` classification is exercised only by unit tests over
synthetic run sequences** — no real cross-run nondeterminism has been forced
through the classifier. This needs an *actual* flaky quarantined test
present in `docs/testing/flaky-register.md` at dispatch time, which the
empty register doesn't provide today — the first dispatch alone won't
discharge this half. **What to observe, next time a genuinely flaky test is
quarantined:** its row in the report's table lands in the `intermittent`
bucket (a real mix of passed/failed across the 5 runs), not `always-passes`
or `never-passes` — confirming the bucket that is this tool's entire reason
to exist actually fires on real data, not just the synthetic sequences in
`scripts/tests/quarantine-health.test.mjs`.

*Why this sits here and not as a plain automated-test-gap issue* (per this
file's own closing rule below): this is NOT closable by writing more unit
tests — `classifyEntry` is already fully unit- and mutation-tested against
every synthetic sequence that matters. What's missing is a real occurrence
of cross-run nondeterminism, which by construction can't be manufactured or
asserted inside a unit test; the only way to discharge it is to observe live
data once it exists, the same shape as any other row in this register, just
triggered by an external event (a future genuine flake) rather than a
hardware prerequisite. One honest caveat: unlike G1's first debt, this half
does NOT strictly require the GitHub Actions runner — a local
`node scripts/quarantine-health.mjs` run against a real flaky register row
would equally discharge it. It stays grouped under G1 anyway because it
shares G1's dispatch-triggered, opportunistic-timing framing and "what to
observe" shape, not because Group G's runner criterion technically applies
to it.

*Needs:* nothing beyond repo access for the first half; a real quarantined
flaky test (naturally occurring, not manufactured) for the second.
*Cost:* minutes for the first dispatch; opportunistic for the second — piggy-back
on the next real quarantine event rather than manufacturing one.

---

## Blocked — hardware not available

### AMD GPU support Phase 2 ([#1335](https://github.com/dudarenok-maker/Castwright/issues/1335))

Waves A–G were built and merged **dormant** — the code path exists but has never run
against real ROCm hardware. A dormant capability, not an active bug. This box is
dual-NVIDIA; this will not move until AMD/ROCm hardware exists.

---

## Unconfirmed — not debts until substantiated

Kept separate on purpose. Listing a suspicion as debt is how a register stops being
trusted.

- **fs-38 Wave 1** (designed-voice authoring, PR #1800) — no explicit owed callout
  beyond a generic "Live-GPU acceptance" line in plan 194 that is about cloning
  generally (Wave 3's concern), not marked outstanding the way 267/268/264/216/263
  are. Closed bugs #1802/#1833/#1836 show live "My voices" use, consistent with it
  being exercised informally. Not confirmed either way.
- **Ollama concurrency (K>1) real-VRAM validation** — PR #1707 fixed a case where K
  never took effect and ships `peak==K` telemetry so a future run self-verifies. The
  UI half is B1's K=4 step. If a separate `n_slots=1` physics check is owed, its
  written criteria were not found in this repo — do not double-count it.

---

## Deliberately not in this register

- [#1826](https://github.com/dudarenok-maker/Castwright/issues/1826) — its bar is an
  automated interleaving regression test, not a manual walkthrough.
- [#964](https://github.com/dudarenok-maker/Castwright/issues/964) (fs-48 Fish Audio)
  and [#1334](https://github.com/dudarenok-maker/Castwright/issues/1334) (fs-73 Cast
  Pass) — parked or unbuilt. Pre-implementation criteria, not debt on shipped code.
- [#819](https://github.com/dudarenok-maker/Castwright/issues/819) — `moscow:wont`.
- Archived plans whose prose still says "owed" but whose debt was discharged via a
  separate, un-cross-referenced issue — confirmed closed for plans 210 (#752), 214
  (#397), 219 (#823), 193 (#476), and 181 (#1670/#927/#515/#517).

This register is for **manual, hardware-dependent verification of shipped code**.
Automated-test gaps belong in the plan's test section or an issue.
