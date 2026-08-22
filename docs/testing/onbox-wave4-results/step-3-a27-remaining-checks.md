# Wave 4 step 3 — A27's two remaining checks (mixed-fault precedence, Coqui absent)

Run against Castwright#2556. Reproduces wave 3's harness recipe
(`docs/testing/onbox-wave3-results/step-3-sidecar-install-config-reach.md`)
against a **throwaway robocopy** of the live sidecar venv
(`server/tts-sidecar/.venv`, main checkout).

**Run by:** claude. **Date:** 2026-08-21.

## Harness

1. `robocopy` the live venv (`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv`,
   6.038 GB) to a throwaway scratch path. Result: `Dirs: 6087/6087, Files:
   56542/56542, Bytes: 6.038g/6.038g, FAILED: 0`.
2. Removed `kokoro_onnx` + `kokoro_onnx-0.5.0.dist-info` from the copy (Kokoro
   **missing**).
3. Appended `raise RuntimeError("onbox #1965 mixed-fault precedence test -
   forced qwen import break")` to the copy's `qwen_tts/__init__.py` (Qwen
   **broken** — `find_spec` still succeeds, `import` raises).
4. Started a standalone sidecar (`server/tts-sidecar/start.ps1`, not through
   the Node supervisor) with `SIDECAR_VENV_DIR` pointed at the throwaway copy
   and `LOCAL_TTS_PORT=9111`, isolated from the box's shared :9000 sidecar.
5. Started the worktree's Node server (`npm --prefix server run dev`) with
   `DISABLE_AUTOSTART_SIDECAR=1`, its own `PORT=8170`, a throwaway
   `WORKSPACE_DIR`/`USER_SETTINGS_FILE` under scratch, so it never touches the
   real workspace or the shared machine-wide settings file.
6. Junctioned this worktree's `server/tts-sidecar/.venv` → the throwaway copy,
   because the Node-side disk probes (`venvCorePackageInstalled`,
   `sidecarVenvPresent`, each engine's `packageInstalledOnDisk`) resolve the
   venv path from `repoRoot` directly and do **not** honour
   `SIDECAR_VENV_DIR` — only the Python-side `start.ps1` does. Without the
   junction, `GET /api/setup/readiness` reported `sidecar.cause:
   'venv-missing'` and short-circuited `diagnoseTts` to `'sidecar-blocked'`
   before it ever reached the missing/broken precedence logic.
7. **Defect found in passing — `LOCAL_TTS_URL` does not isolate the Node
   server's sidecar target once the process has booted.** See "Defect" section
   below. Worked around with an explicit `PUT /api/user/settings
   {"sidecarUrl":"http://localhost:9111"}` after boot.

## Check 1 — Mixed-fault Setup-checker precedence

**Setup:** Kokoro missing (removed from copy) **and** Qwen broken (raise
appended) simultaneously, both forced through a real `/load` attempt so the
live signals are recorded (not left at the `null` never-attempted baseline).

Null baseline, before any load (sidecar freshly (re)started against the
mutated copy — this exact baseline is from the second sidecar run, which also
has Coqui removed for check 2; Kokoro/Qwen states are unaffected by that):

```
$ curl -s http://127.0.0.1:9111/health
kokoro_package_installed: false, kokoro_import_ok: null
qwen_package_installed: true,   qwen_import_ok: null
```

Forced both loads:

```
$ curl -s -X POST http://127.0.0.1:9111/load -d '{"engine":"kokoro"}'
{"status":"error","error":"Internal error."}
$ curl -s -X POST http://127.0.0.1:9111/load -d '{"engine":"qwen"}'
{"status":"error","error":"Internal error."}
```

Health after both loads — **both faults live at once**:

```
kokoro_import_ok: false, kokoro_package_installed: false   -- missing
qwen_import_ok: false,   qwen_package_installed: true      -- broken
```

`GET /api/setup/models-status` (via the isolated Node instance, sidecarUrl
override applied) — the packageFault classification per engine:

```
kokoro: { state: 'not-installed', packageBroken: false, packageFault: 'missing' }
qwen:   { state: 'ready',         packageBroken: true,  packageFault: 'broken'  }
```

**`GET /api/setup/readiness` (the Setup checker — `setup-diagnosis.ts`'s
`diagnoseTts`) — real, pasted output:**

```json
{
  "ready": false,
  "blockers": {
    "sidecar": { "status": "pass", "cause": "pass", "message": "Voice engine ready.", "remediation": "" },
    "tts": {
      "status": "fail",
      "cause": "package-broken",
      "message": "The Qwen package is present but will not import in the voice engine runtime.",
      "remediation": "Repair Qwen in Model Manager.",
      "action": { "kind": "qwen-install", "label": "Repair Qwen3-TTS" }
    }
  }
}
```

**Names Qwen, not Kokoro** — exactly the row's requirement. The precedence
rule in `setup-diagnosis.ts:219-228` (`kokoroPackageFault === 'broken' ?
'kokoro' : qwenPackageFault === 'broken' ? 'qwen' : ...`) checked first for
`kokoro === 'broken'` (false — Kokoro is `'missing'`), then for `qwen ===
'broken'` (true) → named Qwen. **DISCHARGED**, live-confirmed, both faults
demonstrably present at once (not just one — see the health payload above).

## Check 2 — Coqui stays out of diagnostics when absent

**Setup:** same throwaway copy, with Coqui's package (`TTS/` +
`coqui_tts-0.27.5.dist-info` + `coqui_tts_trainer-0.3.3.dist-info`) removed
entirely (find_spec-level absence — mirrors how Kokoro's "missing" state was
manufactured). Combined with check 1's mixed-fault state in the same sidecar
run (both faults are still live), since a plain reachable-and-healthy sidecar
wouldn't exercise the Voice engine row's fail path at all.

