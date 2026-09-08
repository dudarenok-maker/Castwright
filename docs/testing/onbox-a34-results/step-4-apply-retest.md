# A34 step 4 — backup, apply the repair for real, re-test the fix

Register row A34 (#2584, #2040), parent #2903, chain issue #2906.

**Status: repair applied and verified. Re-test NOT completed — blocked by
environment instability on this box (see below). Recorded as owed, not
silently skipped.**

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
