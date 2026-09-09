# A34 step 4 — backup, apply the repair for real, re-test the fix

Former register row A34 (discharged and removed 2026-09-09; #2584, #2040),
parent #2903, chain issue #2906.

**Status: repair applied and verified; re-test CONFIRMED (attempt 6,
2026-09-09) after four attempts blocked by environment instability and a
fifth that hit a self-inflicted detour — see "Result (final)" below. Row A34
was discharged by this result.**

## Precondition — read step 3's dry-run evidence

Step 3 (`step-3-dry-run.md`) found exactly **one confirmed repair**:
`Castwright / Standalones / Заказ Коалфолла`, `oduvan → одуван` ("Одуван",
the blacksmith). The two `report-only` pairs in `Playing with Fire`
(`lightning-dave`, `the-torment`) have no `.bak.*` evidence and are correctly
excluded from `bookPlans` — `--apply` does not touch that book.

## Backup — before writing anything

A backup already existed in this worktree at
`docs/testing/onbox-a34-results/backups/castwright__standalones__заказ-коалфолла/`
(`cast.json`, `state.json`, `cast-id-history.json`), committed by an earlier
session (`46c039f2`). Before applying, I byte-verified it against the live
files with SHA-256 (`certutil -hashfile ... SHA256`):

| File | Live (pre-apply) | Backup | Match |
|---|---|---|---|
| `cast.json` | `9a40f306214e464be51e81b2af96f94fc99d992a0d3c858b024c5ca2b44af41c` | same | ✅ |
| `state.json` | `b0bbd07a1983c7bac3d4b25da879f855517dbf1610399957b256c87b0da9a220` | same | ✅ |
| `cast-id-history.json` | `396dc3f843851bb4885e75091ce24b5a5a8f85968f8ca5607873c298c659a01f` | same | ✅ |

Restore path: `docs/testing/onbox-a34-results/backups/castwright__standalones__заказ-коалфолла/`
(committed in this worktree), plus the apply script's own pre-repair
snapshots written alongside the live files (see below).

## Server-liveness precondition

Confirmed no Castwright server listening on 8080-8099 or 8443-8462 at apply
time (`netstat -ano`, no matches). Port 8090 **was** listening — identified
as `llama-swap.exe` (PID 23032, the operator's own standing local-model
router, not a Castwright server) via
`Get-Process -Id 23032 | Select-Object ProcessName,Path`. Per the script's
own documented mechanism (`ALLOW_STANDING_PORTS`, added by PR #3057 for
exactly this port), ran with `ALLOW_STANDING_PORTS=8090` rather than routing
around the refusal — the probe still covers every other port in range.

Also required an unrelated one-time fix: the script depends on the server's
compiled `dist/store/cast-id-history.js`, which this worktree hadn't built
yet. Ran `npm run build` under `server/` before the apply attempt succeeded.
No book data was touched by that build step.

## Apply — real workspace

```
$env:AUDIOBOOK_WORKSPACE = 'C:\AudiobookWorkspace'
$env:ALLOW_STANDING_PORTS = '8090'
node scripts\repair-a34-wrong-direction-ids.mjs --apply
```

Output:

```
=== A34 (#2584/#2040) wrong-direction characterId repair pass ===
mode: APPLY (writing cast.json + cast-id-history.json)
workspace: C:\AudiobookWorkspace
probing 127.0.0.1:8080-8099 and 127.0.0.1:8443-8462 for a live server...
  (NOT probing port(s) 8090 — allowed via ALLOW_STANDING_PORTS for this run)
books scanned: 27

books not yet analysed (cast.json and/or state.json genuinely missing...): 3
  - [three "C1 cloud throwaway" fixture books, not real production books]

report-only (id-shape matched, but same-character NOT confirmed): 2
  - [Derek Landy / Skulduggery Pleasant / Playing with Fire] lightning-dave -> lightning_dave (no-name-evidence)
  - [Derek Landy / Skulduggery Pleasant / Playing with Fire] the-torment -> the_torment (no-name-evidence)

confirmed repairs: 1 across 1 book(s)
  - [Castwright / Standalones / Заказ Коалфолла] reinstating "oduvan" (was "одуван", "Одуван")
  -> wrote C:\AudiobookWorkspace\books\Castwright\Standalones\Заказ Коалфолла\.audiobook\cast.json and its cast-id-history.json
     pre-repair copies: cast.json.bak.a34-2026-09-08T08-47-04-792Z, cast-id-history.json.bak.a34-2026-09-08T08-47-04-794Z

Applied 1 book(s).
```

**books scanned rose from 23 (step 3) to 27** and a new "not yet analysed"
bucket appeared (3 throwaway fixture books) — this is a script-behavior
change from the E1/E2 fixes landed between step 3 and this run (commit
`5232cf70`, review-pass-3), not a change in the real book set. The one
confirmed repair is identical to step 3's finding.

## Confirmed write — verified against actual file contents

Post-apply, read the live `cast.json` directly (not trusting the script's own
stdout claim):

```
grep -n "\"id\": \"oduvan\"\|\"id\": \"одуван\"" ".../Заказ Коалфолла/.audiobook/cast.json"
61:      "id": "oduvan",
```

Before: `id: "одуван"`. After: `id: "oduvan"`. Confirmed by direct read, twice
more later in this session (after two unrelated server crashes — see below)
to rule out any corruption: unchanged both times.

## Re-test — NOT completed, blocked by environment instability

Attempted to re-analyze *Заказ Коалфолла* (full manuscript re-analysis)
against the now-repaired `cast-id-history.json`, per the issue's instructions,
to confirm the id comes back `oduvan` and **stays** ASCII. This step requires
a running server + frontend and driving the re-analysis through the app.

Three separate attempts, each blocked by the box itself, not by anything
about the repair:

1. Started a worktree-local server (`node server/dist/index.js`,
   `WORKSPACE_DIR=C:\AudiobookWorkspace`, port 8150) + Vite frontend (port
   5243). Server came up, but died silently (process gone, no error in
   stdout/stderr, no exit code logged) within ~90 seconds — before the
   re-analysis could be triggered. The browser tab also hit an unrelated
   transient dynamic-import routing glitch on first navigation, unrelated to
   the crash.
2. Restarted both cleanly. Server died again the same way, silently, within
   roughly the same window — this time after a "library scan failed (500)"
   surfaced in the UI just before the connection dropped entirely.
3. Used the repo's own `start-app.bat` (with `WORKSPACE_DIR` override) at the
   operator's suggestion. It detected the operator's own separate, already-
   running Pinokio-managed Castwright instance on port 8080
   (`C:\pinokio\api\castwright\server`) and left the freshly-spawned frontend
   pointed at that instead of starting a new server. Confirmed with the
   operator that this instance was safe to use (points at the real
   workspace) — but by the time that was confirmed, **that instance had also
   gone unreachable**, with no action taken against it beyond a health-check
   request.

19 `node.exe` processes were observed running system-wide at the time,
several with very recent start times — something on this machine appears to
be cycling/reaping node processes independent of anything done in this
session. This looks like a machine-level issue (resource pressure, an
AV/EDR process reaper, or similar) rather than a defect in the repair script,
the server, or this step's procedure. Cleaned up my own leftover processes
(a `npm run dev:frontend` wrapper and its spawned Vite child) before stopping.

**This is recorded as owed, not skipped.** The data mutation this step exists
to perform is done and independently verified safe (byte-verified backup,
correct liveness-probe handling, confirmed post-write file content, re-
confirmed unchanged after both crashes). The confirmation that the fix's
*guard* holds under a fresh analysis pass — the actual point of the A34 chain,
per the issue's own text — has not been observed and needs a stable box.

## Result

- **Backup**: verified byte-identical to pre-apply live state before any
  write. ✅
- **Apply**: succeeded for the one confirmed pair; live `cast.json` id
  confirmed `oduvan` (ASCII) by direct read, 3 times across this session. ✅
- **Re-test**: not performed. Blocked by repeated, unexplained server deaths
  on this box, unrelated to the repair itself. **Owed** — needs a stable
  server session to complete: start the app, re-analyze *Заказ Коалфолла*,
  confirm the id holds `oduvan`.

## Re-test attempt 4 (2026-09-09, fresh queue claim) — same failure, cleaner repro

Re-confirmed the live `cast.json` id was still `oduvan` (unaffected by the
three prior attempts) before starting.

This attempt avoided the browser/frontend path entirely, to rule out anything
UI-side: started `server/dist/index.js` directly (`WORKSPACE_DIR` pointed at
the real workspace, `PORT=8155`, `LAN_HTTPS_PORT=8446` to avoid the standing
`:8443` LAN dev server), confirmed it up via a plain HTTP probe, then drove
the re-analysis with a single `curl -N` SSE request to
`POST /api/manuscripts/mns_af35ec3ced/analysis` with `{"fresh": true}` —
no browser, no Vite dev proxy, nothing that a prior attempt's notes flagged as
a possible contributor.

Server came up clean, the sidecar's TTS subprocess (`qwen3-tts-1.7b`) failed
to spawn 6 times and gave up (`TTS is DOWN; restart the server to recover` at
06:50:42.871) — unrelated to text analysis, no impact expected. The actual
character-detection analysis (`phase=0`) proceeded normally: chapter 2/3
finished cast detection at 06:51:08.993 ("5 characters in 52s"); chapter 3/3
was still waiting on an Ollama response (45s+) at 06:51:01.890. **The server
process (and its wrapping PowerShell host) then disappeared entirely between
06:51:08.993 and the next poll ~5s later** — no further log lines, no error,
no exit code, `Get-Process` on its PID returned nothing, the port stopped
listening. The `curl` client's connection simply dropped (process exited on
its own, not killed by the polling loop, which was still under its 900s
`-m` cap).

