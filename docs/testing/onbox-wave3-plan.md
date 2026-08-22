# On-box wave-3 plan — the plan of record for steps 2–8 of #2497

> **Plan of record for wave 3.** Step 1 of 10 for #2497 (parent #2497, itself
> chained off #2453/#2464's wave-2 sitting plan). Re-derives, from primary
> sources, which of wave 2's 21-row "agent-runnable" set
> (`docs/testing/onbox-sitting-plan.md` §2.2) actually is agent-runnable, and
> assigns each row to exactly one of steps 2–8 in this chain, or to OPERATOR
> (a wave-2 sitting pack).
>
> **This step runs nothing.** It edits no register, no live-view HTML, no
> staleness audit, no sitting plan, no sitting pack. Those files are read-only
> inputs here.

---

## 0. Re-derivation date and method

**Re-derived 2026-08-20.** Every citation below was re-read directly against
the live tree at that date (`docs/testing/onbox-acceptance-register.md`,
current `HEAD` in this worktree — no cached/summarised copy), following
`onbox-sitting-plan.md` §6's re-resolution rule (the A2 false-`grep` incident
is why that rule exists, and it binds this step too). Two GitHub lookups were
run live on 2026-08-20 (§7, §4.6) rather than trusted from the register's own
prose, because both are the kind of fact that goes stale between the register
being written and this step running.

---

## 1. The 21 rows — owed text, prerequisite, verdict

Every "remains owed" cell is quoted **verbatim** from
`docs/testing/onbox-acceptance-register.md`, with its line number in this
worktree's copy of that file. Paraphrase is not used anywhere in this table —
where the owed text is long, the quote is the operative sentence(s), not the
row's full narrative.

