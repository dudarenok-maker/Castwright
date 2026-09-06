# Step 3 — E101 shared-run-dir owner-note collision test

Issue: [#2955](https://github.com/dudarenok-maker/Castwright/issues/2955) · Parent
[#2948](https://github.com/dudarenok-maker/Castwright/issues/2948), campaign #2435.

Confirms register row **E101** (now discharged and removed from the register;
was `docs/testing/onbox-acceptance-register.md` `### E101`): when two
checkouts share ONE `.run/` directory (via
`APP_RUN_DIR`), the port-keyed TTS owner-note files
(`.run/tts.owner.<port>.json`) coexist without collision instead of both
writing to one fixed filename. Mechanism under test:
`server/src/tts/sidecar-owner.ts` — `sidecarOwnerPath()` keys the filename by
port; `claimSidecarOwnership()` writes it at server startup, before the
sidecar necessarily finishes loading any model.

## Setup

- Checked `netstat -ano | findstr LISTENING` first — ports 8090/8200/8220/
  8270/8700/9120/9140/9190 etc. were already held by other live lanes on this
  box, so slot numbers were **not** hand-picked.
- Two throwaway worktrees created from the primary checkout
  (`C:\Claude\Projects\Audiobook-Generator`) via `node scripts/wt-new.mjs`,
  which auto-assigns a non-colliding port slot from the current worktree
  count:
  - **Checkout A**: `C:\Claude\Projects\wt-e101-checkout-a`, branch
    `test/ops-e101-checkout-a`, slot 20 → `VITE_PORT=5373`, `PORT`/
    `VITE_API_PORT=8280`, `LOCAL_TTS_PORT=9200`.
  - **Checkout B**: `C:\Claude\Projects\wt-e101-checkout-b`, branch
    `test/ops-e101-checkout-b`, slot 21 → `VITE_PORT=5383`, `PORT`/
    `VITE_API_PORT=8290`, `LOCAL_TTS_PORT=9210`.
  - Both created sequentially (not in parallel) so the slot counter couldn't
    race and hand out the same slot twice.
- `server/tts-sidecar/.venv` and `server/tts-sidecar/voices` junctioned into
  both worktrees from the primary checkout (`cmd /c mklink /J`), per
  CLAUDE.md "Worktree setup" step 2 — needed for the sidecar to actually boot
  a real model instead of throwing `Kokoro model not found`.
- In BOTH worktrees' own `server/.env`, added one extra identical line:
  `APP_RUN_DIR=C:\Claude\Projects\wt-e101-shared-rundir` — a plain new
  directory outside either worktree, created fresh for this test.
- Both started with `npm start` (only the server+sidecar pair matters for
  this row, not Vite).

## Confirming the shared run-dir mechanism

`server/src/app-dirs.ts`'s `resolveRunDir()` honours `APP_RUN_DIR` when set,
falling back to `<repoRoot>/.run` otherwise — both worktrees pointed at the
same absolute path, so both servers' `claimSidecarOwnership()` calls wrote
into the SAME physical directory (`C:\Claude\Projects\wt-e101-shared-rundir`),
not into their own per-worktree `.run/`.

## PIDs recorded at spawn

`start-app.ps1`'s own `[START]` lines (Node-side wrapper PIDs — see PID-drift
note in step-2's evidence for why these differ from the sidecar-owner note's
recorded PID):

| Checkout | Frontend PID | Server (wrapper) PID |
|---|---|---|
| A | 14212 | 33012 |
| B | 6852 | 35940 |

Real process tree cross-referenced via `Get-CimInstance Win32_Process`
(command lines pasted, not asserted):

| Checkout | tsx-watch (server) | actual server process (owner-note pid) | sidecar (uvicorn/python) |
|---|---|---|---|
| A | 43428 | **1240** | 8380 (`:9200`) |
| B | 11696 | **35144** | 34676 (`:9210`) |

## Observation — the acceptance criterion

`GET`-equivalent (direct file read) on
`C:\Claude\Projects\wt-e101-shared-rundir\` after both stacks reported their
server startup lines, **before** either sidecar necessarily finished loading
its model (`/api/setup/readiness` on both `:8280` and `:8290` still reported
`"sidecar":{"status":"fail","cause":"unreachable-transient","message":"The
voice engine is starting up."}` at the moment these files were captured —
exactly the "you do NOT need to wait for a GPU model load" case the issue
brief calls out):

Both files existed simultaneously in the ONE shared directory, each keyed by
its own port, each with a DIFFERENT `pid`:

**`tts.owner.9200.json`** (checkout A):
```json
{"pid":1240,"ppid":43428,"port":9200,"startedAt":"2026-09-06T01:06:36.804Z"}
```

**`tts.owner.9210.json`** (checkout B):
```json
{"pid":35144,"ppid":11696,"port":9210,"startedAt":"2026-09-06T01:06:38.904Z"}
```

`pid` 1240 matches checkout A's own tsx-watch child (parent pid 43428, which
also matches the note's own `ppid`); `pid` 35144 matches checkout B's own
tsx-watch child (parent pid 11696, matching its `ppid`) — confirmed via the
`Get-CimInstance` process tree above, not merely asserted from the JSON.
Neither file was overwritten, truncated, or corrupted by the other server's
concurrent write to the same directory — this is the entire E101 acceptance
criterion, and it held.

## Cleanup and teardown

- Stopped both stacks: `npm run stop` from checkout A (`[STOP] frontend
  pid=14212`, `[STOP] server pid=33012`), then from checkout B (`[STOP]
  frontend pid=6852`, `[STOP] server pid=35940`).
- Confirmed via `Get-CimInstance Win32_Process`, checked individually by PID,
  that every process in both stacks' trees was dead: `38264, 43428, 1240,
  19920` (checkout A: vite, tsx-watch, server, esbuild) and `21284, 11696,
  35144, 26088` (checkout B: same roles) plus both sidecar `start.ps1`/
  `python.exe` pairs (`42688, 8380` and `27768, 34676`) and both `[START]`
  wrapper PIDs (`14212, 33012, 6852, 35940`) — all confirmed dead, none left
  running.
- Junctions removed **before** worktree removal, per CLAUDE.md's "Worktree
  teardown" recipe (`(Get-Item $p -Force).Delete()`, gated on
  `ReparsePoint`, never `Remove-Item -Recurse`) — verified the primary
  checkout's real `server/tts-sidecar/.venv` and `voices/` remained real
  directories (not reparse points) afterward, untouched.
- `git worktree remove --force` for both (needed: each had untracked/modified
  `server/.env`, installed `node_modules`, and log files — never committed,
  per this step's "do not commit inside the throwaway worktrees" rule), then
  `git branch -D` for both throwaway branches. `git worktree list` afterward
  shows neither.
- Shared run-dir scratch folder (`C:\Claude\Projects\wt-e101-shared-rundir`)
  deleted.

## Verdict: PASS

E101 holds: two server stacks sharing one `APP_RUN_DIR` each wrote their own
port-keyed owner-note file into that shared directory, both coexisted with
distinct PIDs, and observation was made before either sidecar's model finished
loading — exactly the acceptance text's claim. Both throwaway worktrees and
the shared run-dir were fully torn down; the primary checkout's real `.venv`/
`voices` directories were confirmed untouched.