This is the same silent-death signature the three prior attempts on
2026-09-06/07/08 recorded, reproduced with a strictly simpler request path
(no browser, no proxy) — evidence against a browser- or Vite-specific cause
and for a machine-level one. At the time of the crash the box was running
~14 other `node.exe` processes and 2+ `ollama`/`python` model-serving
processes at once (consistent with the several concurrent agent lanes this
box runs), matching the earlier attempts' observation of unusually high
`node.exe` counts each time this step has been tried.

`cast.json` re-checked immediately after the crash: still `id: "oduvan"`,
unaffected — the analysis died before writing any result back, so this
attempt changed nothing about the already-applied, already-verified repair.

**Still owed, now with a fourth reproduction ruling out browser/proxy causes.**
Left as `AGENT BLOCKED` asking the operator whether other box work can be
quieted for a retry, per the same request that unblocked the 2026-09-08
attempt.

## Re-test attempt 5-6 (2026-09-09, post-reboot) — CLOSED, `oduvan` confirmed to hold, plus a self-inflicted detour and its recovery

The box was rebooted between attempt 4 and this one (operator, to recover a
dropped eGPU on an unrelated ticket). Confirmed the box was genuinely quiet
before starting (no vitest/node battery running) — a live 13-worker vitest
battery in the **primary checkout** was observed mid-run at one point and this
attempt waited for it to clear rather than compete with it, which attempts
1-4 never checked for.

