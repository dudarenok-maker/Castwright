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

The page at that URL is rendered from **one specific file in this repo**:

> ### [`onbox-acceptance-register-live-view.html`](onbox-acceptance-register-live-view.html)
>
> Publish **that** file, with the URL above passed as `url`.

Artifact URLs are server-assigned UUIDs — they cannot be renamed, aliased, or
re-slugged — so **that exact URL is the artifact's identity**. Publishing
without it mints a *second*, competing register and orphans this one.

**The live view is a hand-authored HTML page, not a rendering of this file —
never publish this `.md` to that URL.** Passing the right `url` is *not*
sufficient. Publishing this markdown keeps the URL and destroys the page,
replacing the styled register with default markdown rendering: no summary strip,
a self-referential "Live view" section, and dead relative links. **Nothing errors
when this happens.** It happened four times between 2026-07-31 and 2026-08-01, to
four different PR-shipping agents that each read a paragraph like the one above
and concluded they had complied. The live view is tracked in this repo — rather
than living in whichever session scratchpad last built it — precisely so the
right file is always to hand.

The live view carries derived figures — owed count, per-group counts, oldest
debt — that must be **recomputed** on every edit. Rows can be right while the
summary strip lies. `npm run check:onbox-register` verifies the owed total, the
per-group counts and the row IDs across both files, so **adding or removing a
row here and missing the live view fails CI**. Know its edges, because two of
them are wide:

- **A wording-only edit does not fail.** Rewording a row, recording a run
  result, changing a hardware note or a criteria link — the most common edit
  this register gets — changes nothing the check compares. The live view mirrors
  that prose in its own row bodies and will silently fall behind.
- **The rest of the summary strip is unchecked** — oldest debt, and the
  group/blocked/unconfirmed tallies. Recompute those by hand.
- **The published page is invisible to `check:onbox-register`'s no-flag run.**
  It only ever reads the two TRACKED files, so "was it published at all, and
  was it the right file?" is procedure, not that gate — see the merge step
  below, which gives the specific stale-snapshot race mechanical teeth via a
  second, explicit mode, but still can't verify by itself that someone ran it.

