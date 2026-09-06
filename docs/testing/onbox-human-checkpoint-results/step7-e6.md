# Step 7 — E6 observation 6, the venv-bootstrap failure path: CONFIRMED

Issue: Castwright#2987 ("Human-checkpoint batch step 7 - E6 observation 6
(venv-bootstrap failure path)"). Row E6
(`docs/testing/onbox-acceptance-register.md:4283`), on-box acceptance
register campaign (#2435), step 7 of #2978. Observations 1-5 were already
discharged in earlier waves; wave 4 explicitly declined observation 6
because inducing a real failure on the shared venv was too risky
(`docs/testing/onbox-acceptance-register.md:4343-4357`).

## Why this run never touched the shared `.venv`/`voices`

`server/tts-sidecar/scripts/bootstrap-venv.mjs` and
`server/src/diagnostics/venv.ts`'s `sidecarVenvPresent()` both resolve the
venv directory from `SIDECAR_VENV_DIR` (falling back to
`<repoRoot>/server/tts-sidecar/.venv` only when unset). Pointing that env
var at a brand-new, never-created temp directory for one scoped server
process makes the app see "venv absent" — the exact state E6 obs 6 needs —
without ever creating, deleting, or touching the real, junctioned
`server/tts-sidecar/.venv` / `voices` in this worktree.

To also make the *induced* venv-creation attempt fail (rather than
succeeding against a fresh, empty directory with the box's real Python),
this run additionally prepended a scratch directory to `PATH` containing a
tiny compiled shim (`py.exe`/`python.exe`, built with the box's own
`csc.exe` — no real interpreter touched):

- `py -3.12 --version` → prints `Python 3.12.0`, exit 0 (so
  `findPython312()` still reports a 3.12 interpreter present — the wizard
  must offer "Set up the voice engine runtime", not the separate
  "no Python found" degrade path).
- `py -3.12 -m venv <dir>` → prints a `RuntimeError` to stderr and exits 1
  (a genuine, realistic-shaped venv-creation failure).

Both overrides (`PATH`, `SIDECAR_VENV_DIR`) were scoped to one detached
`npm run dev` process for this worktree only, on this worktree's own ports
(VITE 5363 / API 8270 / TTS 9190 per `.env.local`/`server/.env`), never
exported to the box, another lane, or the primary checkout.

## Steps

1. Confirmed ports 8270/5363/9190 had no existing listener before starting.
2. Compiled the shim, wrote a helper script that sets `PATH` and
   `SIDECAR_VENV_DIR` for its own process tree only, then launched
   `npm run dev` detached (output to a per-run scratch log) from this
   worktree.
3. Server came up (`2026-09-07 08:50:58 [server] listening on
   http://localhost:8270`). The real TTS sidecar (which also inherited the
   fake `SIDECAR_VENV_DIR`) predictably crash-looped and gave up after 6
   rapid exits ("TTS is DOWN") — expected and harmless: it's an isolated
   side effect of the same scoping that keeps this observation off the
   shared install, not a bug being chased here.
4. Drove the Setup wizard via real browser automation (Playwright MCP:
   `browser_navigate`, `browser_click`, `browser_snapshot`,
   `browser_network_requests`) to `http://localhost:5363/setup`, into the
   "Voice engines: needs attention" checklist item → Step 4 of 8 (Voice).
   Confirmed the Voice diagnosis correctly read `venvPresent: false`,
   `pythonFound: true` (cause `venv-missing`), surfacing the "Set up the
   voice engine runtime" button.
5. Clicked "Set up the voice engine runtime" → `POST
   /api/setup/venv/bootstrap` (202) → job id `1`. Polled `GET
   /api/setup/venv/bootstrap/1`, which settled `status: "error"` with:

   ```json
   {
     "id": "1",
     "status": "error",
     "step": "creating venv at C:\\...\\fake-sidecar-venv",
     "error": "bootstrap-venv.mjs exited with code 1. Error: Command '['py.exe', '-m', 'venv', ...]' returned non-zero exit status 1.\r RuntimeError: [Castwright#2987 simulated] this interpreter cannot create a venv (broken install shim for E6 observation 6).\r [bootstrap-venv] FAIL: venv creation failed"
   }
   ```

   The UI rendered the red "Setup failed" card with this exact server
   message (not a generic fallback) — screenshot:
   `step7-e6-screens/step7-e6-setup-failed.png`.
6. Clicked "Try again" → a **fresh** `POST /api/setup/venv/bootstrap` (202)
   → job id `2` (confirmed via the network log, a new id rather than a
   replay of job `1`), which reproduced the same real failure end to end —
   confirming "Try again" genuinely re-triggers the job, not just re-renders
   stale state. Screenshot: `step7-e6-screens/step7-e6-try-again.png`.
7. Tore down this run's process tree (`taskkill /T /F` on the launcher
   PID; every child was this run's own — `npm run dev` → `concurrently` →
   `vite` / `tsx watch` → the sidecar child), confirmed via a follow-up
   `Get-NetTCPConnection` that 8270/5363/9190 had no live listener
   afterward (only stale `TIME_WAIT` sockets from the just-closed
   connections, owning PID 0). No other process on the box was stopped,
   killed, or restarted.
8. Confirmed the shared junctions were never touched — `Get-Item -Force`
   on both `server\tts-sidecar\.venv` and `server\tts-sidecar\voices`
   in this worktree, before and after, shows `LinkType: Junction` pointing
   at the same primary-checkout target both times.

## Verdict

**E6 observation 6 CONFIRMED.** A genuine "Setup failed" card rendered with
the server's real, non-generic error text (verbatim above), and "Try
again" produced a fresh job attempt (job id `2`, not a replay of job `1`) —
both captured with real browser automation and network evidence, not
asserted. The shared, junctioned `.venv`/`voices` were never created,
deleted, or modified — this observation's own env-scoped isolation
(`SIDECAR_VENV_DIR` + a scratch-only `PATH` shim, both confined to one
detached dev-server process) made touching them unnecessary, closing the
exact risk wave 4 flagged for leaving this observation unattempted.

Refs #2978, #2435, #2987