Started `server/dist/index.js` directly (`WORKSPACE_DIR=C:\AudiobookWorkspace`,
`PORT=8156`), confirmed healthy. The TTS sidecar failed to spawn and gave up
after 6 attempts — same as attempt 4, unrelated to text analysis, no impact.

**Attempt 5 (self-inflicted regression, then recovered).** Reused attempt 4's
exact recipe verbatim, including `{"fresh": true}` in the analysis POST body —
**this was a mistake, not a repro of the prior failure.** The request
completed cleanly this time (server did NOT crash — first clean completion in
five tries), but `{"fresh": true}` is the app's own "Start Fresh" mode
(`server/src/routes/analysis.ts:3803`, `requestedFresh` branch): it explicitly
deletes `cast.json` and the reuse-carryover, and drops the cast-merge/dedup
journals, before re-analysing from nothing — "fresh run regenerates ids from
scratch, so old lineage is meaningless" per its own comment. Regenerating
`oduvan` from raw manuscript text with no existing `cast.json` to reconcile
against reproduced the ORIGINAL A34 bug live: the character came back as
`одуван` (Cyrillic), and — because the reconciliation pipeline recorded this
as a legitimate id migration — **wrote a wrong-direction entry
(`"oduvan": "одуван"`) into the real `cast-id-history.json`**, i.e., this
attempt's own methodology error corrupted the retirement record on the actual
book, not a defect the row was testing for. A same-recipe follow-up with the
`fresh` flag simply omitted (an ordinary re-analysis) faithfully re-confirmed
`одуван` per that now-bad history — correct behaviour given corrupted input,
not a second bug.