**The concurrency hazard this closes (#1931).** Before the live view was
tracked here, on 2026-07-28 two concurrent sessions each correctly added a
different row (A20, E8) and republished from their own hand-built snapshot —
the second republish was built from a snapshot taken *before* the first
session's row had landed, so the surviving page had one row present and the
other silently gone, with nothing to notice. That was possible because the
live view lived nowhere but a session's own build of it. Tracking both files
in git and gating their agreement via `npm run check:onbox-register` on every
PR closes the git-side half: the live view a PR merges is no longer a
hand-built snapshot racing another session's, it is the file *inside* the
merge, checked against this register before either can land.

**The residual hazard, and the merge step that closes it.** Git-side safety
does not by itself close the ORIGINAL incident, because publishing is a step
that happens *after* merge, outside git — so the same race reopens one level
up. Two lanes can each merge a correct, agreeing live-view edit: git resolves
both rows into the tracked `.html`, and `check:onbox-register` is green on
both PRs. Lane A publishes its merge. Lane B, having fetched/built its own
copy of the *published* page before A's merge landed, publishes from a build
that is now stale relative to what's live — and the artifact loses A's row
again, invisibly, exactly like 2026-07-28, because the no-flag
`check:onbox-register` run only ever compares the two TRACKED files; the
published page itself is outside its reach (no network access from a required
CI check — the same call this design already made for the tracked-pair
comparison, see the edge list above). The merge step that closes this, run
**immediately before every publish**, not only after a suspected race:

1. Fetch the page currently live at the canonical URL above and save it to a
   local file — this is the CURRENTLY-published register, which may be ahead
   of what you are about to publish.
2. Run `npm run check:onbox-register -- --against-published <saved-file>`.
   Unlike `check:onbox-register`'s no-flag run, this comparison is
   deliberately ONE-DIRECTIONAL: your register having rows the live page
   doesn't have yet is the normal reason you're publishing, not a defect, so
   it is never reported here. It fails ONLY when the live page has a row (or
   group) your register does not — the signature of another lane having
   already published ahead of you.
3. **If it fails**, do NOT publish — your register is BEHIND what is already
   live. Pull the latest `main` (the row that's already live should already
   be merged there via its own PR), confirm `npm run check:onbox-register`
   (no flag) is green, and re-run step 2 against the SAME saved copy from
   step 1 to confirm it now passes. It should — main pulling in the missing
   row is what resolves this, not another fetch of the live page.
4. Only once step 2 passes, publish the tracked `.html`, with the canonical
   URL above as `url`.

This is deliberately a MANUAL procedure with mechanical support, not a fully
automatic gate: CI cannot run it (no credentials to fetch the published
artifact, and a network dependency inside a required status check is its own
failure mode). `--against-published` exists so step 3's "does the live page
have something I don't?" judgement is a command's exit code, not an
eyeballed diff — it does not, and cannot, make the four steps happen on
their own. An early version of this check compared both directions
symmetrically, which inverted the diagnosis (failed on every ordinary
publish and told the operator to delete the rows they were about to ship) —
fixed before this landed; see the `checkLiveView` function's own header
comment in `scripts/check-onbox-register.mjs` for the reasoning.

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
| **A** | The GPU box (single 8 GB for most; the 2-card boot for a few) | 37 |
| **B** | Local Ollama analyzer only, no TTS sidecar | 4 |
| **C** | One *Ночной дозор* re-analysis session | 3 |
| **D** | Multi-language TTS render + ASR | 2 |
| **E** | Not the GPU box (a phone, a Mac, a browser) | 8 |
| **F** | A real Android device, optionally + a head unit | 1 |
| **G** | GitHub Actions itself (no physical hardware — the runner IS the prerequisite) | 1 |
| — | **Blocked** (hardware absent) | 1 |
| — | **Unconfirmed** (not debts until substantiated) | 2 |

**56 owed.** Oldest: **2026-06-01** (plans 160, 161, 165).

---

## Group A — the GPU box

Most rows need only a **single GPU with Qwen resident**. A few specifically need
the **2-card boot** (8 GB RTX 4070 + 16 GB RTX 5070 Ti over OcuLink) — and the
eGPU is **not hot-pluggable**, so do all 2-card work in one sitting and all
single-card work in another rather than interleaving.

### A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · **20 of 60 run (2026-07-29, 2026-07-31) · ~40 still owed · 3 run-2 results retracted**

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

**Run 2 — 2026-07-31, SHA `b5479e9c`, clean tree.** Four more discharged, all in
Section E: **E-01** ⭐ (clone → Coqui-routed Russian book → generate: the first
`voices\xtts\xtts-$U.{pt,json}` ever written on this box, `resolvedVoiceName` =
`xtts-$U`, Whisper auto-detect **`ru`** at `avg_logprob` **−0.368**), **E-02** ⭐
(sample 200 → revoke → sample **403** with the exact copy, and the
previously-cached audition URL now **404**), **E-08** (re-confirmed on two more
assigns), and **E-09** — which run 1 could only mark `N/A` because no XTTS
artifact had ever existed. Its first real exercise: 5 files across 3 locations
pre-revoke, **0 remaining** after, both `voices\xtts\` paths included, entry dir
left holding only `voice.json`.

**Run 2 found two defects, both open.**
[**#1967**](https://github.com/dudarenok-maker/Castwright/issues/1967) is the
serious one and it **blocks Section E on any stock box**: every XTTS clone
derive fails because `torchcodec` cannot load without *shared* FFmpeg libraries,
and the normal Windows install (`winget install Gyan.FFmpeg`) is a static build
shipping `ffmpeg.exe` alone. The install docs assert the sidecar "never calls
`torchaudio.load`" — it does, on exactly this path — which is why the installer
drops `torchcodec` in with `--no-deps` and never provisions its native
dependency. Section E above was only reachable after staging PyAV's own bundled
FFmpeg set into the `torchcodec` package directory; that workaround is still in
place on this box (run sheet §7.3).
[**#1969**](https://github.com/dudarenok-maker/Castwright/issues/1969) is why
A24 below is not fully discharged.

**RETRACTED — three run-2 results were wrong, and the cause is
[#1972](https://github.com/dudarenok-maker/Castwright/issues/1972).** A
per-character re-record picks its target segments from `segments.json` but
resolves their sentences — and so the voice — from the **analysis cache**, by
sentence id. Once analysis has run since the render the two disagree, and the
re-record renders another character's line in the requested character's voice.
`resolvedVoiceName` still reports the assigned voice, because it was re-derived
from the cast record rather than recorded from the render.

Every retracted result had been read from that field:

- **A24** — identity half withdrawn. Its German chapter measured **0.949**
  against the chapter's own narrator. The **language** claim stands: it was
  measured from the audio by Whisper, which does not consult the cast, and is
  independently confirmed at the `/synthesize` boundary.
- **E-01** — identity half withdrawn (13 of 21 targeted segments divergent).
  The derive, the artifacts and the language all stand.
- **C-17** — its `F` is withdrawn entirely. The self-heal was never *reached*,
  so the test was never exercised. It is not-run, not failing.

Reproduced with a **healthy** designed voice, and on two books that diverged for
unrelated reasons — one from pre-#1598 attribution damage, one from ordinary
re-segmentation. **The precondition is only "analysis has run since the last
render."** Full chapter generation is unaffected. No test caught it because none
asserts which voice reached the provider.

**Still owed (~40), and why:**
- **Browser/mic (4):** A-07 (recorder webm/opus), A-08 (mic-denial fallback),
  A-09 (consent gates Continue), B-02 (record-path clone). Need a real browser
  with a real microphone.
- **By ear (2):** B-03, E-06. No instrument substitutes; ECAPA cosines above are
  the objective half only.
- **Section E — 4 of 9 now run (2026-07-31); E-03…E-07 still owed, but no
  longer blocked.** The #1944 blocker below is genuinely
  gone — Coqui loaded cleanly in a post-`/embed` process during run 2, logging
  `Coqui ready — 58 speakers in manifest`. A *second*, separate blocker sat
  behind it — the clone **derive** failed without shared FFmpeg libraries
  (#1967) — and that is now fixed and merged (PR #1978, 2026-07-31), so
  E-03…E-07 are runnable on a stock static-FFmpeg box without any hot patch.
  **E-04 specifically is no longer blocked on a fix** — the code-level fix for
  its `ImportError` shape (#2017) landed in PR #2039 — so what remains of its
  debt is a re-run of the reproduction (46-char control, 245-char Russian
  line) on real Coqui weights, not an outstanding bug. Their first run doubles as A26 item 1. History of the
  first blocker follows, kept because it is what the run-2 result confirms:
  Coqui/XTTS could not load in a
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
  real guard"*. **Workaround, qualified since [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972):**
  the per-character re-record (splice) path renders one character's lines
  without the full-chapter memory churn — that is how the central claim above
  was proven — but it now REFUSES on a chapter whose `segments.json` and the
  current analysis disagree (exactly the shape both fixture books in this run
  hit). It only stays usable as a workaround when the two agree; when they
  don't, re-run analysis first (so the splice becomes usable again), or fall
  back to a full chapter generation — which the side-11 leak still blocks, but
  which is at least immune to the splice's own attribution defect.
- **The rest of Section C (18) and Section D (3):** not reached. C-08/C-12
  (deliberate mid-write sidecar kills) and C-01/E-03 (revoke racing an in-flight
  derive) are untouched and remain the highest-risk unproven behaviour here.
- **C-05 (one of the 18 above) now has two recorded sub-observations owed, not
  a new row:** [#2023](https://github.com/dudarenok-maker/Castwright/issues/2023)
  / PR #2041 split it into C-05a (a healthy cloned narrator refuses an
  orphaned-characterId line) and C-05b (a designed narrator's substitution is
  recorded + surfaced) — see the run sheet's `Result (C-05a)`/`Result (C-05b)`
  lines. Sharpens what C-05 needs to test; the Section C headcount is unchanged.

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

> **Observation 2026-07-31 — NOT a discharge, but the first real datapoint.** A mixed
> Qwen+Coqui render was run on the 8 GB card incidentally, while discharging A26 item 1:
> the Russian Coalfall chapter 2 with twelve designed-Qwen characters and `oduvan` forced
> onto a cloned XTTS voice. **The evict was NOT forced to fail** — this is the ordinary
> path, not A19's scenario — and the chapter still died:
>
> ```
> chapter_failed  errorCode: "vram-spill"
> "The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once."
> ```
>
> So of the three outcomes this row asks you to distinguish, the *unforced* case already
> lands on **"a sidecar OOM that fails the chapter with its own message"** — cleanly
> classified and remediated, not a crash or a recycle storm. Repeated with
> `modelKey: coqui-xtts-v2` at run level and it spilled again, because a character's own
> `ttsEngine` still routes it: the run-level key does not force single-engine.
>
> What this does **not** tell us is A19's actual question — whether a *failed evict* makes
> it worse — since the evict here was never made to fail. But it does mean the co-residency
> hazard is reachable on this card **without** any evict failure at all, which is worth
> knowing before running the forced case. Note the box also had two agent pytest suites
> holding ~2 GB of cuda:0 at the time, so this is a contended-card datapoint, not a clean one.

> **Correction 2026-08-01 — that datapoint was contention, not a card-size limit.** The
> caveat above understated it. Re-run on a **quiet** box the same mixed Qwen+Coqui chapter
> **completed 71/71** with `audioEngines {qwen: 3, coqui: 1}`. Measured footprints via
> `POST /load` + `/health`:
>
> | state | cuda:0 | cuda:1 |
> |---|---|---|
> | Qwen 0.6B alone | 0 MB | 1,845 MB |
> | Qwen **+** Coqui, both resident | 0 MB | **3,758 MB** |
> | sidecar fresh, **nothing loaded** | **5,743 MB** | 393 MB |
>
> Both engines together are **3.7 GB** — they fit an 8 GB card with room to spare. That
> last row is the tell: a brand-new sidecar with zero models resident, and cuda:0 already
> two-thirds full. The holder was another worktree's real-GPU Qwen pytest suite
> (`wt-1975-batch-inlock-load`, ~5.4 GB across **both** cards). The refusal itself was
> correct and self-describing — `NoCapacityError … deviceKey: 'cuda:0', blockers: []`, where
> `blockers: []` means "something I cannot see holds this card", since the placement
> controller only knows its own engines.
>
> **So A19's question is still entirely open** — the unforced case does *not* reliably spill
> on an 8 GB card, and the earlier reading that it did was measuring a foreign process.
> Caveat in the other direction: our own peak across a 1,588-sample trace was **6,727 MB**
> (Qwen + Coqui + Whisper ASR together), which on an 8 GB card leaves little headroom — so
> co-residency is genuinely tight, just not the 6.7 GB-at-idle that was observed.
>
> **Box policy since 2026-08-01 (owner's call):** renders are pinned to the 16 GB 5070 Ti
> via `COQUI_DEVICE=cuda:1` / `QWEN_DEVICE=cuda:1` / `ASR_DEVICE=cuda:1` in the git-ignored
> `server/.env`, leaving cuda:0 free for other worktrees' PR suites. **A19's forced-evict run
> must temporarily undo those pins**, or it will not exercise the single-8 GB-card scenario
> this row is about.

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

> **PARTIALLY evidenced 2026-07-31 — NOT discharged.** Corrected after
> [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972) was
> understood; the original entry claimed a full discharge and was wrong.
>
> **What still stands — the fix works, proven at the synthesis boundary.** Three
> direct `POST /synthesize` calls on the same cloned voice, raw PCM transcribed
> with Whisper auto-detect and embedded with `/embed`:
>
> | Call | detected | `avg_logprob` | cos vs source clip |
> |---|---|---|---|
> | English text + `language: English` | `en` | −0.258 | 0.865 |
> | **German text + `language: German`** | **`de`** | −0.699 | **0.809** |
> | German text, language omitted (pre-fix) | `en` | −0.904 | 0.876 |
>
> Row 3 reproduces the shipped bug live — German in, English phonetics out,
> transcript garbage. Row 2 is the fix, with the cloned identity intact at 0.809
> against a ~0.03 different-speaker floor. This is real evidence and does not
> depend on the splice path.
>
> **What is withdrawn.** The row's actual criterion is *"render a non-English
> **chapter** with a cloned voice and transcribe the output"*. That chapter
> render used a splice re-record, so most of what was measured was **narrator**
> audio, not the clone — the rendered lines scored **0.949** against the
> chapter's own narrator. The `de` / −0.233 figure is therefore a measurement of
> the wrong audio: it shows the chapter rendered in German, not that *a cloned
> voice* did. `resolvedVoiceName` said otherwise, and that is the field #1972
> falsifies.
>
> **To finish this row:** re-run the chapter-level criterion once #1972 has
> landed, on a book whose `segments.json` and analysis agree — or via a full
> chapter generation, which is unaffected by the defect. The remaining
> sub-checks (designed self-heal → restart → identical; the QA
> `voice-mismatch` check, blocked on
> [#1969](https://github.com/dudarenok-maker/Castwright/issues/1969)) are
> unchanged.

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

### A25 · `/health` stays live through a contended eviction on the default Qwen path (plan [273](../features/archive/273-sidecar-lock-event-loop.md), [#1919](https://github.com/dudarenok-maker/Castwright/issues/1919)) · **single 8 GB card**

Automated tests prove each eviction step — and the reclaim that follows it — now
runs on a worker thread rather than the asyncio event loop. What they cannot reach
is whether `/health`, and every other in-flight request, actually stays responsive
when a real multi-GB `gc.collect()`/`empty_cache()` and a real contended
`_synth_lock` are in play — on the **default** Qwen path, with no opt-in env var.
Run sheet: [`sidecar-evict-latency-onbox-acceptance.md`](sidecar-evict-latency-onbox-acceptance.md).

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0` (runnable alongside
  A19/A5/A20 in the same session). `SEG_CAPACITY_ADMISSION=1` (the default) and
  Qwen as the generation engine (also the default).
- Run a cast-review **voice design** so Qwen VoiceDesign is warm-resident
  (`QWEN_DESIGN_IDLE_TTL` keeps it ~120 s), then start a Qwen **chapter render** —
  each sentence's forward holds `_synth_lock` for its duration.
- While that render is in flight, trigger a second admission on the same card
  (`POST /load` for coqui, or `/xtts/clone-voice`). Its `qwen.design` eviction
  step's fast-out passes (nothing is *designing*), so it blocks on `_synth_lock`
  held by the in-flight Base forward — the exact race #1919 describes.
- From a second shell, poll `GET /health` every 250 ms **throughout** — from
  before the render starts until the second admission resolves — and record the
  **maximum inter-response gap, in milliseconds.** Before this fix the expected
  gap is on the order of one Qwen forward pass (seconds); after, it should stay
  under roughly 500 ms, bounded by the poll interval rather than by the render.
- Also confirm the evict **actually frees the VRAM** — the second admission
  succeeds rather than 503-ing `noCapacity`. A near-zero `/health` gap because the
  evict silently declined and did nothing would look like a pass and isn't one.
- **Optional second pass** with `SEG_ASR_ENABLED=1` + `ASR_DEVICE=cuda` to exercise
  the `asr` eviction step too. Not required for this row to clear.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, a book with a
designed Qwen voice in progress plus a second admission target (a Coqui `/load` or
an XTTS clone). *Criteria:* plan 273 §7. *Cost:* short.

### A26 · Cloned-voice derive on Coqui no longer needs torchcodec ([#1967](https://github.com/dudarenok-maker/Castwright/issues/1967)) · **single 8 GB card + a real static-FFmpeg box; item 4 needs a Pinokio install**

**The hot patch was reverted on 2026-07-31 and the dev box is now a genuine static-FFmpeg box again** — `ffmpeg 8.1.1-full_build-www.gyan.dev` on PATH, and the 25 copied FFmpeg DLLs removed from `site-packages/torchcodec/`. Note the revert is *not* "delete every non-hash-suffixed `*.dll`" as first written: `libtorchcodec_core4-8.dll` and `libtorchcodec_custom_ops4-8.dll` are torchcodec's **own** extensions, have no hash-suffixed twin, and must stay. The copied set is exactly those non-hash-suffixed files that *do* have a hash-suffixed twin. With #1967 merged the hot patch is no longer needed to unblock A1's Section E.

**Partially discharged — items 1 and 3 are now DONE (2026-07-31); items 2 and 4 remain.** What ran, and what it proved:

- `import torchcodec` → `RuntimeError: Could not load libtorchcodec … FFmpeg is not properly installed`. The box is genuinely broken, so nothing below is a vacuous pass.
- `torchaudio`'s own loader on a reference WAV → same failure. This is the pre-fix path.
- **The real, installed `TTS.tts.models.xtts.load_audio`** — the exact function `get_conditioning_latents` calls — fails unpatched and returns a correct `(1, 22050)` tensor under `patched_xtts_load_audio()`. This is the seam #1967 is about, tested against the shipped upstream function rather than a fake.
- `tests/test_xtts_audio_io.py` on that box → **10 passed, 2 skipped**, the skips being the fidelity tier correctly opting out when torchaudio's loader cannot run. That skip behaviour had never been exercised on a real static-FFmpeg box before; it was only inferred.

**Still owed** is everything that needs the sidecar and a real voice — see items 1–4.

- **1. Static-FFmpeg derive — DISCHARGED 2026-07-31.** Ran on the reverted box against a sidecar the server genuinely supervised. The derive **completed** through the full `CoquiEngine.clone_voice` path and wrote both artifacts into a directory that was **empty** beforehand, so no cached `.pt` could have short-circuited it:

  ```
  18:12:59.558 [sidecar] Cloned + cached Coqui voice 'xtts-0abceba4-…' from caller clip.
  xtts-0abceba4-5eba-4d8f-8bdf-46bee14c931d.pt    135,509 B
  xtts-0abceba4-5eba-4d8f-8bdf-46bee14c931d.json      172 B
  ```

  No `derive-failed`, no `Cloned voice(s) unavailable`. The rendered audio is the clone and not a substitute — **0.229** cosine against the source clip versus a **0.014** different-speaker floor, measured through the production `/synthesize` → `/embed` path rather than read off `resolvedVoiceName`.

  **Three preconditions were verified, not assumed** — each is a way this acceptance can be faked:
  1. *The box is really static-FFmpeg.* `import torchcodec` still fails. The 25 stray hash-suffixed FFmpeg DLLs the first revert left inside `site-packages/torchcodec/` were also removed (62.6 MB); torchcodec's own 10 extensions are intact.
  2. *The sidecar is post-merge.* The running one had been orphaned by a recycle storm — `POST /api/sidecar/restart` returned **409**, i.e. nothing supervised it, so its vintage was unknown. Restarted the stack; `/restart` then returned **200**. **Treat a 409 as "this sidecar may be any age."**
  3. *No cache existed to short-circuit the derive.* `voices/xtts/` was empty.

  **Deviation, deliberate:** the hand-off brief suggests reusing E-01's splice setup. A **full chapter generation** was used instead, because [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972) — found the same day — makes the splice unsafe on that book (13 of 21 targeted segments divergent), and that contamination is exactly why E-01's original identity claim had to be retracted.

  **This does NOT discharge E-01.** The chapter itself failed *after* the derive with `vram-spill` (mixed Qwen+Coqui on the 8 GB card — see A19), so "the chapter renders" and the by-ear check remain owed there.

  A separate finding came out of it: a clone rendered in a language other than its source clip's loses most of its speaker identity on XTTS — 0.600 (English) → 0.229 (Russian), same derive. Filed as [#1998](https://github.com/dudarenok-maker/Castwright/issues/1998).

- **2. Latent equivalence — PARTIALLY DISCHARGED.** Decode equivalence was **measured** during PR #1978's review, on the still-hot-patched box, by running both decoders side by side against the same WAV: **max difference 0.0**, mono and stereo-downmix alike, so the replacement is bit-identical to the loader it replaces rather than merely similar. What remains is the *audible* end of it — derive the same cloned voice with and without the `patched_xtts_load_audio()` wrap on a shared-FFmpeg box and confirm the rendered output is equivalent. Cheap once item 1 can run.
- **3. Install-time verification — DISCHARGED 2026-07-31.** Both failure directions now run on a real install, and they produce **different** messages, which was the whole point of the marker line:

  | Scenario | exit | marker in stdout | branch selected |
  |---|---|---|---|
  | control — healthy | **0** | true | PASS, no failure branch |
  | **loader drift** (rebound to a wrong signature) | **1** | **true** | **MSG-1** — "patch could not be applied", names `coqui-tts 0.27.5`, points at #1967 |
  | **unrelated crash** (`import TTS` raises) | **1** | **false** | **MSG-2** — neutral "verification could not run" |

  Direction 2 correctly did **not** get MSG-1 — the specific defect this item existed to rule out. Drift message verbatim: `RuntimeError: XTTS reference-audio patch cannot be applied: unexpected load_audio signature ('some_other_name', 'and_another', 'extra') (coqui-tts 0.27.5).`

  Driven through the **real** `COQUI_VERIFY_CODE` and the **real** branch predicate from `install-coqui.mjs:222-232`; perturbations injected via `PYTHONPATH` only (a `sitecustomize.py` rebinding `load_audio`, and a shadow `TTS/__init__.py` raising `ImportError`), so the shared venv was never mutated. The guard's other drift shape (attribute missing) is already unit-covered by `test_raises_when_load_audio_missing`; the on-box-unique part was the marker-driven branch selection, which is what ran.

- **4. Pinokio's torchcodec outcome.** On a real Pinokio install, run `import torchcodec` inside the nested `.venv` that `pinokio/install.js` provisions and record whether it succeeds or fails — genuinely unknown at design time (design spec §11): conda-forge's ffmpeg is built shared, but a *nested* venv created from the conda interpreter does not automatically inherit loadable access to the conda env's `Library/bin` DLLs, so shared-ness there does not imply loadable here. #1967's fix makes the answer moot for *behaviour* either way — a Coqui clone derives correctly on Pinokio regardless — but the outcome itself is still owed as a recorded fact; see the correction note on `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md:83`. **Batch with E1**, which already owns the Pinokio box.

*Needs:* items 1 and 3 want the 8 GB card with a real Coqui install — the dev box already satisfies item 1's static-FFmpeg prerequisite since the 2026-07-31 revert, so item 1 now needs only a post-merge sidecar and a consented sample; item 2's remaining half wants a box with a genuinely shared FFmpeg; item 4 wants a real Pinokio install (batch with E1). *Criteria:* [`docs/superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md`](../superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md) §12. *Cost:* short per item — the coordination cost of reverting the shared hot patch is now spent.

---

### A27 · A missing Kokoro/Qwen package surfaces as Install, a present-but-unimportable one as Repair ([#1965](https://github.com/dudarenok-maker/Castwright/issues/1965), PR #1986; missing-variant copy corrected and Setup-checker coverage added by [#1999](https://github.com/dudarenok-maker/Castwright/issues/1999), PR #2010) · **no GPU needed, sidecar venv only**

The whole point of `*_import_ok` is a package that `find_spec` finds and a real
`import` cannot load — the #1944 speechbrain shape. **That state cannot be
manufactured in CI**: every test here injects the flag, so what is proven is the
plumbing from `/health` to the badge, not that a genuinely broken install
actually produces `false` rather than an uncaught crash, a hang, or a sidecar
that never reaches `/health` at all. Criteria live in this row; there is no
separate run sheet (the ticket body plus the paired tests are the spec).

- **Break the import, don't delete the package.** In the sidecar venv, leave
  `site-packages/kokoro_onnx/` in place — `find_spec` must keep succeeding — and
  make importing it raise: e.g. append `raise RuntimeError('onbox #1965')` to its
  `__init__.py`. A `RuntimeError` rather than an `ImportError` is deliberate: it
  is the second documented shape of the #1944 collision and the reason the
  recording catches `BaseException`. Keep a copy of the original file.
- **Confirm the null baseline first, before touching anything.** On a freshly
  started sidecar, `GET /health` must show `kokoro_import_ok: null` — not
  `false`. Null is the common value and must never read as broken: Model Manager
  should show Kokoro exactly as it does today, and `GET /api/diagnostics`' Voice
  engine row must be `ok`. A `false` here would mean the recording is firing
  without a real attempt.
- **Then force a load** (a one-line Kokoro render, or the Model Manager's own
  load control) so the import chokepoint actually runs. It must fail *and* be
  recorded: re-poll `/health` and observe `kokoro_import_ok: false` while
  `kokoro_package_installed` stays `true` — the two disagreeing is the signal.
- **Observe the two user-facing surfaces.** Model Manager's
  Kokoro card must offer **Repair** (not "install", and not a silent healthy row —
  `installState: 'package-missing'` off a `true` find_spec is the tell), and the
  Admin console's **Voice engine** row (`GET /api/diagnostics`, rendered at
  `src/views/admin.tsx:232` — this row is the *only* surface that shows this exact
  string; the Setup checker's copy comes from a different endpoint, checked
  separately below) must read
  `reachable · Kokoro package will not import — repair in Model Manager`.
