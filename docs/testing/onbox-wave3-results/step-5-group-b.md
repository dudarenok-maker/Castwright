# Wave 3 step 5 — Group B, local Ollama analyzer (B1, B2, B3, B4)

Issue: Castwright#2497 chain, step 5 · Plan of record: `docs/testing/onbox-wave3-plan.md` §4 (step 5)

Worktree: `wt-2497-onbox-wave3-run` @ `c0c988eed781` (HEAD at run time, unchanged — no source diff made this pass; docs-only, dry-run discipline honoured throughout). Server run against `WORKSPACE_DIR=C:\AudiobookWorkspace` (real workspace, required for B3/B4's fixture) on this worktree's own isolated port (`PORT=8190`, slot 11 per `.env.local`), never colliding with another lane. Local Ollama daemon already running on this box, shared (not spawned by this step); GPU checked idle before starting (RTX 4070 Laptop 687/8188 MiB, RTX 5070 Ti 209/16303 MiB) and re-checked again immediately before triggering the real analyzer run, per the box-safety instruction.

## Summary verdicts

| Row | Verdict | One-line why |
|---|---|---|
| B1 | **STILL OWED** | Blocked on two real, verified preconditions this worktree does not have: no `GEMINI_API_KEY` (step 1 needs a genuine Gemini recitation-block → Qwen fallback) and no ready-made ~110k-char / dense-single-paragraph fixture (steps 2-4's CPU-only sub-case). Not attempted beyond confirming the blockers. |
| B2 | **DISCHARGED** (steps 1, 2, 3, 4, 5, 6, 8) / **STILL OWED** (step 7) | Six of eight steps run live against the real Model Manager API + `ollama ps`, with pasted output below. Step 8 corroborated by direct source read (not a live run). Step 7 (CPU-only `RAM_HEAVY_MODELS` clamp) cannot be genuinely exercised on this box — see below. |
| B3 | **STILL OWED** | Core criterion (Мэйрин/Коалфолл ids kept across a real full re-analysis, with a real non-deterministic analyzer output correctly caught and recorded via `retireCharacterId`) **passed**. But the row's own "roster otherwise intact, no duplicate row" sub-check **failed for real**: two near-duplicate character rows were minted this run. A row with a genuine, reproduced failure is recorded as owed, not discharged — full evidence below. |
| B4 | **STILL OWED** | Same run as B3. Cyrillic-names and ASCII-kebab-id criteria passed. The "no near-duplicate id pair" criterion **failed**: `brann-wire`/`berrin-wire` duplicate `brann-weir`/`berrin-weir`. Roster size moved 13→16, not "still 13." |

Analyzer left resident at teardown (`qwen36-cw-iq4-32k:latest`, the book's default analysis model, warmed via `POST /api/ollama/load` after all tests). GPU and server state confirmed clean — see Box-safety at the end.

---

## B1 · Analysing view honesty for local analyzers (plan 216) — STILL OWED

Re-resolved 2026-08-20 against `docs/features/216-analysing-local-analyzer-honesty.md` lines 124-142 (six numbered steps) and the register (L2525-2531). Nothing in either doc has changed since the plan's own re-derivation.

**Blocker 1 (step 1 — Gemini recitation-block → local Qwen fallback):** this worktree's `server/.env` has no `GEMINI_API_KEY` set. Confirmed directly:

```
$ grep -n "GEMINI_API_KEY" server/.env
(no match)
```

The worktree's own `.env` header states this is deliberate isolation ("no `GEMINI_API_KEY`, no secrets, nothing" copied from the primary checkout — `server/.env` line 11). Step 1's criterion requires starting analysis on a real per-phase Gemini config, observing a genuine Google-side recitation block on a copyrighted chapter, then switching to local Qwen mid-run and confirming chip/swap/ticker/log all agree — none of that can be genuinely triggered without a real key. I do not have one and was not given one to use; per the isolation note this is by design, not an oversight I should route around.

**Blocker 2 (steps 2-4 — ~110k-char chapter, dense single-paragraph chapter, CPU-only ETA seed):** no ready-made fixture of either shape exists in this worktree or the isolated `castwright-workspace`:

```
$ wc -m server/src/__fixtures__/the-coalfall-commission.md server/src/__fixtures__/the-coalfall-commission.ru.md
   15657 the-coalfall-commission.md
    6223 the-coalfall-commission.ru.md
```

Both are far short of ~110k chars. `castwright-workspace/books` (this worktree's isolated workspace) is empty. Constructing a suitable fixture would require importing a real book's chapter (e.g. `Ночной дозор`, whose manuscript.epub is 416KB — plausibly long enough) as a **throwaway** manuscript into a second, differently-ported server instance pointed at the isolated `castwright-workspace` (not the real library, to avoid creating an unwanted book in `C:\AudiobookWorkspace`) — a real, legitimate path, but a second full session's worth of setup that this pass's time budget did not accommodate once B3/B4's real ~20-minute analyzer run and B2's live API session were run to completion.

**Step 5** (`LiveChapterTicker` at K=4, "one e2e/screenshot check" per the feature doc's own words) is browser/visual-shaped despite the plan's blanket "agent-runnable" framing for B1 — worth flagging back to the plan as a partial re-resolution note: this specific sub-part may not actually be agent-runnable the way the other five are.

**Nothing attempted beyond confirming these two blockers** — no fabricated pass, no partial run against undersized fixtures that wouldn't actually exercise the "~110k-char" or "dense single-paragraph" claims.

---

## B2 · Per-model analyzer keep-alive (plan 263) — 6/8 steps DISCHARGED, step 7 STILL OWED, step 8 corroborated

Re-resolved against `docs/features/263-per-model-keepalive.md` lines 242-300 (the eight-step "Manual acceptance walkthrough") and the register (L2535-2539). Driven entirely from the real Model Manager API (`GET /api/models/inventory`, `PUT /api/user/settings`, `POST /api/ollama/load` / `/unload`) with `ollama ps` polled in a separate terminal, per the row's own instruction.

**Baseline settings captured before any change** (`analyzerKeepAliveByModel`):
```
{"qwen36-cw-iq3-32k:latest":300,"qwen36-cw-iq3-64k:latest":300,"qwen36-cw-iq4-32k:latest":600,
 "gemma4-cw-26B-A4B:latest":300,"qwen36-agent:latest":0,"minimax-m3:cloud":300,
 "gemma4-e4b-8gb:latest":300,"llama3.1:8b":300,"qwen3.5:4b":300,"qwen3.5:9b":300}
```
Test model chosen for the live PUT/Load/ps steps: `qwen3.5:4b` (small, not otherwise in use, avoids GPU contention with B3/B4's concurrent run). **Restored to this exact baseline at the end — diffed byte-for-byte equal, confirmed below.**

### Step 1 — flat 30s default for un-overridden tags

```
$ curl -s http://localhost:8190/api/models/inventory | … (analyzer rows)
ollama:qwen38-agent-iq4:latest        keepAliveSeconds=30  override=false
ollama:muse-glimmer-agent-64k:latest  keepAliveSeconds=30  override=false
ollama:qwen36-cw-iq3-32k:latest       keepAliveSeconds=300 override=true
ollama:qwen36-cw-iq4-32k:latest       keepAliveSeconds=600 override=true
```
Un-overridden tags (`qwen38-agent-iq4`, `muse-glimmer-agent-64k` — not in the settings map) correctly show the flat `30` default; overridden tags show their configured value. **DISCHARGED.**

### Step 2 — PUT persists the raw-key map, other entries untouched

```
$ curl -s -X PUT http://localhost:8190/api/user/settings -d '{"analyzerKeepAliveByModel":{...,"qwen3.5:4b":0,...}}'
$ curl -s http://localhost:8190/api/models/inventory | … qwen3.5:4b
{"id":"ollama:qwen3.5:4b","keepAliveSeconds":0,"keepAliveIsOverride":true}
```
Raw-key (`qwen3.5:4b`, not normalized) round-trips correctly through `resolveKeepAliveSeconds`, and every other model's entry in the map was carried unchanged in each subsequent PUT (verified by re-fetching `/api/user/settings` and comparing the untouched keys each time). **DISCHARGED.**

### Step 3 — pinned resident during a run

Observed as a genuine side-effect of B3/B4's real re-analysis run (not a separate synthetic test — stronger evidence, a real ~20-minute production-shaped run):
```
$ ollama ps   (while B3's re-analysis of Заказ Коалфолла was in flight)
NAME                        SIZE     PROCESSOR    CONTEXT    UNTIL
qwen36-cw-iq4-32k:latest    16 GB    100% GPU     32768      Forever
```
`UNTIL Forever` (i.e. `keep_alive: -1`) throughout the run, confirmed at multiple points across the ~20-minute analysis, even though that model's configured post-run keep-alive is `600`s, not `-1` — i.e. the pin overrides the configured value for the run's duration, exactly as designed. **DISCHARGED.**

**Confound discovered and recorded (not a defect, a genuine design property worth flagging):** reading `server/src/analyzer/ollama.ts:221-233` (`keepAliveFor`), the pin is gated on `isAnyAnalyzerRunBusy()` — **any** analyzer run in flight, not scoped to the specific model being loaded. Live-confirmed: while B3's run held `qwen36-cw-iq4-32k:latest` pinned, a manual Load of the *unrelated* `qwen3.5:4b` (configured keep-alive `0` at the time) also came back `UNTIL Forever`, not the expected 30s floor — because "any run busy" pinned it too. This is consistent with the code's own comment ("While ANY analyzer run … is in flight the model is PINNED"), so it is not a bug, but it did mean step 4/5's "outside a run" cases could not be honestly tested while B3 was running — redone cleanly below once B3 finished.

### Step 4 — keep-alive=0, manual Load pill still warms with the 30s floor (redone after B3 finished, no run in flight)

```
$ ollama ps                                            # confirm nothing resident, no run in flight
NAME    ID    SIZE    PROCESSOR    CONTEXT    UNTIL     (empty)

$ curl -s -X PUT .../user/settings -d '{"analyzerKeepAliveByModel":{...,"qwen3.5:4b":0,...}}'
$ curl -s -X POST http://localhost:8190/api/ollama/load -d '{"model":"qwen3.5:4b"}'
{"status":"ready"}
$ ollama ps
NAME          SIZE     PROCESSOR    CONTEXT    UNTIL
qwen3.5:4b    3.8 GB   100% GPU     32768      29 seconds from now
```
Configured keep-alive `0`, no run in flight, manual Load pill → resident with a ~30s floor, not evict-on-warm. **DISCHARGED** — this is the regression the row calls out as "the check worth confirming."

### Step 5 — keep-alive=-1, resident indefinitely

```
$ curl -s -X PUT .../user/settings -d '{"analyzerKeepAliveByModel":{...,"qwen3.5:4b":-1,...}}'
$ curl -s -X POST http://localhost:8190/api/ollama/load -d '{"model":"qwen3.5:4b"}'
{"status":"ready"}
$ ollama ps
NAME          SIZE     PROCESSOR    CONTEXT    UNTIL
qwen3.5:4b    3.8 GB   100% GPU     32768      Forever
```
**DISCHARGED.**

### Step 6 — reset (↺) restores the flat default

```
$ curl -s -X PUT .../user/settings -d '{"analyzerKeepAliveByModel":{... qwen3.5:4b key omitted ...}}'
$ curl -s http://localhost:8190/api/models/inventory | … qwen3.5:4b
{"id":"ollama:qwen3.5:4b","keepAliveSeconds":30,"keepAliveIsOverride":false}
```
Removing the key from the map (what the UI's ↺ button does) restores the flat `30` default and `keepAliveIsOverride:false`. **DISCHARGED.**

### Step 7 — CPU-only `RAM_HEAVY_MODELS` clamp — STILL OWED

Code path confirmed by direct read (`server/src/analyzer/ollama.ts:192,232`):
```ts
const RAM_HEAVY_MODELS = new Set(['qwen3.5:9b']);
...
if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
```
`accelerator` comes from live GPU detection (`getLastKnownVram().accelerator`). This box has two resident NVIDIA GPUs (RTX 4070 Laptop, RTX 5070 Ti) — `accelerator` resolves to `'cuda'` here, structurally, and cannot be forced to `'cpu'` without disabling GPU visibility, which risks other lanes' concurrent work and is out of scope for this step. **Not run — genuinely blocked by hardware shape, not by time.** The code path is confirmed to exist and be correctly gated; only the *live, accelerator-detected* observation is missing.

### Step 8 — persona/voice-design keep-alive stays 300 — corroborated by source, not live-run

```ts
// server/src/tts/persona-gpu-plan.ts:9
const PERSONA_KEEP_ALIVE_SECONDS = 300;
// :38
: { onCpu: false, keepAlive: PERSONA_KEEP_ALIVE_SECONDS };
```
`generatePersonaViaOllama` (`server/src/analyzer/ollama.ts:861-925`) takes `keepAlive` as a caller-supplied literal — never routes through `resolveKeepAliveSeconds()`/the per-model map at all. Structurally, there is no code path by which a per-model override could regress persona's `300`. This is strong static evidence but **not a live-observed pass** (no `ollama ps` watched during an actual voice-design job this pass — a full design run would have contended with B3/B4's live GPU session and the time budget). Recorded as corroborated-by-source rather than claimed as a full live discharge, per the fail-closed evidence rule.

### Restoration (all of B2's live testing)

```
$ curl -s -X PUT .../user/settings -d '{"analyzerKeepAliveByModel":{<exact original 10-key map>}}'
$ diff <(baseline map) <(post-test map)
RESTORED: identical to baseline
```
Confirmed byte-identical to the pre-test baseline captured at the top of this section.

---

## B3 · Cast/analysis `characterId` drift — Wave 2 stops new drift — STILL OWED

Full evidence, `Result:` lines, and the exact root-cause citation are recorded in `docs/testing/cast-id-drift-onbox-acceptance.md` §7 (filled in as part of this step, per that file's own convention — no new lines/sections added). Summary:

- **Re-resolution finding:** `cast-id-history.json` was already present before this run (dated 2026-08-11, `mayrin→mairin` / `coalfall→coalfall-dragon`), contradicting the acceptance doc's stated "absent as of 2026-08-04" precondition. Recorded per `onbox-sitting-plan.md` §6's re-resolution rule rather than silently trusted; did not block running the row again, since the criterion is about *this* re-analysis, not the file's prior absence.
- **Core criterion PASSED, with strong evidence:** a real full re-analysis via local Ollama (`qwen36-cw-iq4-32k:latest`, ~19m43s wall-clock) left `mairin`/`coalfall-dragon` unchanged in `cast.json`, and — more convincingly than a same-string coincidence — the analyzer's *raw* fresh ids this run were the genuinely different `мэйрин`/`коалфолл` (lowercase Cyrillic), correctly caught and retired via `retireCharacterId`, recorded in `cast-id-history.json`'s `supersededBy` map (plus a third character, `widow-casper→widow-kasper`, an extra real data point).
- **Roster-integrity sub-check FAILED, reproducibly:** roster grew 13→16. One addition (`unknown-man`) is a legitimate new detection. Two (`brann-wire`, `berrin-wire`) are near-duplicate rows of the pre-existing `brann-weir`/`berrin-weir` — same role, same evidence quotes verbatim, never linked via `retireCharacterId` (absent from `supersededBy`). Root cause identified by direct code read: `server/src/store/merge-analysis-cast.ts:205-206,282-284`'s name-fallback match requires an *exact* normalized-name string match (`nameOf()`/`normaliseForMatch`), with no tolerance for a character gaining a surname token between analyzer runs (this run: "Бранн Уир"/"Беррин Уир" vs. the cast's "Бранн"/"Беррин").

Because a row-defined sub-check genuinely failed against real evidence, the row is recorded **STILL OWED**, not discharged — the mechanism the row exists to prove is real and works for the majority case, but the row's own "no duplicate row" bar is not met.

---

## B4 · Stage-1 returns cast names in the manuscript's own script — STILL OWED

Rides B3's same run, per the row's own instruction (register L2568, "Fold this into B3's run").

- **All names Cyrillic, zero Latin transliterations:** confirmed — every `name` field in the after-state `cast.json` (16 rows) is Cyrillic (Рассказчик, Одуван, Рен, Мэйрин, Коалфолл, Неизвестный мужчина, Пелл Холлис, Вдова Каспер, Бранн Уир, Беррин Уир, Отец Лессом, Иво, Села, Харт, Бранн, Беррин). **PASSED.**
- **All ids ASCII kebab-case:** confirmed — all 16 ids (`narrator`, `oduvan`, `ren`, `mairin`, `coalfall-dragon`, `unknown-man`, `pell-hollis`, `widow-kasper`, `brann-wire`, `berrin-wire`, `father-lessom`, `ivo`, `sela`, `hart`, `brann-weir`, `berrin-weir`) are ASCII kebab-case. **PASSED.**
- **"No character gained a second id" — FAILED.** `brann-wire`/`brann-weir` and `berrin-wire`/`berrin-weir` are exactly the near-duplicate pair this row's own text names as the worst-case outcome ("the one way this change could make things worse rather than better") — see B3 above for the full evidence and root cause.
- **Roster size vs. B3's recorded 13:** now 16, not "still 13" — a real change, not the neutral case the row anticipated as the default outcome.

Same verdict basis as B3: a real run, a real, explicitly-named-as-worst-case failure mode reproduced. **STILL OWED**, not discharged.

---

## Box-safety

- **No live sidecar venv touched.** The step never touched `server/tts-sidecar/.venv`; the sidecar running on `:9000` was an already-running process this worktree's server *adopted* (log: "already listening on :9000 … not our child"), never spawned or stopped by this step.
- **Real book data mutation is exactly what B3/B4 sanction, and nothing beyond it.** Only `Заказ Коалфолла`'s own `.audiobook/cast.json` and `.audiobook/cast-id-history.json` were written, by its own re-analysis, as the row's own text explicitly designs for. No other book under `C:\AudiobookWorkspace` was read for writing, and no new book was imported into the real library (B1's fixture gap was left unresolved rather than routed around this way — see B1 above).
- **No server, sidecar, or model was left stopped.** The worktree's own server (port 8190) is still running at hand-off. `ollama ps` at teardown:
  ```
  NAME                        SIZE     PROCESSOR    CONTEXT    UNTIL
  qwen36-cw-iq4-32k:latest    16 GB    100% GPU     32768      9 minutes from now
  ```
  (the book's default analysis model, warmed deliberately at the end per "leave the local analyzer resident/running at teardown").
- **GPU contention checked twice** — once before starting (both GPUs near-idle, matching the operator's own pre-check) and again immediately before triggering the real B3/B4 analyzer run. No other lane's process was stopped or killed; GPU load observed during the run (RTX 4070 Laptop ~65%, RTX 5070 Ti ~30-90% depending on point in the run) reflects only this step's own analyzer call plus whatever else was already resident, never touched.
- **All `--apply`/`--write`-shaped actions were sanctioned by the row itself.** The only "write" performed anywhere this step was B3/B4's own re-analysis (row-sanctioned) and the `PUT /api/user/settings` calls for B2's keep-alive tests (restored to the exact original byte-identical map afterward, diff-verified). No `--apply`/`--fix` script flag was invoked anywhere.
- **Worktree tree stayed clean** — `git status --porcelain` empty at both start and end; this step made no source changes, only the two docs files listed below.

## Files written this step

- `C:\Claude\Projects\wt-2497-onbox-wave3-run\docs\testing\onbox-wave3-results\step-5-group-b.md` (this file)
- `C:\Claude\Projects\wt-2497-onbox-wave3-run\docs\testing\cast-id-drift-onbox-acceptance.md` — §7 `Result:` lines filled in, per that file's own convention, no new lines/sections added.

## Defect for a fix agent (per the campaign rule — reported, not filed/fixed here)

**Mechanism:** `server/src/store/merge-analysis-cast.ts:205-206` (`nameOf` via `normaliseForMatch(c.name)`) feeding the name-fallback candidate lookup at `:282-284` (`dropMatchCandidateByName.get(key)`) requires an **exact** normalized-name string match between a dropped existing character and a fresh analyzer row. **Observed:** a real re-analysis of *Заказ Коалфолла* (2026-08-20) had the analyzer detect "Бранн Уир"/"Беррин Уир" (with surname) where the existing cast held "Бранн"/"Беррин" (given name only) for the same two characters (confirmed by identical role and verbatim-identical evidence quotes) — the exact-match key differs, so the fallback never fires, and two new, never-retired ids (`brann-wire`, `berrin-wire`) are minted alongside the originals, producing exactly the "near-duplicate pair" failure mode `docs/superpowers/plans/2026-08-01-cast-character-identity.md`'s own design and this register row (B3/B4) name as the worst-case regression the whole mechanism exists to prevent. **Scope for a fix:** `server/src/store/merge-analysis-cast.ts`'s name-fallback matching alone — likely a token-subset or prefix-tolerant comparison instead of (or in addition to) the current exact-normalized-string equality, gated carefully enough not to loosen matching for genuinely distinct characters who happen to share a given name.