**Recovery, using the repair tool itself.** `node
scripts/repair-a34-wrong-direction-ids.mjs` (dry run) correctly detected the
exact wrong-direction pattern it exists to catch:
`[Castwright / Standalones / Заказ Коалфолла] would reinstate "oduvan" (was
"одуван", "Одуван")`. Stopped the retest server (the script's own liveness
probe refuses `--apply` against a live one), then re-ran with `--apply`
(`ALLOW_STANDING_PORTS=8090` for `llama-swap`, the documented exception):
wrote `cast.json` (id back to `oduvan`) and `cast-id-history.json` (direction
corrected to `"одуван": "oduvan"`), with byte-verified `.bak.a34-*` copies of
both. Read the full character roster back afterward — all 15 ids ASCII/sane,
nothing else disturbed by the fresh-mode detour.

**Attempt 6 (the actual, correctly-parameterised re-test) — CONFIRMED.**
Relaunched the server, POSTed an ordinary re-analysis (`{}`, no `fresh` flag)
against the now-repaired book. Completed cleanly (server stayed healthy
throughout, 75 KB SSE response, no crash — second clean completion in a row
once the box was actually quiet). Read `cast.json` directly afterward:
`id: "oduvan"` — **holds** under a genuine fresh manuscript re-analysis, which
is the row's actual criterion.

**Root cause of attempts 1-4's crashes was very likely box contention, now
resolved separately** (this attempt's own vitest-battery observation, plus
the reboot). No further crash occurred once the box was confirmed quiet.

**Root cause of the `{"fresh": true}` mistake, for whoever reads this next:**
`{"fresh": true}` is the "Start Fresh" feature, not a plain re-analysis
trigger — it is documented in the route's own comments to intentionally
discard id lineage. Any future re-test of an id-retirement fix must use an
ordinary `POST .../analysis` body (`{}`), never `fresh: true`. Attempt 4's own
recipe already carried this mistake; it went unnoticed there only because the
crash happened before the flag's effect could matter.

## Result (final)

- **Backup**: verified byte-identical to pre-apply live state before any
  write. ✅
- **Apply**: succeeded for the one confirmed pair; live `cast.json` id
  confirmed `oduvan` (ASCII) by direct read, repeatedly across every session
  including this one. ✅
- **Re-test**: **CONFIRMED.** A genuine ordinary full-manuscript re-analysis
  (no `fresh` flag) against the repaired book holds `id: "oduvan"`
  afterward — attempt 6, 2026-09-09. The self-inflicted `fresh:true` detour in
  attempt 5 is documented above and was fully recovered via the repair
  script's own `--apply`, which also validates the script correctly detects
  and fixes a freshly-created (not just historical) instance of the
  wrong-direction pattern.
