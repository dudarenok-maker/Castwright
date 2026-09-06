# Step 2 — E10 `npm run stop` four-way discrimination test

Issue: [#2959](https://github.com/dudarenok-maker/Castwright/issues/2959) · Parent
[#2948](https://github.com/dudarenok-maker/Castwright/issues/2948), campaign #2435.

Confirms register row **E10** (now discharged and removed from the register;
was `docs/testing/onbox-acceptance-register.md` `### E10`): does `npm run stop`
(`scripts/stop-app.ps1`) stop only the checkout
it is run from, leaving a second, separate checkout's sidecar/Vite/server
completely untouched — including the pass-8-regression pair (the **other**
checkout's Vite+server surviving), which the row's own text says was found
backwards once and never confirmed end-to-end since.

## Setup

- Checked `netstat -ano | findstr LISTENING` first — ports 8090/8200/8270/8700/
  9120/9190 etc. were already held by other live lanes on this box, so slot
  numbers were **not** hand-picked.
- Two throwaway worktrees created from the primary checkout
  (`C:\Claude\Projects\Audiobook-Generator`) via `node scripts/wt-new.mjs`,
  which auto-assigns a non-colliding port slot from the current worktree
  count:
  - **Checkout A**: `C:\Claude\Projects\wt-e10-checkout-a`, branch
    `chore/ops-e10-checkout-a`, slot 20 → `VITE_PORT=5373`, `PORT`/
    `VITE_API_PORT=8280`, `LOCAL_TTS_PORT=9200`.
  - **Checkout B**: `C:\Claude\Projects\wt-e10-checkout-b`, branch
    `chore/ops-e10-checkout-b`, slot 21 → `VITE_PORT=5383`, `PORT`/
    `VITE_API_PORT=8290`, `LOCAL_TTS_PORT=9210`.
  - Both created sequentially (not in parallel) so the slot counter couldn't
    race and hand out the same slot twice.
- `server/tts-sidecar/.venv` and `server/tts-sidecar/voices` junctioned into
  both worktrees from the primary checkout (`cmd /c mklink /J`), per CLAUDE.md
  "Worktree setup" step 2 — needed for the sidecar to actually boot a real
  model instead of throwing `Kokoro model not found`.
- Both started with `npm run dev` (exercises the full PowerShell four-way
  check, including Vite, which `stop-app.ps1` covers and `stop-app.mjs`/
  `npm run stop:prod` does not).

## Both stacks confirmed healthy before the test

`GET /api/setup/readiness` on both, before touching anything:

- Checkout A (`:8280`): `{"ready":true,...,"sidecar":{"status":"pass",...},"tts":{"status":"pass",...}}`
- Checkout B (`:8290`): same, `"ready":true`, sidecar/tts both `pass`.

Real PIDs recorded via `netstat -ano` cross-referenced against
`Get-CimInstance Win32_Process` (not asserted):

| Checkout | Vite (:5373/:5383) | Server (:8280/:8290) | Sidecar (:9200/:9210) |
|---|---|---|---|
| A | 32944 | 33964 | 1120 (bound; server's own `[sidecar] spawned pid=43260` — see note on PID drift below) |
| B | 5156 | 30992 | 40088 (bound; server's own spawned pid=35524) |

Each checkout's `.run/tts.owner.<port>.json` existed and was keyed by its own
port (`tts.owner.9200.json` in A, `tts.owner.9210.json` in B) — consistent
with E101's port-keyed owner-note behavior, though E101 itself is out of scope
for this issue.

## The four required observations

Ran `npm run stop` from **checkout A only**. Immediately after (`stop-a.log`):

```
[STOP] tts pid=43260
[SWEEP] killed pid=33964 on :8280
[SWEEP] killed pid=32944 on :5373
```

`netstat -ano` and `Get-CimInstance Win32_Process` immediately after, real
PIDs pasted:

1. **Checkout A's own sidecar (`:9200`, pid 1120) is dead** — port gone from
   `netstat`, `Get-CimInstance -Filter "ProcessId=1120"` returns nothing.
2. **Checkout B's own sidecar (`:9210`, pid 40088) is STILL alive** —
   `netstat` still shows it `LISTENING`, `Get-CimInstance` confirms
   `python.exe` at pid 40088 unchanged.
3. **Checkout A's own Vite (pid 32944) and server (pid 33964) are dead** —
   both gone from `netstat` and from `Get-CimInstance`.
4. **Checkout B's own Vite (pid 5156) and server (pid 30992) are STILL
   alive** — both `node.exe`, unchanged, still `LISTENING` on `:5383`/`:8290`.
   **This is the pair pass 8 found backwards; it holds correctly here.**

All four confirmed with real PIDs, not asserted. Checkout B's stack was
completely undisturbed by stopping checkout A.

Checkout B was then stopped by us (`npm run stop` from B):

```
[STOP] tts pid=35524
[SWEEP] killed pid=30992 on :8290
[SWEEP] killed pid=5156 on :5383
```

## Important anomaly found during cleanup verification (not a discrimination failure)

A few minutes after both stops, a **routine re-check** of `:9200`/`:9210`
(done to confirm nothing was left running before teardown) found **both
ports listening again**, each under a **new** PID not present in any of the
above (`:9200` → pid 15064, parent 34000; `:9210` → pid 34436, parent 34800)
— both `python.exe` under each checkout's own `.venv` path (confirmed via
`CommandLine`, not assumed).

Root cause, read directly from `dev-a.log`/`dev-b.log`, is **not** a
discrimination bug (it never crossed checkouts) but a **race between the
sidecar's own in-process supervisor and the moment `stop-app.ps1`'s sweep
records/kills a PID**:

- Checkout A: sidecar spawned at `10:40:51`; at `10:42:46` the server's own
  `[tts:catalog-audit]` timed out waiting 120s for `:9200/speakers` (slow
  model load), and at `10:42:47` the sidecar child exited (code=1) — the
  server's **own supervisor** logged `respawning in 2000ms (attempt 1/5)`
  and spawned a **replacement child (pid=5384)** at `10:42:49`, independent
  of and prior to our `npm run stop` call. `stop-app.ps1`'s sweep, run after
  this, killed the **stale** pid `43260` from the owner note/first-spawn
  log line — a no-op, since that pid had already exited two minutes earlier
  — and never touched the live replacement lineage (5384 → uvicorn parent
  34000 → worker 15064), which survived the sweep as an orphan bound to
  `:9200`.
- Checkout B: same mechanism, but the timing coincided much more closely
  with our own stop call — the child-exit/respawn (`attempt 1/5`, new
  pid=18572) is logged at `10:44:03`–`10:44:05`, essentially the same moment
  `npm run stop` was run from B. This suggests `stop-app.ps1` killing the
  *previous* sidecar pid can itself trigger the supervisor's respawn (the
  child's exit event fires before the parent Node process receives its own
  kill signal), leaving the brand-new replacement child alive as an orphan
  the sweep never sees.

Both orphans (pid 15064 tree, pid 34436 tree) were confirmed to still be
correctly checkout-scoped (no cross-contamination — A's orphan stayed on
`:9200` under A's `.venv` path, B's on `:9210` under B's) and were killed by
us (`taskkill /F /T`) before teardown, confirmed gone from `netstat`
afterward.

**This does not overturn the four required observations above** — at the
instant each was checked, all four held with real, verified PIDs. It is a
distinct, real gap worth flagging to the operator separately: `stop-app.ps1`'s
sidecar-kill step resolves the pid to kill from a point-in-time source (the
owner note / first-spawn log line) that can go stale within the same
`npm run dev` session if the sidecar's own supervisor has already respawned
it once — under real Kokoro/Qwen model-load latency (>120s here) this is not
a rare edge case. Recommend a follow-up issue against `stop-app.ps1`/
`stop-app.mjs`'s sidecar resolution rather than folding it into this row,
since E10's own four-way discrimination claim is unaffected.

## Cleanup and teardown

- Confirmed via `Get-CimInstance Win32_Process` that nothing referencing
  either throwaway worktree's path remained running, after killing the two
  orphans above.
- Junctions removed **before** worktree removal, per CLAUDE.md's "Worktree
  teardown" recipe (`[System.IO.Directory]::Delete($path, $false)`, gated on
  `ReparsePoint`, never `Remove-Item -Recurse`) — verified the primary
  checkout's real `server/tts-sidecar/.venv` and `voices/` were untouched
  (`Test-Path` → `True` on both after junction removal) and both worktrees'
  junction paths were gone (`Test-Path` → `False` on all four).
- `git worktree remove --force` for both, then `git branch -D` for both
  throwaway branches. `git worktree list` afterward shows neither.

## Optional 5th observation — primary checkout, nothing running

Checked `netstat` first: no listener on the primary's default ports
(`:5173`/`:8080`/`:9000`) — safe to run directly, no other lane's process at
risk. Ran `scripts/stop-app.ps1` in the primary checkout
(`C:\Claude\Projects\Audiobook-Generator`) with nothing live:

```
[GONE] server pid=27112 (already exited)
[STOP] tts pid=14384
```

No raw `ParameterBindingValidationException` — the script read stale
`.run/server.pid`/`.run/tts.pid` files left from a much earlier run and
handled the "already exited" case gracefully for the server pid. It does not
print an explicit `[OK] nothing to stop` line the way the task text
speculated; instead it reports per-target status (`[GONE]`/`[STOP]`) for
whatever stale PID files it finds, without erroring. Post-check confirmed pid
`14384` does not currently exist on the box (`Get-CimInstance` empty) and no
other lane's process was observed to disappear around this check.

## Verdict: PASS

All four required E10 observations hold, with real PIDs pasted at each step:
checkout A's own sidecar/Vite/server die on `npm run stop`, and checkout B's
sidecar/Vite/server — the pass-8-regression pair included — survive
untouched. The optional primary-checkout check ran cleanly with no exception.
One adjacent anomaly (sidecar-supervisor-respawn orphan surviving the sweep)
was found, is checkout-scoped and non-cross-contaminating, was cleaned up,
and is flagged above as a candidate follow-up rather than a failure of this
row's own claim.