- **Then check the *missing* variant, and check it AFTER a load attempt.** On a
  venv with no `kokoro_onnx` at all, force a Kokoro load and re-poll: both live
  signals are now known and both are `false` — the attempt records
  `kokoro_import_ok: false` (the ImportError) while `kokoro_package_installed`
  is `false` too — yet they describe one fault, not two. The Voice engine row
  must read `reachable · Kokoro package missing — install in Model Manager` and
  must **not** say "will not import" or "repair". (#1999/PR #2010 corrected this
  row's own verb from "repair" to "install" — a stale expectation here would
  fail a runner against *correct* behaviour, which is exactly what this update
  fixes.) This is also the exact cell PR #1986's original review found inverted:
  "will not import" here sends the operator to repair a package that was simply
  never installed. (A *successful* import still outranks a `false` find_spec —
  if `kokoro_import_ok` is `true` the row is `ok` whatever the probe says, since
  a real import that returned is the stronger evidence.)
- **Check Model Manager too, in this same missing state** (#2010 m1 — the
  reviewer's own repro cell). The Kokoro row must offer **Install**, not
  Repair, and its badge must agree with its toggle: the badge must read as
  not-yet-installed (e.g. "Not installed") and must **not** read "Needs
  repair" next to an "Install" button. Before the m1 fix the row's badge read
  the disk-only inventory state while the toggle read the live packageFault
  probe, so this exact cell showed "Needs repair" beside "Install" — a runner
  following only the bullets above would have no criterion telling them
  whether that mismatch was expected. It is not: badge and toggle must always
  name the same fault.
- **Now check the Setup checker surface too** (`GET /api/setup/readiness`,
  `server/src/routes/setup-diagnosis.ts`'s `diagnoseTts` — out of scope for this
  row before #1999/PR #2010, in scope now, since it is the surface that PR
  actually changed and the one whose trigger cannot be manufactured in CI). With
  only Kokoro broken (the "will not import" state above) and Qwen untouched, its
  `blockers.tts` must read *"The Kokoro package is present but will not import in
  the voice engine runtime."* with remediation *"Repair Kokoro in Model
  Manager."* — naming the engine in both. With only Kokoro missing (the "install"
  state above), it must read *"The Kokoro package is missing from the voice
  engine runtime."* with remediation *"Install Kokoro in Model Manager."*, and
  the response's `blockers.tts.action.kind` must be `kokoro-install` — not
  absent, which would leave the instruction with nothing to click.