Sidecar startup log confirms real absence, not just find_spec luck:

```
[sidecar] Coqui package not installed -- skipping the TTS.api import-order pin.
```

Health confirms the clean "never attempted" baseline for Coqui (never `false`,
which would mean a fault was recorded without a real attempt):

```
coqui_import_ok: null, coqui_package_installed: false
```

**`GET /api/diagnostics` (Admin console, Voice engine row) — real, pasted
output:**

```json
{
  "overall": "fail",
  "checks": [
    {
      "id": "sidecar",
      "label": "Voice engine",
      "status": "fail",
      "detail": "reachable · Kokoro package missing — install in Model Manager, Qwen package will not import — repair in Model Manager"
    }
  ]
}
```

The Voice engine row names **Kokoro and Qwen's real faults only** — Coqui,
despite being genuinely absent from the venv, produces **no** entry, no
mention, and no separate fault string. `overall: 'fail'` is caused entirely by
Kokoro/Qwen (both genuinely broken in this same run); Coqui's absence does not
itself flip anything to fail or add its own line. **DISCHARGED.**

## Live-safety verification

- **Live venv byte-check** (`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv`):
  `kokoro_onnx`, `qwen_tts`, `TTS` (coqui) packages and both dist-info sets all
  present. `kokoro_onnx/__init__.py` tail ends at the original `get_voices`
  method — no injected `raise`. `qwen_tts/__init__.py` tail ends at `__all__ =
  ["__version__"]` — no injected `raise`. Never opened for writing this run;
  every mutation happened on the throwaway robocopy only.
- **The throwaway copy** was deleted at teardown (`rm -rf` the scratch
  `venv-copy` directory) after both sidecar processes were stopped.
- **The worktree's `.venv` junction** (created to make the Node-side disk
  probes see the throwaway copy — see harness step 6) was removed via
  PowerShell's `[IO.DirectoryInfo]::Delete()` (removes the reparse point only,
  never touches the junction's target contents) before the target was
  deleted, and confirmed gone (`Test-Path` → `False`) before this file was
  written.
- **The box's shared, live :9000 sidecar** was never contacted by this run —
  every request from this run's isolated Node server explicitly targeted
  `:9111` via a `sidecarUrl` override (see Defect below); no `/health` probe,
  forced load, or restart was ever sent to `:9000`. (An unrelated probe of
  `:9000` at teardown, purely to sanity-check the box, showed it currently
  reflects some other lane's own in-progress venv mutation — not this run's
  doing, and not touched by this run.)