| Row | What remains owed (register quote, line) | Real prerequisite | Verdict |
|---|---|---|---|
| A27 | "That state cannot be manufactured in CI: every test here injects the flag, so what is proven is the plumbing from `/health` to the badge, not that a genuinely broken install actually produces `false`..." (L1195-1198) | Sidecar venv (throwaway copy fine — the row breaks an import by editing `__init__.py` in place, never touches the live venv if run against a copy), sidecar process restart, no GPU. | **Agent-runnable** |
| A29 | "...the full failure mode needs the real sidecar + a real Hugging Face download to observe end to end, which no unit test can substitute for." (L1371-1372) | Sidecar venv + `server/.env` edit + Advanced Configuration reach (server API, no browser judgement needed — outcomes are `/health` JSON, Model Manager sizing/path strings, and installer log lines) + a real Hugging Face download of an ASR model. No GPU. | **Agent-runnable** |
| A33 | "PARTIALLY DISCHARGED — `--apply` was run 2026-08-05... The write path is now proven; **§8.7 (does the fix reach actual audio — re-render *Заказ Коалфолла* ch2 and listen) and §8.8 (Cast-screen banner cross-check) are still owed**..." (L1623-1627) | A live TTS render (real audio) + human listening (§8.7) and a live browser session on the Cast screen (§8.8). | **OPERATOR** — see §2 adjudication below. |
| A39 | "...every other row here starts from an already-bootstrapped venv (self-heal) or a deliberately broken one (clobbered), neither of which exercises `installForProfile`'s write branch on a first-ever install." (L2226-2228) | "Wipe (or freshly clone into) the sidecar venv" (L2230, row's own words — throwaway copy explicitly sanctioned) + NVIDIA GPU box for the `pip check`/Kokoro-provider report. No live interaction beyond a CLI bootstrap run. | **Agent-runnable** |
| A40 | "...it has not been separately re-confirmed since the fix landed (the self-heal proof in §5 exercises boot, not an in-app package install)." (L2245-2247) | A bootstrapped sidecar venv (must be a throwaway copy per box-safety — the row does not say so explicitly, but it drives an in-app package install that writes to the venv, so the absolute "never modify the live sidecar venv" rule forces a copy here even though the row's own tag doesn't call it out) + the app running on an NVIDIA box. Outcomes are exit-code/log/`.dll`-presence and a provider-string check — no subjective judgement. | **Agent-runnable** (see step-2 precondition note) |
| A41 | "...has never run against a **real** clobbered venv — a box where the GPU distribution's dist-info survives... while the actual files on disk are the CPU build." (L2266-2270) *(citation as re-derived 2026-08-20; the register's own text was later found backwards here — GPU files own the namespace, not CPU — and corrected. Superseded, not re-derived here — see the register's current A39 row.)* | "Manufacture the state deliberately, **on a copy of the venv** or with the intent to run the repair command afterward (this is destructive...)" (L2272-2273, row's own words — copy explicitly sanctioned). NVIDIA box. Outcomes are log lines and `pip check` exit codes. | **Agent-runnable** |
| A42 | "...real `spawn`, a real `venvDir`, and a real packaged release directory have never driven it. A genuinely different consumer of the same `planOrtSwap` output than `bootstrap-venv.mjs` (A39)..." (L2303-2306) | A real **installed release directory** (`release/` layout, not the dev checkout, not `server/tts-sidecar/.venv`) — this is a separate directory from the live sidecar venv, so no box-safety conflict even without an explicit copy note. NVIDIA box. | **Agent-runnable** |
| A43 | "#2238's acceptance criterion 5 — *'`repair-cast-id-drift.mjs`'s "reported for human decision" count drops by each id **linked through the UI**, verified by a dry run before and after on a real book'* — cannot be proven in the PR." (L2332-2336) | Steps 1 and 4 (dry-run counts) are script-only. But the criterion is explicitly "linked through the UI": steps 2-3 require opening `#/books/<id>/cast` in a real browser, picking a character in "Compare against…", pressing "Link to this character", and reading the row move from "needs your decision" to "auto-reconciled" in the rendered page. The negative case (step 5) also needs the disabled-button-with-reason state observed in the rendered UI. | **OPERATOR** — see §2 adjudication below. |
| B1 | "Six steps (`:124-142`). A per-phase Gemini recitation-block falls back to local Qwen with chip, swap, ticker and log all agreeing..." (L2525-2531, whole row is owed — no prior discharge language) | A local analyzer (Qwen via Ollama or Gemini fallback), a real long chapter (~110k chars) to analyze, and a dense single-paragraph chapter fixture. CPU-only sub-case included. No GPU strictly required (local Qwen can run CPU-bound, row explicitly notes the CPU-only ETA-seed case). No browser judgement — ETA/ticker state is API/log-observable. | **Agent-runnable** |
| B2 | "**Eight** steps at `:242-299`... **Step 4 is the regression worth confirming:** with keep-alive at `0`, the model stays pinned during a run..." (L2535-2539) | Model Manager reachable (API), `ollama ps` in a terminal, a real analysis run. CPU-only sub-case (RAM_HEAVY_MODELS clamp) included. | **Agent-runnable** |
| B3 | "None of it can be proven without a real analyzer minting a genuinely non-deterministic id across two runs of the same manuscript..." (L2549, final sentence) | A real analyzer (local Ollama or Gemini) + the real workspace book *Заказ Коалфолла*. "No TTS/GPU rendering is required for this row's own criteria" (L2559, row's own words). Server must be reachable to trigger re-analysis; no browser judgement (diff of two JSON files). | **Agent-runnable** |
| B4 | "...only a real analyzer on a real non-English book can show the roster comes back in Cyrillic." (L2566, final sentence) | Folds into B3's re-analysis session (row's own instruction, L2568) — same real analyzer + same *Заказ Коалфолла* run, no extra cost. | **Agent-runnable** |
| C1 | "**What remains** is the systems property no unit test reaches: re-analyze end to end on `gemma-4-31b-it`... and confirm the book **completes** with no dropped chapters and no hang under real throttling..." (L2701-2705) | Cloud analyzer only (`GEMINI_API_KEY` already configured in `server/.env`) — **no local GPU**. "Run it against a throwaway re-import, not the library book" (L2730, row's own words — explicit throwaway-safe instruction, satisfies "never mutate real book data"). Hours of wall-clock under real rate-limiting. | **Agent-runnable** |
| C2 | "**What is still owed:** ...Re-run Ночной дозор analysis and confirm: `[analysis:structure]` log lines show `unresolved=` populated..." (L2757-2764) | Local Ollama (`qwen36-cw-iq4-32k`), "~14 GB VRAM free" (L2775, row's own words — this directly contradicts the wave-2 §2.2 summary's blanket "no GPU" framing for the 21-row set; flagged, not silently trusted, same shape as the A16 correction). Blocked: see §4.6. | **Agent-runnable, currently blocked** (§4.6) |
| C3 | "**What is still owed** is the premise underneath all of that: *that a real model, degenerating deterministically on a real span, produces a different answer when the span is halved.*" (L2786-2789) | Same local-Ollama/VRAM session as C2 — "it batches with the C2 re-run... this row needs no session of its own" (L2826-2829). Blocked: see §4.6. | **Agent-runnable, currently blocked** (§4.6) |
| C4 | "Replaying the metric over all 82 cached analyses on this box found **exactly one** with an evaluable speech population... No offline work can widen this — a second dash-language book has to be imported." (L2835, final sentence) then "**Observe, on a real local re-analysis:**" (L2837) | "Hardware prerequisite: no GPU needed — local Ollama analyzer only, as with the rest of Group C" (L2844, row's own words — itself in tension with C2/C3's explicit VRAM figure two rows up; both are quoted here rather than one being silently preferred). "Best taken in the same session as C2/C3" (L2844). Blocked: see §4.6. | **Agent-runnable, currently blocked** (§4.6) |
| E7 | "No automated test has ever driven this component from a real bootstrap job, which is precisely how the bug survived in the first place." (L3064-3065) | "Needs a box with **no** `server/tts-sidecar/.venv` (delete it, or a fresh clone). Any machine, no GPU." (L3067-3068, row's own words). | **Agent-runnable** |
| E8 | "**Why owed:** the cross-build half of the design — whether L1–L3's hard assertions survive a *different* ffmpeg build — cannot be exercised on a box with one ffmpeg..." (L3094-3096) | A second machine/container with a different `ffmpeg` build on PATH, `npm run test:golden-audio:assembly`. No GPU, no browser. | **Agent-runnable** |
| E11 | "**Still owed:** (2) the dash-stripped re-run invariance check... (3) re-analysing one book post-D18 to confirm `demotedNarrator`/`modelNarrator` actually populate outside a unit fixture. **Both need GPU/analysis time this pass did not spend**..." (L3258-3263) | Item (2) is pure script (`measure-attribution.mjs`, cache diff) — no GPU, "under 5 minutes once `server/dist` exists" (L3268). Item (3) needs a real analyzer re-run — same shape as Group B/C, shares their session rather than needing its own. | **Agent-runnable** (item 2 standalone; item 3 rides Group B/C's session) |
| G1 | "**Net: this row shrinks but does not come out.**" (L3358); "**Still unverified:** `gh issue view` actually authenticating via the injected `GH_TOKEN`." (L3335-3336) | A real quarantined flaky test in `docs/testing/flaky-register.md` (doesn't exist today) to trigger the report's non-empty-register path, **and** the live PR #2488 dependency below (§4.6/§7). No GPU, no browser — a `gh` CLI check once triggered. | **Agent-runnable, currently blocked** (§7) |
| G2 | "**Needs:** nothing beyond a real `vX.Y.Z` tag push — i.e. the next release cut." (L3442) | A real release cut (opportunistic, cannot be manufactured — box-safety forbids triggering one for test purposes; this row's own text frames it as "observed as part of a cut that was happening anyway," L3443). No GPU, no browser. | **Agent-runnable, opportunistic** (§4.6) |

---

## 2. A33 — explicit adjudication

The register (L1623-1627) reads, verbatim:

> "PARTIALLY DISCHARGED — `--apply` was run 2026-08-05 (Claude Code session on
> the dev box, dudarenok-maker), against `main` @ `f3d6ae0f`. The write path is
> now proven; **§8.7 (does the fix reach actual audio — re-render *Заказ
> Коалфолла* ch2 and listen) and §8.8 (Cast-screen banner cross-check) are
> still owed**, so this row stays open for those two."

§8.7 is "re-render *Заказ Коалфолла* ch2 **and listen**" — a real TTS render
followed by a human judgement of the audio (does the id-drift fix's write
path actually change what a listener hears). §8.8 is a "Cast-screen banner
cross-check" — a comparison performed by loading the Cast screen in a real
browser and reading its rendered state against the repair script's output.

**Listening is ears and a live render; a Cast-screen cross-check is a
browser. Neither is agent-runnable.**

**Verdict: A33 is OPERATOR.** It joins `onbox-sitting-cloning-identity.md`
(the pack already carrying A32, the Wave-1 character-identity row this row's
own text calls its nearest kin — L1619: "Wave 1 (A32) and Wave 2 (B3) are
proven or pending against a single already-drifted chapter/book each"). Step
9 of this chain (updating `onbox-sitting-plan.md`) should add A33 to that
pack's row list; this plan does not edit the sitting plan itself, per the
issue's own "not in scope."

This is deliberately the pattern for A43 too (§1 above, §3 below), not a
one-off: the register's prose is the authority on what remains owed, and
where that prose names a browser or a human sense as the remaining
prerequisite, the row is OPERATOR regardless of what the audit's summary
field or wave 2's indicative grouping said.

---

## 3. A43 — explicit adjudication

#2238's acceptance criterion 5, quoted in the register (L2332-2334):

> "`repair-cast-id-drift.mjs`'s 'reported for human decision' count drops by
> each id **linked through the UI**, verified by a dry run before and after
> on a real book"

The row's own procedure (L2342-2371) splits cleanly: step 1 (dry-run count,
server stopped) and step 4 (re-run the dry pass, diff) are pure script.
Step 5's negative case includes one script-testable half — "a direct
`POST .../link-orphan-match` with `orphanedId: "unknown-male"` must 400"
(L2362) — but the same step also requires "the link action must be
**disabled** on that row, **with a visible reason**" (L2361), which is a
rendered-page state, not an API response. Steps 2-3, which are the actual
criterion (linking *through the UI* and watching the row move from "needs
your decision" to "auto-reconciled" in the rendered Cast screen, L2352-2356),
have no API-only substitute stated anywhere in the row — the criterion's own
wording is "linked through the UI," not "linked via the endpoint the UI
calls." Hitting the endpoint directly would prove the endpoint works (which
step 5's negative case already does) but not that the UI wiring the criterion
is actually about works — a different claim.

**Verdict: A43 is OPERATOR**, on the same reasoning as A33 (§2): a browser
render-state observation is not agent-runnable. It joins
`onbox-sitting-cloning-identity.md` alongside A32 and (per §2) A33 — all
three are the same character-identity family, on the same real workspace,
naturally batchable in one sitting. Step 9 records this; this plan does not
edit the sitting plan.

---

## 4. Step assignment (steps 2-8)

### Step 2 — ORT marker family: A39, A40, A41, A42

**Preconditions:**
- [ ] An NVIDIA-capable box (the "existing NVIDIA dev box" all four rows
  name) — GPU presence is required for the `CUDAExecutionProvider` /
  `pip check` / Kokoro-provider checks, but no *interactive* GPU work
  (no live render, no VRAM contention with another resident model) —
  distinguishing this from A16's disqualifying "analyzer evicted" shape
  (`onbox-sitting-plan.md` §3).
- [ ] A39: wipe or freshly clone the sidecar venv — row's own words permit a
  throwaway copy (L2230).
- [ ] A40: **must** use a bootstrapped copy of the sidecar venv, never
  `server/tts-sidecar/.venv` itself — the row installs a real package
  in-app, which writes to the venv; the absolute box-safety rule ("never
  modify the live sidecar venv") applies even though A40's own text doesn't
  flag it.
- [ ] A41: a copy of the venv, deliberately clobbered — row's own words
  permit a copy (L2272-2273 as re-derived 2026-08-20); this step is
  destructive by design, never run it against the live venv. **The specific
  recipe quoted at that citation (`pip install --force-reinstall
  onnxruntime` over an existing `onnxruntime-gpu`) was later found not to
  reach the clobbered state at all — it reaches the silent `'deleted'` path
  instead. Use the register's current A39 row for the actual recipe, not
  this citation.**
- [ ] A42: a real **installed release directory** (`release/` layout), not
  the dev checkout and not the sidecar venv — a separate directory, no
  box-safety conflict.
- [ ] No running sidecar/service is stopped or killed that belongs to
  another lane — these four rows each spin up their own throwaway
  venv/process.

**Est. running time:** A39 ~15-20 min, A40 ~15 min, A41 ~10 min (row's own
estimate, L2290), A42 ~15-20 min. **Total ~55-70 min.** Fits one heartbeat.

### Step 3 — sidecar venv install/repair + config reach: A27, A29

**Preconditions:**
- [ ] A27: sidecar venv (throwaway copy — this step edits a package's
  `__init__.py` in place to force an import failure, which must not land in
  the live venv). Keep a copy of the original file per the row's own
  instruction (L1207).
- [ ] A29: comment out `ASR_MODEL` in `server/.env` first if present
  (row's own prerequisite, L1374-1379) — a real env-var edit, on a throwaway
  checkout/worktree copy of `.env`, not a shared live one. Sidecar restart
  required (a service is stopped and restarted as part of the row itself —
  this is expected, not a violation of "never leave a server/sidecar
  stopped," since the row's own procedure restarts it every time).
  Real Hugging Face download of a non-default Whisper model (`small`).
- [ ] Neither row needs a GPU.
- [ ] Both rows leave the sidecar running when done (per the absolute
  box-safety rule) — A29 particularly, since its last steps involve
  restarts.

**Est. running time:** A27 ~20 min, A29 ~25-30 min (HF download is the long
pole). **Total ~45-50 min.** Fits one heartbeat.

### Step 4 — real-workspace scripts: E11 only

**A33 and A43, indicatively listed here by the parent issue, are ruled
OPERATOR in §2 and §3 above** and do not run in this step. They join
`onbox-sitting-cloning-identity.md`; step 9 of this chain updates the
sitting plan to add them. This step therefore shrinks to one row.

**Preconditions:**
- [ ] A checkout (or worktree with `server/handoff/cache/` populated from
  one whose cache holds the real 20-book library's analyses) — read-only
  against `C:\AudiobookWorkspace`, per the row's own "nothing written"
  discipline (L3219-3220): copy caches in if needed, delete the copies
  afterward, never write to the live workspace.
- [ ] `cd server && npm run build`.
- [ ] `WORKSPACE_DIR=C:\AudiobookWorkspace node
  scripts/measure-attribution.mjs` — item (2), the dash-stripped invariance
  check, runs twice (once straight, once over scratch-path copies of each
  cache with leading dashes stripped) and diffs every field.
- [ ] Item (3) — re-analysing one book post-D18 — is **not** run standalone
  in this step; it needs a live analyzer, so it rides whichever of Group
  B's or Group C's sessions runs first (steps 5/6) rather than spending its
  own GPU/analysis time here.

**Est. running time:** ~15-20 min for item (2) standalone (row's own
"under 5 minutes" estimate, doubled for the two passes, plus build time).
Item (3)'s cost is folded into step 5 or 6. Fits one heartbeat.

### Step 5 — Group B, local Ollama analyzer: B1, B2, B3, B4

**Preconditions:**
- [ ] A local analyzer reachable — Ollama (Qwen) primary, Gemini fallback
  path exercised for B1's recitation-block case.
- [ ] `ollama ps` open in a second terminal (B2's own instruction, driven
  from Model Manager).
- [ ] Real workspace book *Заказ Коалфолла* for B3/B4 — re-analysis writes
  `cast.json`/`cast-id-history.json` for this book; this is the row's own
  accepted mechanism (not a violation of "never mutate real book data" —
  B3's whole point is proving the id is *kept*, and the row records the
  before/after values precisely so the mutation is a checked, reversible-
  by-diff observation, the same shape A33's own `--apply` run already used).
- [ ] CPU-only sub-cases (B1's ETA-seed case, B2's `RAM_HEAVY_MODELS`
  clamp) run without GPU — confirm both paths, not just the GPU-resident
  default.
- [ ] E11 item (3) (post-D18 re-analysis) can ride this session if a
  suitable book is chosen.
- [ ] Leave the analyzer resident/running at teardown per box-safety.

**Est. running time:** B1 ~30 min, B2 ~20 min, B3 (+B4, no extra cost)
depends on the book's analysis time — plan's own framing calls it "short,"
but a full re-analysis of a 13-character book is not instant; budget
30-60 min. **Total ~80-110 min.** Fits one heartbeat, but B3/B4's real
analyzer run is the variable to watch — if it runs long, split B1/B2 into
their own heartbeat and B3/B4 into a second.

### Step 6 — Group C, one Ночной дозор re-analysis session: C1, C2, C3, C4

**This step is too large for one heartbeat, and part of it is currently
blocked. See §4.6 for the live dependency check.**

**Preconditions (once unblocked):**
- [ ] C1 (cloud): `GEMINI_API_KEY` already configured in `server/.env`;
  **run against a throwaway re-import, not the library book** (row's own
  instruction, L2730 — the analysis cache is keyed by `manuscriptId` only,
  so re-analyzing the existing library entry would overwrite the qwen36
  analysis the owner is keeping). Confirm `server/.env`'s `GEMINI_MODEL`
  is overridden to `gemma-4-31b-it` for this run (L2724-2728) — the `.env`
  default is RECITATION-unsafe for this book.
- [ ] C2/C3/C4 (local): local Ollama, `qwen36-cw-iq4-32k`, **~14 GB VRAM
  free** (register's own figure, L2775 — flagged against the row-level "no
  GPU needed" tags on C4 and the wave-2 §2.2 summary's blanket claim; the
  historical run spilled ~5 GB over PCIe on a 14.2 GiB card, so budget for
  spillover, not a hard fit). `DISABLE_AUTOSTART_SIDECAR=1` (no TTS
  needed). Batch C2, C3 and C4 in one session — they share the same book
  and the same run.
- [ ] Book: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch
  Tetralogy\Ночной дозор` — real book data is read and re-analyzed
  (overwriting its own prior analysis cache), which is this row's own
  accepted mechanism, not a workspace mutation outside the row's design.
- [ ] Preserve `server/handoff/outbox/*-stage2-ch*.json` before tearing
  down the run's checkout (register's own warning, L2674-2677).
- [ ] This is a real live-GPU compute session (unlike Group B's shorter
  runs) — leave the box's other services (server, sidecar) running per
  box-safety; do not stop or kill another lane's process to free VRAM.

**Est. running time:** C1 alone is "hours" under real cloud throttling
(unspecified upper bound — the original incident logged 22 `script-review`
429s over a multi-hour run). C2+C3+C4 batched: the last comparable run was
**12 h 27 m** (register's own figure, L2608). **This step is explicitly too
large for one heartbeat.** Split: (a) C1 as its own detached/background
session, checked back on across multiple heartbeats rather than held open;
(b) C2+C3+C4 as a second detached session, launched only once §4.6's block
clears, likewise monitored across heartbeats rather than blocking one.

### Step 7 — E7, E8

**Preconditions:**
- [ ] E7: a box (any machine, no GPU) with `server/tts-sidecar/.venv`
  deleted or a fresh clone with no venv at all — this is the *absence*
  state, not a broken one; distinct from A39/A41's throwaway-but-present
  venvs.
- [ ] E8: a second machine or container with an `ffmpeg` build whose
  `-version` banner differs from the baseline's (register suggests a
  22.04 container with archive ffmpeg 4.4, L3007). `npm run
  test:golden-audio:assembly`.
- [ ] Neither needs GPU or browser judgement — E7's card states/log lines
  and E8's L1-L4 tier results are both API/log/test-output observable.

**Est. running time:** E7 ~15-20 min (the ~2 GB download is deliberately
part of the timing being tested). E8 ~15-20 min. **Total ~30-40 min.**
Fits one heartbeat.

### Step 8 — Group G, GitHub Actions: G1, G2

**Both rows are currently blocked/opportunistic — see §4.6/§7. Neither
runs today; this step's job is to record STILL OWED-blocked with the
live evidence, not to fail.**

**Preconditions (when each unblocks):**
- [ ] G1: needs (a) PR #2488 merged (§7 — currently open) and (b) a real
  quarantined flaky test present in `docs/testing/flaky-register.md` at
  dispatch time (currently none — the sole row there, #1981, is "Not
  quarantined — still gates," so it never reaches the report). When both
  hold, the remaining check is `gh issue view` succeeding under the
  workflow's injected `GH_TOKEN`, and the `intermittent` bucket firing on
  a genuine cross-run flake — both read from the workflow's own job
  summary and log, no GPU, no browser.
- [ ] G2: needs a real `vX.Y.Z` tag push (the next release cut) — not
  something this chain should trigger for test purposes (box-safety and
  plain good sense: a false-positive here blocks a real release,
  L3402-3403). When one happens naturally, the check is reading the
  `publish` job's own log and diffing the published body against `git show
  <tag>:docs/release-notes-next.md` — no GPU, no browser.

**Est. running time:** 0 actionable minutes today for either row. Once
triggered, G1's check is minutes (a `gh` call); G2's is minutes (log read +
diff) "observed as part of a cut that was happening anyway" (row's own
words, L3443).

---

## 5. Arithmetic

- **Agent-runnable (assigned to steps 2-8): 19** — A27, A29, A39, A40, A41,
  A42 (6) + B1, B2, B3, B4 (4) + C1, C2, C3, C4 (4) + E7, E8, E11 (3) + G1,
  G2 (2) = 6 + 4 + 4 + 3 + 2 = **19**.
- **OPERATOR (join `onbox-sitting-cloning-identity.md`, recorded for step 9
  to fold into the sitting plan): 2** — A33, A43.
- **19 + 2 = 21.** Every row in wave 2's §2.2 list appears exactly once
  above, in §1's table, and in exactly one of steps 2-8 or the OPERATOR
  set. Reconciled.

Of the 19 agent-runnable rows, note that **6 are currently blocked and
cannot run yet**: C2, C3, C4 (pending #2288, §4.6) and G1 (pending PR
#2488, §7) are genuinely blocked; G2 is opportunistic and has no fixed
unblock date. This does not change the 19/2/21 arithmetic — verdict is
about *whether the row can ever run without an operator*, not about
*whether it can run today* — but it materially changes what steps 6 and 8
can actually produce this pass, and both steps say so explicitly (§4.6,
§4.8) rather than silently reporting a pass.

---

## 6. Dependency: #2288/#2279 blocking Group C (step 6)

`onbox-acceptance-register.md`'s Group C header carries an explicit hold
(L2638-2642, quoted):

> "**Hold the full 12-hour re-run — the in-flight speaker-separation work**
> (#2288, #2279) **changes dialogue segmentation**, so a pass taken before
> it lands measures a moving target and has to be repeated. Wait for it,
> then take C2 and C3 in one session."

Live state checked 2026-08-20 via `gh issue view <N> --repo
dudarenok-maker/Castwright --json number,title,state,closedAt`:

- **#2288** — "srv — findQuoteRuns lets a gap-seeded quote run swallow the
  next dialogue turn (blocks all quotePairs widening)" — **state: OPEN**.
- **#2279** — "srv — the language conventions tables are missing quote
  styles real manuscripts use" — **state: CLOSED**, 2026-08-14.
- **#2306** (the collapse-cause issue C1/C2 also reference) — **state:
  CLOSED**, 2026-08-14.

**The hold is still in effect.** #2279 and #2306 have closed since the
register text was written, but #2288 — the row the hold text names first
and the one whose fix changes dialogue segmentation — is still open.
C2, C3 and C4 (which batches with C2/C3) are therefore **STILL
OWED-blocked**, not runnable, until #2288 closes. C1 (the cloud pass) does
not depend on #2288 — it measures completion/throttling behaviour on
`gemma-4-31b-it`, not dialogue-segmentation accuracy — so it can run
independently of this block.

---

## 7. Dependency: G1 blocked behind #2465 / PR #2488

Live state checked 2026-08-20:

- `gh pr view 2488 --repo dudarenok-maker/Castwright --json
  number,title,state,mergedAt,url` →
  `{"mergedAt":null,"number":2488,"state":"OPEN","title":"fix(scripts): parse
  the register's real test-cell format and fail loud on a silent zero",
  "url":"https://github.com/dudarenok-maker/Castwright/pull/2488"}`
- `gh issue view 2465 --repo dudarenok-maker/Castwright --json
  number,title,state,closedAt` →
  `{"closedAt":null,"number":2465,"state":"OPEN","title":"quarantine-health
  parseRegister drops every real register row, so the weekly cron is a
  permanent no-op"}`

**PR #2488 has not merged; #2465 is still open.** G1's remaining debt
(`gh issue view` authentication under real `GH_TOKEN`, and the
`intermittent`-classification proof) already needed a real quarantined
flaky row that doesn't exist today (§4.8); it also now needs this parser
fix to land, since #2465's own title says the current `parseRegister`
"drops every real register row," which would make the workflow's read of
`docs/testing/flaky-register.md` unreliable even once a real quarantined
row exists. **Step 8 records G1 as STILL OWED-blocked** on both grounds,
rather than treating it as a pass or a failure.

---

## 8. Total running time and heartbeat-size verdict

| Step | Rows | Est. time | Fits one heartbeat? |
|---|---|---|---|
| 2 | A39, A40, A41, A42 | ~55-70 min | Yes |
| 3 | A27, A29 | ~45-50 min | Yes |
| 4 | E11 | ~15-20 min (+ item 3 riding step 5/6) | Yes |
| 5 | B1, B2, B3, B4 | ~80-110 min | Yes, watch B3/B4 |
| 6 | C1, C2, C3, C4 | C1: hours (unbounded); C2+C3+C4: ~12h27m (blocked) | **No — see split below** |
| 7 | E7, E8 | ~30-40 min | Yes |
| 8 | G1, G2 | 0 min actionable today | Yes (records blocked state only) |

**Step 6 is explicitly too large for one heartbeat**, on two independent
grounds: C1's cloud pass runs for hours under real throttling with no firm
upper bound, and the C2/C3/C4 local pass's last comparable run took
12 h 27 m even before accounting for the current block. **Named split:**
run C1 as its own detached/background session (its own heartbeat or
several, polled rather than held open); hold C2/C3/C4 entirely until
§4.6's #2288 block clears, then launch that batch as a second detached
session spanning multiple heartbeats of its own. Do not attempt either
inside a single synchronous step-6 pass.

No other step approaches this scale — steps 2, 3, 4, 5 and 7 are all
comfortably single-heartbeat CLI/script work, and step 8 currently has
nothing to run beyond recording two blocked states with their live
evidence.

---

## 9. Not in scope (per the parent issue)

This plan does not run any acceptance, does not edit
`onbox-acceptance-register.md`, the live-view HTML, the staleness audit,
`onbox-sitting-plan.md`, or any sitting pack. A33 and A43 moving to
OPERATOR is recorded here only; a later child (step 9 of this chain)
updates `onbox-sitting-plan.md` and `onbox-sitting-cloning-identity.md` to
add them. A2, A16 and A22 are the operator's own queue and are not
touched here, per the parent issue.

Per-step result files (e.g. under `docs/testing/onbox-wave3-results/`) do
not exist yet — this repo's `docs/testing` link-scan guard
(`test:hooks`) walks the whole tree on every commit, so this plan
references them as plain code spans (`docs/testing/onbox-wave3-results/step-2-ort-marker.md`
etc.) rather than real markdown links. The child that first writes each
result file converts its own reference to a real link.