- **Then the mixed-fault case — the one a runner is most likely to hit and
  least likely to interpret correctly.** Break `qwen_tts/__init__.py` too (its
  own repeat of the steps below) so Kokoro is *missing* (no `kokoro_onnx` at
  all) and Qwen is *broken* (present, import raises) at the same time. The
  Setup checker must name **Qwen**, not Kokoro: *"The Qwen package is present
  but will not import…"* / *"Repair Qwen in Model Manager."* — a live-confirmed
  broken package is the fault the user cannot infer on their own, and outranks
  a merely-missing one regardless of which engine has which. (Pre-#2010 review
  this precedence was inverted — Kokoro's plain "not installed" was named
  instead, and Qwen's real breakage went unmentioned entirely. The Admin
  console's Voice engine row is unaffected by this precedence question — it
  already names *both* engines when both are at fault, as its own STANDARD_TTS
  loop; only the Setup checker's single-blocker copy has to choose one.)
- **Confirm Coqui stays out of the diagnostics row.** On a box with Coqui
  deliberately not installed, the Voice engine row must remain `ok` — Coqui is
  opt-in and its absence is not a fault.
- **Repeat every step above for `qwen_tts`** (break `qwen_tts/__init__.py`,
  force a Qwen load). Qwen is the one to watch: `qwen_import_ok` means only that
  `from qwen_tts import Qwen3TTSModel` returned — the load continues into
  `from_pretrained` and a `.to(device)` retry loop, so a failure *after* the
  import must leave the flag `true` and must **not** produce a Repair prompt.
  That over-claim case is the specific thing this row exists to catch.
- **Induce that post-import failure deliberately — breaking `__init__.py`
  cannot reach it.** A broken `__init__.py` fails *at* the import, which is the
  case already covered above; the over-claim case needs a load that gets *past*
  the import and then fails. Starve it of weights: with the sidecar stopped,
  rename the Qwen base snapshot directory in the HF hub cache —
  `models--Qwen--Qwen3-TTS-12Hz-0.6B-Base`, the path shape
  `server/src/tts/model-paths.ts:49-51` builds from `QWEN_BASE_MODEL` — to
  `…-Base.bak`, then start the sidecar with `HF_HUB_OFFLINE=1` so
  `from_pretrained` cannot quietly re-download it, and force a Qwen load. The
  seam is real, not assumed: `_record_qwen_import_result` wraps only the
  `from qwen_tts import Qwen3TTSModel` statement (`main.py:4457-4467`),
  `_QWEN_IMPORT_OK` has exactly one writer (`main.py:1272-1274`), and
  `from_pretrained` runs afterwards (`main.py:4520`), so nothing later in the
  load can clear a `true` that the import already recorded. A non-meta load
  fault also re-raises with **no** sidecar recycle, so the process stays up and
  `/health` stays pollable — which is what makes this observable at all.
  **Expect:** the load 500s; `/health` still reports `qwen_import_ok: true`
  alongside `qwen_package_installed: true`; the Voice engine row stays `ok`;
  and the Qwen card offers **no package Repair**. *Expected knock-on, not a
  failure:* renaming that directory also flips the Node-side disk detector
  (`qwenWeightsPresent()`, `model-paths.ts:83`, reads the same path), so the
  card legitimately shows a weights-missing / download state. A weights state
  is fine; a *package* Repair prompt, or `qwen_import_ok` flipping to `false`,
  is the failure. Rename the directory back afterwards.
- **Restore both `__init__.py` files and the renamed HF cache directory, and
  restart the sidecar**, then confirm `/health` reports `true` for each engine
  after a successful load.

*Needs:* the sidecar venv with `kokoro_onnx` and `qwen_tts` installed plus the
Qwen base snapshot already in the HF cache (the post-import step renames it),
write access to both, and a sidecar restart between passes (the flags are
sticky per process). No GPU is required for the Kokoro half — the import fails long before
any device work — so this can ride along with any other Group A session, or run
alone on a CPU-only box. *Criteria:* this row. *Cost:* short.

---

### A28 · Stranded VRAM pool reclaimed on the admission-failure path ([#1976](https://github.com/dudarenok-maker/Castwright/issues/1976), PR [#1993](https://github.com/dudarenok-maker/Castwright/pull/1993)) · **single 8 GB card**

Unit tests inject a fake `probe()` and a fake `reclaim` hook, proving the CALL
SEQUENCE (idle-evict first, reclaim once on failure, cooldown, the
in-use skip) — none of them touch a real CUDA allocator, so whether an actual
stranded `torch.cuda.empty_cache()` pool comes back on real hardware, and
whether the two new guards (C1, PR #1993 review) behave under real timing,
is unproven.

- Render a chapter to completion, let the engine report unloaded, and confirm
  (via `nvidia-smi` and `GET /api/sidecar/health`'s new
  `vramReservedMbByDevice`) that a reserved-but-unallocated pool is left
  behind on the render card, matching #1976's own measured shape (~3.9 GB on
  an 8 GB card).
- With that stranded pool present and nothing resident, issue an op that
  would otherwise be refused (an ASR `/transcribe`, or a voice design). It
  must be **admitted**, and `nvidia-smi` on that card must drop to
  near-baseline afterward — the #1976 acceptance criterion this row exists
  to close.
- Confirm the two C1 guards don't misfire on real hardware: (a) start a
  genuine render (so the render's engine holds a live reservation) and, from
  a second client, issue a refused op on the SAME card — the reclaim must
  NOT fire mid-render (watch for `stranded-cache reclaim` in the sidecar log;
  it must not appear while the render is in flight); (b) issue two refused
  ops on the same card within 30 s of each other and confirm the reclaim log
  line appears only once, not twice.
- This PR's `Closes #1976` was narrowed to `Refs #1976` in review (M5) — the
  render/unload-completion reclaim (#1976's other acceptance criterion) is a
  SEPARATE, not-yet-built lever tracked on its own follow-up issue. Do not
  treat this row's discharge as closing #1976 itself.

*Needs:* the 8 GB card only, a chapter render, and something to run past it
(ASR or a design) once it finishes. *Criteria:* PR #1993's description +
the C1/M3 review findings quoted above. *Cost:* short — rides along with A19
and A20, which already stage a mixed-engine render on this same card.

---

### A29 · `qa.asr.model` reaches the sidecar AND every server-side reader (PR #2008, closes [#1988](https://github.com/dudarenok-maker/Castwright/issues/1988), [#1989](https://github.com/dudarenok-maker/Castwright/issues/1989)) · **no GPU needed, sidecar venv only**

Registering `ASR_MODEL` as the `qa.asr.model` registry knob made a UI-set
override reach the sidecar via the generic restart-sidecar env-injection loop,
but the PR's own independent review found it did **not** reach the server's
own Node-side Whisper-model readers — `whisperRepoDir()` / `whisperModelPresent()`
/ `detectWhisperInstallStateOnDisk()` (`model-paths.ts`, `whisper-install-detect.ts`)
cached `process.env.ASR_MODEL` in a module-load-time constant, so Model
Manager's sizing, install-state, and **Remove** all still targeted `base`
regardless of what was actually configured and loaded. This was verified as a
real defect (not just a review claim) by reverting the fix and watching the
paired tests go red — see the PR's mutation-verification comment — but the
full failure mode needs the real sidecar + a real Hugging Face download to
observe end to end, which no unit test can substitute for.

- **Prerequisite:** comment out `ASR_MODEL` in `server/.env` first, if it's
  set. `server/.env.example`'s generated block ships `ASR_MODEL=base`
  uncommented; on a box seeded from that file, the value is present as a real
  env var, and `resolver.ts` gives env unconditional precedence with
  `locked: true` — Advanced Configuration would show the knob disabled with
  an env pill, making step 1 below unperformable.
- Set **Content-QA (Whisper) model** to a non-default value (e.g. `small`) in
  Advanced Configuration and let the sidecar restart. Confirm from the sidecar
  log / `/health` that `faster-whisper` actually loaded `small`, not `base`.
- Open Model Manager: the Whisper row must report `small`'s on-disk size and
  path, not `base`'s.
- Click **Remove**. It must delete the `small` snapshot directory and leave
  any pre-existing `base` snapshot untouched — the inverse of the pre-fix
  behaviour, which deleted `base` and left the model actually in use on disk.
- Run the in-app installer (Account → Models → Whisper → Install) with
  `small` configured and confirm `install-whisper.mjs` fetches `small` (its
  `[install-whisper]` step lines / the resulting HF cache snapshot name), not
  `base` — pinning that the installer spawn now receives an explicit
  `--model` flag carrying the live value rather than falling back to its own
  `process.env.ASR_MODEL || 'base'` default. Confirm the install card's own
  copy also names `small`, not a hard-coded `base` (m1 fix).
- **Separately**, confirm the documented CLI path
  (`node server/tts-sidecar/scripts/install-whisper.mjs`, no flags) fetches
  `base` in this scenario, not `small` — it has no access to
  `user-settings.json`, so it cannot see the UI override; only the in-app
  installer (which always passes `--model`) reflects the configured model.
  This is expected, not a defect — it's why the script's usage comment now
  says to pass `--model` explicitly for a UI-configured, non-default model.

*Needs:* the sidecar venv with `faster-whisper` installable, network access
for the HF download of a second model size, and write access to the HF hub
cache to seed/inspect both `base` and the configured model's snapshots. No GPU
required. *Criteria:* this row plus PR #2008's description of the failure
scenario. *Cost:* short — one restart-sidecar cycle, one install run, one
Remove click.

---

### A30 · Golden-audio bless guards don't rubber-stamp an honest bless, and `_make_kokoro` exercises a real engine (PR [#2032](https://github.com/dudarenok-maker/Castwright/pull/2032), closes [#1995](https://github.com/dudarenok-maker/Castwright/issues/1995), [#2003](https://github.com/dudarenok-maker/Castwright/issues/2003), [#1987](https://github.com/dudarenok-maker/Castwright/issues/1987)) · **Kokoro weights present; single 8 GB card is enough**

PR #2032 (hardened further by the independent pre-merge review that produced
this row) closes three "a gate that silently stopped asserting" defects in
`server/tts-sidecar/tests/golden/compare.py`'s bless guards and in
`test_golden_regression.py`'s `_make_kokoro`. All three files' pure-function
gating tests (`test_golden_compare.py`, `test_instruct_bless_gating.py`,
`test_make_kokoro_gating.py`) are mutation-verified and run in the fast
`test:sidecar` tier — but two behaviours only a real bless run against real
weights can prove, and neither was exercised on real hardware for this PR:

- **A guard that never blocks honest work.** Every guard added/hardened here
  (`bless_guard`'s G1/G2, `bless_guard_thresholds`'s tolerances check and its
  new `previously_blessed` disambiguation) is proven only against synthetic
  fixtures. The thing that would make it a *rubber stamp in the other
  direction* — refusing a bless that changed nothing real, or demanding
  `GOLDEN_REBLESS_THRESHOLDS=1`/`GOLDEN_REBLESS_CONTENT=1` on a routine,
  uncontended re-bless — has never been observed end to end.
- **`_make_kokoro` against a real `KokoroEngine`.** `test_make_kokoro_gating.py`
  pins the classifier wiring (`synthesise_or_skip` / `prereq.py`) with a
  stubbed engine; #1987's actual claim — a genuine CUDA/model-corruption
  failure during Kokoro warm-up now FAILS the test instead of reading as a
  green SKIP — has not been forced against the real engine.

- **Prerequisite:** Kokoro weights installed
  (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx` +
  `voices-v1.0.bin`), sidecar venv bootstrapped. A single 8 GB card is
  sufficient (Kokoro is the ~1 GB fallback engine); CUDA is not required —
  `ASR_DEVICE=cpu`/CPU Kokoro also exercises this.
- Run `npm run test:golden-audio -- --bless --sidecar-only` on a clean,
  **uncontended** box (check `nvidia-smi` first — this PR's `--bless`
  contention warning should print nothing). Confirm it completes and writes
  `kokoro-baseline.json` / `instruct-baseline.json` **without**
  `GOLDEN_REBLESS_CONTENT=1`, `GOLDEN_REBLESS_THRESHOLDS=1`, or
  `GOLDEN_REBLESS_MEASUREMENTS=1` set on a routine, uncontended re-bless.
  **Amended by #2045 F1/F2, then again by #2060/#2061/#2062/#2069** (the
  `identity`/`loudness_dbfs` guard, added by #2035 after this row was
  written, was noise-tolerant-and-WRITTEN as of #2045; #2060/D4 later
  changed the WRITE side, not the accept side): `kokoro-baseline.json`'s
  `transcript`/`text_edits`, `instruct-baseline.json`'s `tolerances` block,
  AND — since #2060/D4 — `instruct-baseline.json`'s `identity`/
  `loudness_dbfs` figures too must ALL stay BYTE-IDENTICAL on a routine
  re-bless (or the guard is broken). "Figures MAY move by run-to-run
  noise" was true before D4 and is **no longer a meaningful thing to
  check** — a within-epsilon noise-sized move is still ACCEPTED (not
  refused, no flag needed), it just no longer REWRITES the committed
  reference, so the file staying byte-identical is now the EXPECTED
  outcome for `identity`/`loudness_dbfs` too, not evidence on its own that
  anything happened. What real hardware is uniquely placed to confirm
  instead is the ECHO: the console should still print a `[golden-bless]
  identity moved within epsilon ... (noise -- reference unchanged) -- ...`
  / `[golden-bless] loudness_dbfs moved ...` line whenever this run's raw
  measurement differs AT ALL from the committed figure (real hardware
  noise makes a nonzero diff near-certain, even though the file itself
  won't change) — the echo is the part a `git diff` alone can't confirm,
  and it's the accept-path half of the guard real hardware is uniquely
  placed to exercise (both the ROUTINE-bless-doesn't-need-the-flag half
  AND the noise-gets-echoed-but-not-written half need a REAL measurement
  pair with real noise between them — a synthetic fixture can only assert
  the arithmetic, never that actual noise clears epsilon on a real box). A
  byte-identical block with an echo present is the guard working; a
  byte-identical block with NO echo at all just means this run's raw
  measurement happened to land exactly on the committed figure — don't
  read bare byte-identical output alone as proof the guard fired; the
  echo is the falsifiable signal. `blessed_at`-adjacent housekeeping
  fields may still move as before.
- **This run is also the only thing that retires the identity epsilon's
  open question** (#2066). `IDENTITY_COSINE_EPSILON` moved 0.015 → 0.005
  because 0.015 was derived from an unrelated ceiling (`identity_cosine_max`
  = 0.15) rather than from measured noise. 0.005 is ≈3.6× the **single**
  run-to-run delta recorded anywhere in the repo (`metadata.notes`' ~0.0014)
  — one observed figure, on one leaf, while the guard refuses on the `max`
  across five. Nothing in-repo measures the per-leaf distribution. So record
  the **actual per-leaf deltas** you observe here, not just pass/fail: if any
  single leaf routinely clears 0.005, the constant is too tight and this
  gate refuses honest work. That measurement is the deliverable.
- Then force one refusal for real: hand-edit a committed baseline to null out
  its `transcript` (or delete its `tolerances` key) exactly as a bad
  merge-resolution would, re-run the same `--bless` command, and confirm it
  refuses with the expected `GOLDEN_REBLESS_*` message and leaves the file
  byte-identical to before the attempt — then revert the hand-edit.
  This is the "#2003/#1995 shape, on a real file, via the real CLI entry
  point" check the unit tests can only approximate with `tmp_path` fixtures.
- **Amended by #2045 F1/F2, then #2060/D1:** also force one WINDOW-sized
  refusal on `instruct-baseline.json`'s `identity` block (hand-edit one
  committed `identity.cosine.<emotion>` figure by clearly more than
  `IDENTITY_COSINE_EPSILON`, e.g. +0.05), re-run the same `--bless`
  command, and confirm it refuses (not just accepts-and-echoes) with the
  expected `GOLDEN_REBLESS_MEASUREMENTS` message — **not**
  `GOLDEN_REBLESS_THRESHOLDS`, which the #2060 flag split now reserves for
  `tolerances` alone — and leaves the file byte-identical — then revert
  the hand-edit. This is the boundary the noise-tolerant epsilon exists to
  draw; the routine-bless bullet above only exercises the accept side.
- Run `npm run test:golden-audio -- --sidecar-only --engine=kokoro -m golden`
  (i.e. `test_golden_regression.py`'s real `_make_kokoro`-backed tests) once
  normally (expect pass), then deliberately break the engine (e.g. rename
  the `.onnx` weight file mid-run, or force a CUDA OOM by holding VRAM) and
  confirm the run now **FAILS** rather than SKIPping — the #1987 defect this
  PR closed. Restore the weights afterward.

*Needs:* Kokoro weights on disk, a box quiet enough that `--bless` measures a
stable, reproducible value (no concurrent GPU work), and permission to
hand-edit a baseline JSON for the refusal drill (revert before committing).
*Criteria:* this row; PR #2032's own mutation-verification table is the
synthetic-fixture half of the evidence, this row is the real-file half.
*Cost:* short — one clean bless, one deliberately-broken bless, one
deliberately-broken Kokoro run; well under an hour total.

---

### A31 · Cast-time clone-readiness gate — the fixes actually fix ([#1980](https://github.com/dudarenok-maker/Castwright/issues/1980), plan [276](../features/archive/276-cast-time-derivability-warning.md)) · **single 8 GB card + a real cloned voice**

The gate's *verdict* is heavily tested — a fixture table, a co-oracle contract
test binding it to the render's own oracle, an e2e walkthrough. What no suite
proves is that pressing the buttons **repairs the render**. Every automated
layer stops at the API response; none of them derives an artifact or synthesises
a line.

Two specific gaps, one of them structural:

- **`derive-failed` / "Retry derive" is unreachable in mock mode.**
  `mockCloneVoice` unconditionally stamps `engines.qwen.status: 'ready'`, and no
  exported mock mutator can move a slot to `'failed'`. So the e2e spec
  (`e2e/clone-readiness-gate.spec.ts`) covers `no-transcript` and the two silent
  controls and **cannot** cover this CTA at all. It is untested outside unit
  level by construction, not by omission.
- **"Add transcript" is only proven to persist.** The server test asserts the
  write; nothing asserts that a Qwen derive then *succeeds* against the
  corrected text — which is the entire premise of the CTA.

Run:

- Ingest a clip **without** a transcript, assign it while the session engine is
  Coqui (expect 200 + #1933's advisory), then switch the session engine to Qwen
  and press "Approve cast & start generating". The gate must name the character,
  Qwen, and the missing transcript, and offer **Add transcript**.
- Use the CTA. Then **render a chapter** and confirm the cloned voice actually
  speaks on Qwen — the derive succeeded against the user-supplied text. Capture
  the resolved voice key from `characterSnapshots`, not just the absence of an
  error.
- Force a genuine `failed` slot (a real derive failure — e.g. attempt a Qwen
  derive against an empty transcript on-box), confirm the gate reports
  **derive-failed**, press **Retry derive**, and confirm the predicate
  re-evaluates to the *underlying* cause (`no-transcript`) rather than reporting
  healthy. Plan 276 Decision 7 argues this is why the CTA cannot loop; nothing
  automated exercises it against a real stamp.
- **Control:** with the session engine switched back to Coqui, the same cast
  must produce **no** gate. Steps above pass equally well against a check that
  always warns.

*Needs:* the 8 GB card, a real sidecar, and a real cloned voice with a real
master clip. *Criteria:* the run sheet
[`clone-readiness-gate-onbox-acceptance.md`](clone-readiness-gate-onbox-acceptance.md);
walkthrough steps 1-7 in plan 276. *Cost:* short if it rides along with A1's
cloning session, which already stages a real clone on this card.

### A32 · Cast/analysis `characterId` drift — Wave 1 resolver ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **single 8 GB card, Qwen resident**

Wave 1 ships a **read-time** fix only: `buildCastResolver` resolves a frozen
segment's `characterId` through a separator/case normaliser before the code
falls back to the narrator. It is fully unit- and route-tested against
synthetic fixtures. What no automated suite proves is the thing the feature
is *for* — that re-rendering an already-drifted chapter on the real workspace
now puts the character's own voice on their lines rather than the
narrator's. A read-only, dry-run resolver check already ran against the real
20-book workspace (design spec §6: 68 of 188 orphaned segments recover via
the normalised-id tier alone, with an empty history) — **that measured id
resolution, not a render.** This row is the render.

Real, already-affected fixture (confirmed 2026-08-02, not synthetic):
*Playing with Fire* (Derek Landy) at `C:\AudiobookWorkspace\books\Derek
Landy\Skulduggery Pleasant\Playing with Fire`. `the-torment` (67 segments,
cast id `the_torment`, a **tuned Qwen 1.7B voice**) and `lightning-dave` (1
segment, cast id `lightning_dave`) both recover under the normalised-id
tier — RC2's underscore-vs-hyphen split. `pool-player-2` (6 segments, cast id
`pool_player`) shares chapter 16 with `lightning-dave` and is the row's
built-in **negative control**: its `-2` collision suffix must still defeat
resolution, unchanged, since that needs Wave 2/3.

- Re-render chapter 19 (`the-torment`, 37 of its 67 segments) and chapter 16
  (`lightning-dave` + `pool-player-2` together). Confirm the fresh
  `segments.json` gains a `characterSnapshots` entry for `the-torment` /
  `lightning-dave` naming their own voice (Torment's tuned
  `qwen-YaC5ot82IqTLpeDbHd77F`, not `qwen-narrator`), and that
  `renderedFallbackEngine: "kokoro"` — present on every affected segment
  today — is gone from those two.
- **Listen.** Torment's line at chapter 19 `groupIndex: 25` ("Kill the
  child.") must be audibly a different voice from the narrator, not merely a
  different id in the JSON.
- Confirm `pool-player-2` is unchanged: still `renderedFallbackEngine:
  "kokoro"`, no snapshot entry. A resolution here would mean the resolver is
  matching more aggressively than designed.
- Cross-check the Cast screen's orphaned-id banner (#2023) no longer names
  `the-torment` / `lightning-dave` for this book after the two re-renders,
  while still naming `pool-player-2`.

*Needs:* the 8 GB card, a real sidecar with Qwen resident, and the real
workspace book above (back up its two affected chapter files before
re-rendering). *Criteria:* the run sheet
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md).
*Cost:* short — two single-chapter re-renders on an already-imported,
already-analysed book.

---

### A33 · Cast/analysis `characterId` drift — Wave 3 repair pass `--apply` run ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **no GPU needed; real workspace + server stopped**

Wave 1 (A32) and Wave 2 (B3) are proven or pending against a single already-drifted
chapter/book each. Wave 3's `scripts/repair-cast-id-drift.mjs` is the pass meant
to sweep the **whole** 20-book workspace at once.

> **PARTIALLY DISCHARGED — `--apply` was run 2026-08-05** (Claude Code session on
> the dev box, dudarenok-maker), against `main` @ `f3d6ae0f`. The write path is
> now proven; **§8.7 (does the fix reach actual audio — re-render *Заказ
> Коалфолла* ch2 and listen) and §8.8 (Cast-screen banner cross-check) are still
> owed**, so this row stays open for those two. The third item this row used
> to list as owed — a fresh dry run confirming the #2107 fix's numbers — has
> since been run (read-only, never `--apply`) and is folded into the #2107
> writeup below.
>
> **What was observed.** The liveness rail refused first, against a *real*
> `npm run dev` — which bound **LAN HTTPS 8443 only, never 8080**, so it was the
> `LAN_HTTPS_PORT` half of the probe that caught it (exit 1, nothing written; a
> probe covering only the default 8080 would have missed this server). With the
> server stopped, `--apply` recorded exactly the 3 predicted aliases across
> **2** books — `mayrin → mairin`, `coalfall → coalfall-dragon` (*Заказ
> Коалфолла*), `lady-alina → dame-alina` (*Everblaze*). No other book gained a
> `cast-id-history.json` (0 → 2 workspace-wide). All **20** `cast.json` files
> byte-unchanged (md5 before/after). The immediate dry re-run showed auto-records
> **3 → 0**, skipped **0 → 3**, report-only **93 / 161 unchanged** — the write is
> durable.
>
> **Two defects filed from the run, neither blocking the write itself:**
> [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107) — **FIXED,
> then WIDENED by an independent review + owner decision**
> (`scripts/repair-cast-id-drift.mjs`, `fix/scripts-2107-rerender-rows`) — the
> re-render list dropped **17 rows / 120 segments → 13 / 93** afterwards, losing
> exactly the 27 segments the new aliases cover, whose audio is still
> narrator-substituted on disk (the list is documented as unconditional on
> auto-record status, and `120` was this row's stated damage figure at the time).
> Root cause: `collectSegmentOrphans` built its resolver WITH the on-disk
> `cast-id-history.json`, and any id that resolved via ANY successful tier hit a
> blanket `continue` — treated identically to a genuine live `'exact'` match,
> even though the `'history'`/`'normalised-history'` tiers depend on
> `supersededBy`, a table that can gain an entry (this script's own prior
> `--apply` run, here) strictly AFTER the segment's audio was frozen to disk. A
> first-round fix moved only those two tiers into `orphans`, keeping
> `'normalised-id'` exempt on the reasoning that it depends only on the CURRENT
> live cast list, never on `supersededBy`. **Independent review found that a
> non-sequitur** — it proves no *rename* happened, not that the rendered bytes
> are correct — and pointed at THIS row's own A32 evidence: *Playing with
> Fire*'s `the-torment`/`lightning-dave` both recover under `'normalised-id'`
> today, but were rendered **before Wave 1's resolver existed at all**, when
> `resolveGroup` substituted the narrator regardless of tier. There is no
> per-segment evidence on the real workspace to discriminate a genuinely-fine
> `'normalised-id'` match from a stale one — `renderedFallbackCharacterId` and
> `characterSnapshots` are absent from all 84,642 real segments, only
> `renderedFallbackEngine` (77 segments) exists — so the owner widened the fix:
> **only `'exact'` means the rendered bytes are fine; the other three tiers all
> list.** Over-reporting is the safe failure direction for a one-shot repair
> tool. This also changes what `--apply` *writes* (a related gap: the
> "already-recorded" skip compared raw strings against `supersededBy` while the
> resolver itself compares normalised — now fixed to match on the same
> footing, latent-not-live on the real workspace today). **Measured via a fresh
> dry run against the real workspace (read-only, never `--apply`):** re-render
> candidates move from 17/120 to **23 rows / 188 segments** (188 = the original
> full-workspace orphan count — the arithmetic check that this is now the
> complete set); auto-recordable aliases move from 0 (the three real aliases
> are already recorded and correctly skip) to **2 / 68 segments**
> (`the-torment`/`lightning-dave`, previously invisible under the removed
> `autoReconciled` bucket); reported-for-human-decision moves from 93/161 to
> **91 ids / 93 segments** (161 − 68 = 93 segments, 93 − 2 = 91 ids — the whole
> delta is `the-torment`/`lightning-dave` moving out of report-only). Full
> console output archived with the PR.
>
> **Fix round 2 (independent review, 2026-08-05) found two more defects in
> the #2107 fix itself, both now closed:** (1) the "already recorded" skip's
> normalised-footing fix from round 1 (`supersededByNormKey`, a hand-built
> map) was itself an instance of this wave's recurring shape — it diverged
> from the real resolver on normalised collisions, tier precedence, and dead
> alias targets, each a **false skip** that would drop an id off the
> human-decision list entirely. Deleted; the guard now asks the real,
> history-aware resolver (`historyResolver`, threaded from `main()`, not
> reconstructed) whether an id resolves via `'history'`/`'normalised-history'`
> directly. (2) the widening opened an undeclared write path: Tier A (name)
> runs before Tier B (id shape), and nothing checked a Tier A candidate
> against what the id already resolves to today — a stale cache entry naming
> a different character could repoint real segments' attribution onto the
> wrong live character, durably. A new guard withholds and reports that
> conflict instead of writing it. **Both were verified latent, not live, on
> the real workspace** — a fresh dry run (read-only, never `--apply`, same
> command as above) reports the identical **23 rows / 188 segments**,
> **2 / 68 segment** auto-recordable aliases, and **91 ids / 93 segments**
> report-only; neither real auto-record (`lightning-dave -> lightning_dave`
> Tier A, `the-torment -> the_torment` Tier B) trips the new conflict guard,
> since both already agree with their own live id-shape resolution.
>
> **Fix round 3 (independent review, 2026-08-05) found the round-2 fix
> itself defaulted fail-OPEN, closed:** `historyResolver` (threaded through
> `main()`) defaulted a missing value to `{ resolve: () => undefined }` when
> omitted — but `planBookRepairs` no longer reads `history.supersededBy`
> directly at all (that was the whole point of the round-2 fix), so a
> caller that omitted the resolver while still passing a fully populated
> `history` got **zero protection** from either guard, with no error.
> `undefined` from `.resolve()` means both "asked, nothing resolves" and
> "never asked" — the tenth instance of this wave's recurring shape, one
> level up from round 2's own fix. Measured on the round-2 conflict-guard
> probe: omitting the resolver auto-recorded a 67-segment durable repoint
> onto the wrong character; omitting it with `history.supersededBy`
> populated also went silently past the already-recorded skip. Fixed the
> same way `cacheAvailable`'s own pre-#2093 fail-open default was fixed:
> default to building the REAL resolver from the args already in scope
> (`buildCastResolver(liveCast, history)` — the identical construction
> `collectSegmentOrphans` uses), so an omitted `historyResolver` is a
> (redundant) optimisation for the production path, never a correctness
> hole for any other caller. Also printed the re-render list's segment
> total (`188`) in the summary line alongside the row count (`23`), which
> previously required an operator to sum every row by hand to get the
> figure this row's own arithmetic check depends on. **Verified latent, not
> live** — a third fresh dry run reports the identical **23 rows / 188
> segments** (now printed directly rather than hand-summed).
> [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108) — **FIXED**
> (PR #2102, before this branch was cut) — a wrong `WORKSPACE_DIR` used to scan
> **0** books and still print `books missing analysis-cache evidence: 0` and
> exit **0** from `--apply`, because the script does not read `server/.env`, so
> a bare command hits an empty `<home>/AudiobookWorkspace`. `--apply` now
> refuses outright on a zero-book scan (`shouldRefuseApplyForEmptyScan`,
> `scripts/tests/repair-cast-id-drift.test.mjs`) — this note used to still
> describe it as open; corrected here.
>
> **Revision-sensitive:** the numbers above are against the **pre-#2102** global
> cache gate. **#2102 has since landed**: `books missing analysis-cache evidence`
> now reads **1** (*Unlocked* has a cache that parses and names nobody) and
> `books with an auto-record withheld: 0` is the line that actually gates
> `--apply` (see the current dry-run figures below, which already reflect
> post-#2102 code). Note for the record that *Unlocked* is not "nothing to
> repair" — it carries **34 orphaned segments** across ch63/ch67 under
> `unknown-male`; what makes withholding safe there is that a reserved
> fold-bucket **source** is never auto-recorded regardless of evidence, which
> fires before the ambiguity veto matters at all.
>
> **Four more filed issues fixed 2026-08-05
> ([#2097](https://github.com/dudarenok-maker/Castwright/issues/2097),
> [#2135](https://github.com/dudarenok-maker/Castwright/issues/2135),
> [#2130](https://github.com/dudarenok-maker/Castwright/issues/2130),
> [#2134](https://github.com/dudarenok-maker/Castwright/issues/2134)),
> after a round-2 review caught #2134's first fix backwards:**
>
> - **#2134 round 1 (guard 4/ranker inert on drifted ids) turned
>   `classifySnapshotEvidence`'s new `'no-evidence'` outcome into a VETO —
>   round 2 review found that backwards and reverted it to an annotation.**
>   `characterSnapshots` is a file-level map written ONLY for an id that was
>   LIVE in `cast.json` at render time. Every id this loop considers is, by
>   definition, NOT live today (that is what makes it an orphan) — so for
>   this population, snapshot presence/absence is not neutral: **presence**
>   means the id WAS live at render (audio already correct, drift happened
>   after) and **absence** means the narrator was substituted (the actual
>   A32 damage this pass exists to fix). A veto on absence therefore blocks
>   exactly the aliases that repair real damage and passes exactly the ones
>   that needed no repair — replayed against the real workspace with
>   `supersededBy` emptied, the round-1 veto would have blocked **two of the
>   three aliases already applied and accepted on this box**
>   (`mayrin`→`mairin`, `coalfall`→`coalfall-dragon`) while letting the
>   already-fine `lady-alina`→`dame-alina` alias through. `'no-evidence'`
>   now flows through to auto-record, carrying an honest "guard 4 not
>   evaluable" annotation on the row and console line instead of either a
>   false claim of verification (the pre-#2134 state) or a wrong block (the
>   round-1 fix). `'conflict'` (real, disagreeing snapshot evidence for a
>   named id) is unaffected and still downgrades to report-only. **Net
>   effect: the fresh dry run's figures are IDENTICAL to the pre-#2134
>   baseline** — auto-recordable **2 aliases / 68 segments**, report-only
>   **91 ids / 93 segments**, re-render **23 rows / 188 segments** — because
>   round 1's veto and round 2's fix cancel out for this real data; what
>   changed is honesty (the console line now says plainly when guard 4 had
>   nothing to verify), not the write decision.
> - **#2097 + #2135 (evidence that can't be read must count as UNKNOWN, not
>   CLEAN) — confirmed sound by round-2 review; NOT live on the real
>   workspace today, no figure change.** `collectBooks` now counts and names
>   any dropped book (`'not-yet-analysed'` vs `'unreadable'`, the latter
>   refusing `--apply`); `collectBakNameEntries` now returns `bakAvailable`,
>   gating a per-book `withheldForMissingBak` auto-record guard the same way
>   `cacheAvailable` already gates cache. Round 2 also closed five smaller
>   gaps found by review: `collectBooks`'s shape check now uses
>   `Array.isArray`, not truthiness (a truthy non-array `characters` field
>   used to be silently accepted and later crashed `planBookRepairs`); its
>   `readdirSync` calls are now guarded the same way its bak sibling's is
>   (an unreadable author/series directory used to throw out of `main()`
>   uncaught); `collectBakNameEntries`'s `characters` field is now
>   `Array.isArray`-checked too (a string silently iterated to zero entries,
>   an object threw); and a suspected (unverified — not reproducible on this
>   box) gap where `fs.existsSync` swallows `EACCES` the same as "doesn't
>   exist" is closed defensively via a tri-state file read that
>   distinguishes `ENOENT` from every other read failure. The fresh dry run
>   reports **books scanned: 20** (no drops — every book's
>   `cast.json`/`state.json` is readable), **books with unreadable
>   cast.json.bak.* evidence: 0**, and **books with an auto-record withheld
>   for missing bak evidence: 0** — matching #2135's own real-workspace scan
>   (41 bak files, 0 unparseable). **Correction (round 3 review,
>   2026-08-05): the "confirmed sound" claim above was itself wrong.**
>   `collectBooks`'s discriminator required BOTH `cast.json` AND
>   `state.json` to be genuinely missing before granting the legitimate
>   `'not-yet-analysed'` reason — but `state.json` is written at import
>   time, before any analysis, and `cast.json` is created only later, during
>   analysis stage 1 (reparse re-creates the identical shape: it deletes
>   `cast.json` and keeps `state.json`), so a book between import and first
>   analysis has `state.json` present and `cast.json` absent — misclassified
>   as `'unreadable'`, refusing `--apply` for the entire workspace over one
>   freshly-imported, otherwise-healthy book. Fixed by judging each file
>   independently: only a file that is PRESENT but unreadable or
>   wrong-shaped counts as lost evidence; a file that is genuinely missing
>   never does, whichever file it is. **Not live on the real workspace
>   today** — none of the 20 books are mid-import — so no figure moves.
> - **#2130 (a resolver tier rename would go undetected) — relocated after
>   round 2 review found the original fix couldn't fire in CI at all, for
>   two independent reasons: the job that runs it never builds the server,
>   and (separately fatal) that job's own scope condition doesn't even run
>   on a `server/src`-only diff.** The coupling test now lives at
>   `server/src/store/cast-resolve.repair-pass-contract.test.ts`, in the
>   **server** test suite — vitest transpiles `cast-resolve.ts` straight
>   from source (no `server/dist` build needed) and that suite already runs
>   on every `server/src/` change, closing both gaps at once. Proven twice:
>   renamed `'exact'` to `'exact-id'` in `cast-resolve.ts`, ran the new test
>   with `server/dist` entirely absent (confirming no build is needed) and
>   watched it go red, then reverted. Test-only, no script behaviour change,
>   no figure change.
>
> Dry run command: `WORKSPACE_DIR=C:/AudiobookWorkspace
> CACHE_DIR=<primary-checkout>/server/handoff/cache node
> scripts/repair-cast-id-drift.mjs` (no `--apply`).

> **Further revision, #2092/#2089 Task 9 (pair-scoped reject filter):** the
> `--apply` run recorded above predates this fix and involved zero rejected
> pairs — no book in the real workspace has ever had a `rejectedPairs` (or
> even legacy id-wide `rejected`) entry, since the Cast-screen "Not the same
> character" action had not shipped to a real run of the app yet. None of the
> auto-record/report-only/skipped figures above change as a result of this
> fix. What changes going forward: the repair script's own skip used to be
> id-wide (any rejection anywhere blocked that id from ever auto-recording
> again); it is now pair-scoped, so a reject against one candidate no longer
> withholds a DIFFERENT, later candidate for the same orphaned id. This only
> has real bite once a real book has an actual rejected pair on disk — a
> future `--apply` run against a workspace with a live rejection should be
> spot-checked against this row's own "3 aliases / 93 reported / 17 re-render
> rows" baseline to confirm a since-corrected reject doesn't reappear as
> withheld.

Every number below comes from the pass's dry-run mode, which writes
nothing. No automated test can substitute for the real run: the pure helpers
(candidate ranking, ambiguity/reserved-source guards, the re-render list shape)
are unit-tested against synthetic fixtures, and the liveness probe was verified
live against dummy listeners (see `task-18-report.md`) — but nothing has ever
exercised the actual `--apply` write path against the real
`C:\AudiobookWorkspace\books` tree.

**Dry-run result (independent-review Critical C1 fix applied, re-measured
2026-08-05 with `CACHE_DIR` correctly pointed at the checkout that ran this
workspace's analysis):**

- **3 auto-recordable aliases, 27 segments** — `mayrin` → `mairin` (8 segments)
  and `coalfall` → `coalfall-dragon` (13 segments), both in *Заказ Коалфолла*;
  `lady-alina` → `dame-alina` (6 segments) in *Everblaze*. Each is an
  unambiguous, non-reserved exact name or id match with real rendered damage
  behind it. Unchanged by the round-2 fixes below.
- **93 ids reported for a human decision, 161 segments** (was misreported as
  93 segments before the round-2 fix — see below) — includes the three
  reserved fold-bucket rows a pre-review-round-1 version of the script would
  have wrongly auto-recorded: *Exile*'s `unknown-male` (21 segments, spanning
  chapters 7/33/60 — the analysis cache separately names that bucket Timkin,
  Brant, Dwarf, Rex **and** Lord Cassius across the book) and `unknown-female`
  (14 segments), plus *Unlocked*'s `unknown-male` (34 segments). The remaining
  24 (`pool-player-2` 6, `sir-harding` 1, `silveny` 17) have no usable name
  signal anywhere in the cache or a `cast.json.bak.*`. Also includes *Playing
  with Fire*'s `the-torment` (67 segments) and `lightning-dave` (1 segment) —
  A32's own already-affected fixture (above): both already auto-reconcile live
  via the normalised-id tier, so a round-2 review fix corrected their reported
  reason from the misleading "zero rendered segments — no damage to repair"
  (which contradicted the Cast banner's own auto-reconciled section for the
  same ids) to "already auto-reconciles … already fixed, no separate alias
  needed" — this is the 68-segment (67+1) delta between the old 93 and the
  corrected 161. Neither is itself damage — both already render under their
  live id today — which is why the re-render/damage total below is unchanged
  at 120: the 161 report-only figure now mixes genuinely-orphaned segments
  with a couple of already-fine ones the script merely name-matched, and is
  no longer a proxy for "segments still needing repair".
- **17 re-render rows, 120 segments** — unconditional on auto-record status;
  writing an alias fixes metadata attribution, not the audio bytes already on
  disk. This, not the report-only total above, is the actual damage figure.
  **Superseded (#2107, widened by independent review + owner decision,
  2026-08-05, after the write below) — see the PARTIALLY DISCHARGED banner
  at the top of this row: the post-fix, post-`--apply` figure is 23 rows /
  188 segments, and `the-torment`/`lightning-dave` (68 of those segments)
  also move from "auto-reconciles, no alias needed" into a genuine 2-alias
  auto-record.** This bullet is left as originally measured — it was the
  pre-`--apply`, pre-#2107-fix baseline and is still accurate as that.
- **0 books modified, 0 `cast-id-history.json` files written** — confirmed by
  a workspace-wide file search before and after every dry run.
- **1 book missing analysis-cache evidence, 0 books with an auto-record
  withheld because of it** — these are now two DIFFERENT numbers (owner-
  decided policy, review round 2, 2026-08-05), and **only the second one
  gates `--apply`**. *Unlocked*'s cache file
  (`server/handoff/cache/mns_dLurz4I544.json`) exists and parses as valid
  JSON, but names **zero** characters (neither `stage1.characters` nor any
  `chapterCast` entry — both are optional per the schema, and this file
  happens to have neither populated) — found by independent review (Critical
  C1) after the #2093 residual-1 fix first shipped gating only on "exists and
  parses": the cross-source ambiguity veto doesn't consume "did it parse", it
  consumes the cache's actual name/id entries, so a validly-parsing,
  evidence-free file is exactly as blind to the veto as a missing one.
  `isCacheAvailable` now also requires at least one name/id entry that
  `buildNameIndex` itself would keep, not merely one `cacheEntriesOf` treats
  as string-shaped (pre-merge review I1 closed a further gap — an entry
  like `{id:"sandor", name:""}` used to pass the raw `cacheEntriesOf` check
  while `buildNameIndex`, what guard 2 actually reads, silently drops it;
  zero of the real workspace's 80 cache files exhibit this shape today).
  Re-measuring the SAME real cache directory (76 files parse, 0 unparseable,
  10 parse with zero character entries) surfaces this one book. **This is
  expected and does NOT block `--apply`** — but **not because *Unlocked* has
  nothing orphaned.** It does: **`unknown-male`, 34 segments across ch63/ch67**
  (confirmed both by a live pre-merge-review scan and by the real `--apply`
  run above). The reason it doesn't block: `unknown-male` is a **reserved
  fold-bucket SOURCE id**, and guard 1 refuses to auto-record from a
  reserved source unconditionally, firing *before* the cache-availability
  gate is ever reached — so *Unlocked*'s blind ambiguity veto never actually
  stood between the pass and a real candidate. `--apply` refuses only when a
  book's blind veto DID withhold a real candidate — that count is separately
  reported and currently reads `0`. The trigger that WOULD change this: a
  **non-reserved** orphaned id in *Unlocked* with a real Tier A/B name/id
  match (from a future re-render or re-analysis) — and, per pre-merge review
  I2, a match with **zero rendered segments** would NOT trigger it either
  (guard 3 refuses those regardless of cache evidence, before the cache gate
  is reached). Re-check before trusting the `0` if *Unlocked* changes.

- **Precondition: `CACHE_DIR` must point at the real analysis cache**, not a
  fresh worktree's own (git-ignored, per-checkout — see the script's module
  doc comment). Run the dry run first and confirm the summary reads `books
  with an auto-record withheld for missing cache evidence: 0` — `--apply`
  now refuses outright otherwise (round-2 review fail-closed fix for the
  cross-source ambiguity veto's blind spot when cache evidence is absent;
  #2093 residual 1, strengthened by independent-review Critical C1,
  tightened `isCacheAvailable` to require the file exist, parse, AND name at
  least one character; then re-scoped by owner-decided policy, review round
  2, so the refusal gates on an actual withheld candidate, not merely a book
  whose cache happens to be unusable). **A nonzero `books missing
  analysis-cache evidence` count is expected and does NOT by itself block
  `--apply`** — as measured today it reads `1` (*Unlocked*, see above), while
  the gating `books with an auto-record withheld…` line reads `0`, so this
  precondition IS currently satisfied. Don't stop just because the first
  number is nonzero — check the second one.
- **Precondition (#2108): `WORKSPACE_DIR` must actually point at the real
  20-book workspace.** Confirm the summary reads `books scanned: 20`
  alongside the cache-evidence lines above — a wrong `WORKSPACE_DIR` (the
  script defaults to `<home>/AudiobookWorkspace`, which does not exist)
  scans **0** books and, before this fix, printed a clean-looking `books
  missing analysis-cache evidence: 0` and exited `--apply` with code `0`
  having written nothing — an empty tree reading as a healthy one, on
  exactly the line this precondition told the operator to trust. `--apply`
  now refuses outright when `books scanned` is `0`, and the dry-run summary
  calls out a zero-book scan explicitly instead of rendering a row of clean
  zeros.
- Stop any real server bound to the configured probe port(s) (default `8080`
  and the LAN HTTPS `8443`) **or their auto-rebind range** (up to 19 ports
  above each default, matching `listenWithAutoRebind` — #2090) — `--apply`
  refuses outright while any of them answers, since the write is
  out-of-process and no in-process lock covers it. Confirm
  the refusal fires first, against the *real* dev server (not only a dummy
  listener): start `cd server && npm run dev`, run `--apply`, confirm it exits
  1 naming the reachable port and writes nothing, then stop the server.
- Run `cd server && npm run build`, then
  `node scripts/repair-cast-id-drift.mjs --apply` against the real workspace
  with the same `WORKSPACE_DIR`/`CACHE_DIR` as every prior dry run.
- Confirm `.audiobook/cast-id-history.json` now exists for *Заказ Коалфолла*
  with `supersededBy` containing `mayrin: "mairin"` and
  `coalfall: "coalfall-dragon"`, and for *Everblaze* with `supersededBy`
  containing `"lady-alina": "dame-alina"` — and that **no other book** in the
  workspace gained a `cast-id-history.json` file.
- Confirm every book's `cast.json` is byte-unchanged (mtime + diff) — the pass
  writes only the history side-table, never the cast itself.
- Re-run the script in dry-run mode immediately after. Confirm the three
  now-recorded aliases no longer appear in the auto-record list (already
  resolved through the history) and the 93 report-only ids are unchanged —
  proving the write was durable, not merely printed once.
- Re-render *Заказ Коалфолла* chapter 2 (the `mayrin`/`coalfall` orphaned
  chapter) and confirm the same shape A32 pins: the fresh `segments.json`
  gains `characterSnapshots` entries for `mayrin`/`coalfall` naming Мэйрин's
  and Коалфолл's own live voices, not the narrator — **listen** to confirm
  audibly, not only from the JSON.
- Cross-check the Cast screen for both affected books: the auto-reconciled
  section now names `mayrin`/`coalfall`/`lady-alina`; the needs-your-decision
  section still names the 93 remaining ids untouched by this run (spot-check
  `unknown-male` in *Exile* as the negative control — a reserved-bucket source
  must still refuse to auto-record, unchanged).

*Needs:* no GPU or TTS engine — the pass itself only reads the analysis cache
and any `cast.json.bak.*` files and writes `cast-id-history.json`. Needs the
real 20-book workspace, a completed `server` build, and the ability to stop any
locally-running Castwright server for the duration of the `--apply` call.
Re-rendering the confirmation chapter needs the 8 GB card + Qwen resident, same
as A32. *Criteria:* the run sheet
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md) §8
(Wave 3). *Cost:* short — one script invocation against an already-imported,
already-analysed workspace, then one chapter re-render.

### A34 · Supervisor respawn survives a refused spawn attempt ([#2037](https://github.com/dudarenok-maker/Castwright/issues/2037)) · **single 8 GB card, live sidecar**

Unit tests (`server/src/tts/sidecar-supervisor.test.ts`,
`server/src/tts/spawn-sidecar.test.ts`) fully pin the fix's logic: a refused
spawn attempt — a foreign-looking listener on the port, most commonly the
just-exited child's own socket still in TCP teardown — now feeds the same
backoff/cap budget an ordinary child exit already uses, instead of the old
unconditional `isRecycling = false` that silently ended supervision. What no
unit test can reach is the *real* race: whether a real OS socket actually
stays bound for a real window after the child process exits, and whether the
fix's backoff schedule (`[2s, 5s, 15s]`, capped at 5 attempts ≈ 52s total)
outlasts that window on real hardware — the reported incident measured the
port still held 4s after exit and free only "minutes later," and the
implementation brief deliberately declined to widen the backoff without a
real measurement behind it (D1).

- With a chapter actively rendering, kill the sidecar's OS process directly —
  **not** via `POST /api/sidecar/restart` (see the note below) — e.g.
  `taskkill /PID <pid> /T /F` against the pid in `.run/tts.pid`, or end the
  process from Task Manager.
- Grep the running server's own log for a fresh `[sidecar] spawned pid=` line
  appearing on its own, with no operator action, within the backoff window.
  Confirm the pid differs from the one killed.
- While recovery is in flight, poll `GET /api/models/status` and confirm it
  never reports the TTS engine ready while no sidecar is listening on
  `:9000` — that silent "reports healthy while nothing is there" gap is
  exactly what #2037 shipped.
- Confirm the in-flight chapter either rides out the respawn (existing retry
  behaviour) or fails cleanly and is resumable — not stuck forever.
- If the box's real teardown-to-free window turns out to exceed the ~52s
  backoff budget, that is a follow-up issue with a real measurement behind
  it, not a reason to widen the backoff on the strength of this run alone.

**Do not use `POST /api/sidecar/restart` to check this** — it restarts the
sidecar itself rather than passively observing it, which is the same
operational trap that produced the #2037 outage in the first place.

*Needs:* a live sidecar, a book mid-render, and OS-level process-kill access.
*Criteria:* the acceptance bullets above; the code-level contract is
`scheduleRespawnAttempt` in `server/src/tts/sidecar-supervisor.ts` and
`onSpawnRefused` in `server/src/tts/spawn-sidecar.ts`. *Cost:* short — one
kill, one log grep, one status poll.

### A35 · Design-wins VRAM contention timeout is sized against a REAL 0.6B cold load ([#2070](https://github.com/dudarenok-maker/Castwright/issues/2070)) · **single 8 GB card**

Unit tests (`server/tts-sidecar/tests/test_design_contention.py`) fully pin
the logic with a simulated `_design_in_flight` claim: `unload_design()` now
waits (bounded, 150s) for an in-flight design to clear instead of nulling it,
and raises a typed `DesignContentionTimeoutError` if the wait expires. What no
unit test can reach is whether 150s is actually the right bound against a
REAL cold 0.6B Base load plus a real VoiceDesign forward on this box — the
figure was sized off the design path's own documented ~120s server budget,
not a fresh on-box measurement of the specific race window #2064's review
flagged.

- Start a voice design (cast review → Design a new voice), and — timed to
  land mid-design, before the design's own forward completes — trigger an
  ordinary chapter render on a *different* voice from another tab/session.
  Confirm the render's synth call **waits** for the design to finish (no
  error, just a delayed start) rather than the design failing with "VoiceDesign
  model was unloaded before this design could render."
- Confirm the design itself completes normally and its audition plays.
- If practical, force a genuinely wedged design (e.g. a killed/hung sidecar
  thread while `_design_in_flight` is still claimed) and confirm the waiting
  synth times out into the new `design_in_flight` 503 rather than hanging
  forever — and that it does so somewhere in the 150s neighbourhood, not
  immediately and not never.

*Needs:* a live sidecar with Qwen VoiceDesign installed, and a way to trigger
two overlapping requests (a second browser tab/session is enough). *Criteria:*
`unload_design`'s docstring in `server/tts-sidecar/main.py`; the sizing
rationale is in the `_DESIGN_CONTENTION_WAIT_S_DEFAULT` comment immediately
above `class QwenEngine`. *Cost:* short — one overlapped request pair.

### A36 · ASR warm-reservation figure vs. a real resident `/transcribe` peak ([#2094](https://github.com/dudarenok-maker/Castwright/issues/2094)) · **`ASR_DEVICE=cuda`, single 8 GB card**

Unit tests (`test_footprints.py`, `test_transcribe_embed_admission.py`,
`test_asr_footprint_measurement.py`) pin that a resident ASR reservation now
books the separate `asr.warm` key (128 MB seed) instead of the cold `asr` key
(400 MB), that `admit()`/`reservation()` agree, and that the MEASUREMENT
mechanism itself (a device-wide free-memory delta via
`PlacementController._device_free_mb`, not the torch-allocator peak
CTranslate2 sits outside of) is real and correctly guarded against
contamination — all proven with a scripted `_device_free_mb` sequence, no
real allocator. Not yet observed: whether 128 MB is actually enough headroom
for a real resident Whisper `base`/int8_float16 forward's activation memory
on a contended card (too low → a real, avoidable `noCapacity` refusal that
this fix was supposed to eliminate), and whether the learned `asr.warm` p95
converges to something sane once real device-wide-free-memory observations
accumulate on a box that ISN'T contended by a foreign process (the one
contamination vector `ledger.engines_holding` can't see, since it only knows
this process's own reservations).

- With `ASR_DEVICE=cuda` and content-QA enabled (`SEG_ASR_ENABLED=1`), render
  a chapter so ASR loads and goes resident, then trigger several more
  `/transcribe` calls back-to-back (a re-record round is the natural trigger).
  Confirm none of them 503 `noCapacity` on a card that has genuine room.
- Watch `FootprintTable`'s learned `asr.warm` p95 settle after ≥5 real
  observations (`_FOOTPRINT_MIN_SAMPLES`) — record what it converges to, so
  the 128 MB seed can be revisited with evidence rather than left as a guess
  indefinitely. A sane figure (double digits to low hundreds of MB) confirms
  the measurement mechanism is producing real signal on a clean box; a
  suspiciously large one (hundreds of MB to GB) points at contamination the
  ledger-based guard couldn't see (a process outside this sidecar).
- The device-wide contamination question #2094's own filing raised is now
  PARTIALLY addressed (the ledger-based guard discards a reading when another
  SIDECAR engine holds a concurrent reservation) but not fully closed — a
  foreign, non-sidecar process on the same card remains invisible to it. This
  row is where that residual gets its first real evidence.

*Needs:* `ASR_DEVICE=cuda`, `SEG_ASR_ENABLED=1`, a real book render with
content-QA on, ideally on an UNCONTENDED card (no other process holding VRAM)
for the cleanest read. *Criteria:* the `asr.warm` seed comment in
`SEED_FOOTPRINTS_MB` and `_device_free_mb`'s docstring (`server/tts-sidecar/main.py`)
and `docs/local-llm.md`'s footprint table. *Cost:* short — rides along with
any other GPU-ASR session (A20 already needs `ASR_DEVICE=cuda`-adjacent
capacity behaviour; batch together).

### A37 · Catastrophic-WER override actually catches a real Coqui language-collapse ([#2055](https://github.com/dudarenok-maker/Castwright/issues/2055)) · **Coqui/XTTS resident, ASR content-QA on**

`classifyTranscript`'s new logic is fully pinned in
`server/src/tts/segment-asr-qa.test.ts` with injected transcripts/signals — a
FLUENT, full-length, catastrophically-wrong-content transcript (WER ≥
`Math.max(catastrophicWer, maxWer)`) now overrides the "untrustworthy →
inconclusive" backstop into `drift`, while a near-empty/filler-padded
transcript, a short (<6-word) reference, and a merely-imperfect transcript are
all unaffected — each shape independently mutation-verified, including a
Russian near-silence-hallucination repro (`"Продолжение следует"`) invisible
to the English-only `HALLUCINATION_PATTERNS` list. Not yet observed: whether
this actually fires on a REAL #2026-style Coqui language-collapse (fluent
audio, wrong language, plausible duration) without a real false-positive rate
that starts re-recording perfectly good lines — `CATASTROPHIC_WER` (default
0.85, now the live registry knob `qa.asr.catastrophicWer` — retunable from
this row's own findings without a release), the 6-word reference floor, and
the 0.5 heard/expected ratio floor are all judgement calls, not
on-box-measured constants.

- With ASR content-QA on (`SEG_ASR_ENABLED=1`) and a Russian (or French/
  Spanish) book on the Coqui engine, reproduce #2026's language-collapse per
  its own repro recipe (short Russian lines, repeated synthesis — intermittent,
  not every run). Confirm a genuine collapse now gets caught and re-recorded
  (segment carries `asr.verdict: drift`, reason mentioning "catastrophically
  wrong"), where before this fix it would have read `inconclusive` and shipped
  unflagged.
- Across the same render (or a longer, healthy-content one), confirm the new
  override does **not** fire on ordinary hard-to-transcribe-but-correct lines
  — an invented character name, a foreign phrase, background noise — i.e. no
  new false-positive re-record rate versus the pre-#2055 baseline.

*Needs:* a Coqui-capable sidecar, ASR content-QA enabled, a non-English book
(Russian ideal — matches #2026's own repro). *Criteria:* the `CATASTROPHIC_WER`
comment in `server/src/tts/segment-asr-qa.ts`; #2026's own repro recipe.
*Cost:* short-to-medium — the collapse is intermittent, so budget a few
repeated renders of the same short lines, not one pass.

---

## Group B — local Ollama analyzer only

A real Ollama daemon and a long (~110k-char) chapter. No TTS engine resident. B1 and B2 each have a **CPU-only sub-case** — the only checks here that want the analyzer *off* the GPU. Run those two together, and consider folding in E4. B3 uses its own real book fixture instead of the generic chapter and has no CPU-only case.

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

### B3 · Cast/analysis `characterId` drift — Wave 2 stops new drift ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md))

Wave 1 (A32 above, in Group A) resolves drift that already exists, at render time. Wave 2 stops a re-analysis from **creating** new drift in the first place — the row above proves nothing about it, since Wave 1's own gate scan found the whole session left `cast.json` and `cast-id-history.json` untouched (no book was modified, no history file written). Six changes ship together: every id-retiring code path now funnels through a single `retireCharacterId` choke point, so `.audiobook/cast-id-history.json` is actually populated in production for the first time (it was always empty before Wave 2); a new early remap pass on both analyzer paths makes a fresh roster **adopt** the existing cast's id for a character it already holds under a different id, before anything is persisted; the merge's name-fallback now also matches an unvoiced character whose analyzer id drifted, not only a voiced or reused one; `cast-create.ts` mints ids with the shared `safeId` instead of a private underscore slugifier, closing RC2; and a fresh roster that reclaims an id the history covers drops that entry rather than silently rerouting it. None of it can be proven without a real analyzer minting a genuinely non-deterministic id across two runs of the same manuscript — the exact behaviour `merge-analysis-cast.ts:136-140`'s own comment names (the dragon relabelled `coalfall` → `coalfall-dragon` between two analyses of the same book) and that the design's evidence table (§1.1) reproduces letter-for-letter.

**Real, already-affected fixture:** *Заказ Коалфолла* at `C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ Коалфолла`. Its `cast.json` holds `mairin` (Мэйрин), `coalfall-dragon` (Коалфолл) and `brann-weir` (Бранн) today (confirmed 2026-08-04, 13 characters total) — while a chapter rendered off an earlier analysis-cache pass already carries the letter-level variants `mayrin` (8 segments) and `coalfall` (13 segments), part of the 188-segment corpus and, per design §6, **not** recoverable by Wave 1's normalised-id tier (`mayrin` vs `mairin` differ by more than separator/case). No `.audiobook/cast-id-history.json` exists for this book yet (confirmed 2026-08-04) — Wave 2 has never run against it.

- Record, before re-analysing: `cast.json`'s id for Мэйрин (`mairin`) and Коалфолл (`coalfall-dragon`), and that `cast-id-history.json` is absent.
- Re-analyse the book (a full re-analysis, not a subset pass — the early remap ships on both paths, but only the full path is exercised by simply re-running analysis on an unedited manuscript).
- After: `cast.json`'s ids for Мэйрин and Коалфолл are still `mairin` / `coalfall-dragon` — **unchanged**, even though the analyzer is free to mint a different string this run, exactly as it minted `mayrin` / `coalfall` on the run that produced the already-orphaned segments. That is the proof the id was *kept*, not merely re-minted and left to drift again.
- If the analyzer's fresh id for either character genuinely differs from the cast's this run (it may not — the model is non-deterministic in both directions), `.audiobook/cast-id-history.json` now exists and its `supersededBy` map records `<fresh id>: "mairin"` (or `"coalfall-dragon"`) — proving the retirement went through `retireCharacterId` rather than being silently dropped, the exact failure mode design §4.1's table catalogues five instances of.
- Spot-check the rest of the roster (13 characters) is otherwise intact — no duplicate row, no character silently renamed onto another's id.

*Needs:* a real analyzer (local Ollama or Gemini) and the real workspace book above — no TTS/GPU rendering is required for this row's own criteria. *Criteria:* the run sheet [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md) §7 (Wave 2). *Cost:* short — one re-analysis of an already-imported book, then a diff of two small JSON files.

### B4 · Cast merge-base staleness detection is real, not mocked (PR [#2185](https://github.com/dudarenok-maker/Castwright/pull/2185), closes [#2155](https://github.com/dudarenok-maker/Castwright/issues/2155), refs [#2015](https://github.com/dudarenok-maker/Castwright/issues/2015))

The route-level controls in `server/src/routes/analysis.merge-base-detect.test.ts` mock the analyzer and drive three stub chapters through the full write path in about a second — proving the mechanism wires correctly, not that it behaves sanely against a real multi-chapter book, a real analyzer, and a genuine concurrent cast edit landing mid-run. Two things are structurally unprovable from that harness: whether an uncontended real analysis run reports **zero** false positives across its (more numerous, differently-timed) real merge-base writes, and whether one genuine concurrent edit is detected **exactly once** — not zero, not several.

- Run a full analysis on a real multi-chapter book with **no concurrent editing** and confirm **zero** `cast_merge_base_stale` advisories appear on the SSE stream (and in the server log).
- Repeat on a real multi-chapter book while **deliberately editing the cast mid-run** — e.g. add an alias to an existing character from the cast UI while analysis is still in flight — and confirm **exactly one** `cast_merge_base_stale` advisory appears, with the server log line naming the expected/observed fingerprints (`describeFingerprintForLog`).

*Needs:* a real analyzer (local Ollama or Gemini) and a real multi-chapter book — no TTS/GPU rendering required. *Criteria:* the design at `docs/superpowers/specs/2026-08-06-cast-merge-base-serialise-and-detect-design.md` §4 (the staleness-visibility deliverable) and the plan `docs/superpowers/plans/2026-08-06-cast-merge-base-serialise-and-detect.md`. *Cost:* short — one uncontended run, one contended run.

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