- This worktree's own checkout: `git status --short` clean before this commit
  (only this evidence file and the register's own accounting are new).
- Both isolated processes (sidecar :9111, Node server :8170) were stopped at
  teardown; `netstat` confirms no LISTENING socket remains on either port.

## Defect found in passing (not fixed — out of scope per the issue)

**`LOCAL_TTS_URL` does not isolate the Node server's outbound sidecar target
once the process has booted**, because `getResolvedSidecarUrl()`
(`server/src/workspace/user-settings.ts:464-466`) reads
`cached?.sidecarUrl ?? process.env.LOCAL_TTS_URL ?? DEFAULT_USER_SETTINGS.sidecarUrl`
— and `cached` is populated from `DEFAULT_USER_SETTINGS` (which hardcodes
`sidecarUrl: 'http://localhost:9000'`, `user-settings.ts:282`) as soon as the
settings cache warms, which `index.ts:132` does unconditionally at boot. Once
`cached.sidecarUrl` exists (always, after boot), the `?? process.env.LOCAL_TTS_URL`
fallback is dead code — the env var is only ever consulted in the narrow
window before the cache is first populated, which the app's own boot sequence
never leaves open.

**Repro, observed live in this run:** launched the isolated Node server with
`LOCAL_TTS_URL=http://localhost:9111` and `DISABLE_AUTOSTART_SIDECAR=1`.
`GET /api/setup/models-status` initially reported `qwen: { packageBroken:
true, packageFault: 'missing' }` and `coqui: { packageBroken: true,
packageFault: 'missing' }` — internally inconsistent (a "broken" package
can't also be "missing") and not matching either sidecar's real state, because
the server was silently querying the box's real, shared `:9000` sidecar the
entire time, not the isolated `:9111` one `LOCAL_TTS_URL` was supposed to
select. Explicitly overriding with `PUT /api/user/settings
{"sidecarUrl":"http://localhost:9111"}` immediately fixed it — `models-status`
then read `qwen: { packageFault: 'broken' }`, `coqui: { packageFault: 'ok' }`,
matching the sidecar's actual live health payload.

**Why this matters beyond this row:** wave 3's step 3 evidence
(`docs/testing/onbox-wave3-results/step-3-sidecar-install-config-reach.md`)
describes the identical `LOCAL_TTS_URL`-only isolation technique as
"re-derived and confirmed working" for A27's and A29's checks. Their pasted
Admin-console/Setup-checker strings for A27 happen to be unaffected either way
(mirrors this run's own single-fault results before the sidecarUrl override
was needed for the multi-fault case here — see Check 1 above, which initially
also misfired to `'ready'` for the same underlying reason before the override
was applied), but any future wave reusing this recipe **must** add the
explicit `PUT /api/user/settings {"sidecarUrl": ...}` step, or its "isolated"
reads may silently be the box's shared `:9000` sidecar instead. Not filing a
new tracked issue myself — flagging here per the issue's own "report, don't
fix" instruction; a human/step 6 should decide whether this needs its own
ticket alongside #2533.

## A27 — verdict

Taking wave 3's discharged set together with this step's two checks, every
check in the row's own criteria (`docs/testing/onbox-acceptance-register.md`,
row A27) is now exercised:

| Check | Evidence |
|---|---|
| Null baseline (`kokoro_import_ok`/`qwen_import_ok`: `null`, not `false`) | wave 3 (Kokoro), this step (Kokoro+Qwen, second sidecar run) |
| Kokoro broken-import state (`packageFault: 'broken'`, Admin console "will not import — repair") | wave 3 |
| Kokoro missing state (`packageFault: 'missing'`, Admin console "missing — install") | wave 3 |
| Model Manager Install/Repair toggle agreeing with its badge (#2010 m1) | wave 3 |
| Setup checker (`GET /api/setup/readiness`) naming Kokoro correctly for single-engine broken/missing | wave 3's disposition table (Setup-checker packageFault classification) |
| Qwen mirrored broken-import state | wave 3 |
| Qwen post-import over-claim case (`qwen_import_ok` stays `true`, no false Repair) | wave 3 |
| **Mixed-fault Setup-checker precedence (names Qwen, not Kokoro)** | **this step, Check 1** |
| **Coqui stays out of the diagnostics row when absent** | **this step, Check 2** |

**A27: DISCHARGED — no checks remain owed.**

Both new checks ran against a throwaway venv copy with real, pasted command
output; the live venv and the live `:9000` sidecar were never touched; the
copy and the worktree's `.venv` junction were both removed at teardown.
