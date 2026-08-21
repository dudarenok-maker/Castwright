# Wave 3 step 3 — sidecar install/repair + config-reach rows (A27, A29)

Run against Castwright#2505. Rows per `docs/testing/onbox-wave3-plan.md`'s Step
3 assignment: A27, A29. Both rows' full criteria live in
`docs/testing/onbox-acceptance-register.md` (no separate run sheet for either);
this file is the summary + defect record the issue asks for.

**Run by:** claude. **Date:** 2026-08-20.

## Re-resolution note (2026-08-20)

Re-read both rows in `docs/testing/onbox-acceptance-register.md` against the
live tree before running anything. Nothing excluded — A27's citations
(`#1965`/PR #1986, `#1999`/PR #2010) and A29's (PR #2008, closes #1988/#1989)
still match current code: `server/tts-sidecar/main.py`'s
`_record_qwen_import_result`/`_KOKORO_IMPORT_OK` wiring, `deriveEngineHealth`
(`server/src/tts/engine-health.ts`), `classifyPackageFault`
(`server/src/tts/models-status.ts`), and `model-paths.ts`'s
`currentAsrModel()`/`whisperRepoDir()` per-call resolution are all present and
unchanged in shape from the register's description. No prior step's plan
moved either row (`docs/testing/onbox-wave3-plan.md` §1 confirms Step 3 =
A27, A29 exactly).

## Environment note — the box's sidecar is single-instance, machine-wide

This mattered enough to both rows to record once, up front, rather than
repeat per-row. The Node server's sidecar spawn (`spawn-sidecar.ts`) always
probes/spawns on a **hardcoded default port (9000)**, independent of the
per-worktree `LOCAL_TTS_PORT` this worktree's own `.env.local` reserves
(9110) — confirmed by reading `spawnSidecar`'s `port = DEFAULT_PORT` default
and its one caller in `index.ts`, which never threads a port through.
`getResolvedSidecarUrl()`'s own default (`http://localhost:9000`,
`user-settings.ts:282`) and the persisted settings file
(`~/.castwright/user-settings.json`, machine-wide unless
`USER_SETTINGS_FILE` is set) confirmed the same thing from the client side: a
second full `npm run dev` stack in this worktree, unconfigured, silently
**adopted** the box's real, live sidecar on :9000 (verified by its
`qwen_package_installed:false` etc. not matching this worktree's own venv,
and by `netstat` showing a real listener with an unrelated PID). No mutation
happened during that adoption — it was a read-only `/health` probe before the
mismatch was caught — but it would have made every subsequent step in this
row run against the operator's live sidecar instead of an isolated one.

**Box-safe workaround used for the rest of this run:** a standalone sidecar
process (`server/tts-sidecar/start.ps1` invoked directly, not through the
Node supervisor) on an isolated port (9111), plus the Node server started
with `DISABLE_AUTOSTART_SIDECAR=1` (so it never touches :9000 at all) and
`LOCAL_TTS_URL`/`USER_SETTINGS_FILE` pointed at the isolated instance as a
pure HTTP client. This was re-derived and confirmed working (not assumed)
after the first two boot attempts silently adopted :9000. Live sidecar on
:9000 was read-only probed exactly once (see above) and never restarted,
loaded, or reconfigured by this run. Confirmed untouched at the end (see
Live-safety section).

## A27 — Kokoro/Qwen missing vs. present-but-unimportable

**Verdict: DISCHARGED for the sidecar-level and Admin/Setup-checker
copy claims. Two sub-checks not run (see below).**

Manufactured on a **throwaway robocopy of the live sidecar venv**
(`server/tts-sidecar/.venv`, 6.04 GB, copied to a scratch path — the row's
own instruction, since it edits a package's `__init__.py` in place). The live
venv was never opened for writing; verified byte-identical after (see
Live-safety section). Kokoro weight files (`kokoro-v1.0.onnx` +
`voices-v1.0.bin`) don't ship in this worktree (gitignored, not present) —
read-only copied in from the live checkout to exercise the Model
Manager/weights-present code paths, then deleted again at teardown.

### Null baseline

Confirmed **before any load attempt**, on the unmodified throwaway venv:

```
kokoro_import_ok: null, kokoro_package_installed: true
qwen_import_ok: null,   qwen_package_installed: true
```

Matches the row's requirement exactly — null, not false, on a healthy venv.

### State 1 — Kokoro present but unimportable (`raise RuntimeError('onbox #1965')` appended to `kokoro_onnx/__init__.py`, package left in place)

Forced a load via `POST :9111/load {"engine":"kokoro"}` (direct sidecar
call — the server's own readiness gate deliberately never calls `/load`
anymore, per `ensure-sidecar-loaded.ts`'s file header, so this is the correct
way to force the import chokepoint on demand).

```
kokoro_import_ok: false, kokoro_package_installed: true   -- the two disagreeing, as designed
```

Admin console's Voice engine row (`GET /api/diagnostics`, proxied through
the isolated Node instance):

```
"detail": "reachable · Kokoro package will not import — repair in Model Manager"
```

Exact copy match to the row's expected string.

Model Manager's real backing endpoint is `GET /api/setup/models-status`
(**not** `GET /api/models/inventory` — that one's coarser `installState`
enum collapses "broken" and "missing" into the same `package-missing` value
once a load has flipped `importOk` to a real `false`, because
`pkgUsable = importOk ?? pkgInstalled(...)` short-circuits on `false` same as
on `true`; the UI's actual Repair/Install decision reads a **different**
field, `packageFault`, from `models-status.ts`'s `classifyPackageFault`):

```
kokoro: { state: 'ready', packageBroken: true, packageFault: 'broken' }
```

`kokoro-install.tsx:154` branches on `status.state === 'package-missing'` for
weights-present-but-disk-only cases and separately keys its Repair label off
`packageFault`/`packageBroken` per `model-manager.tsx:88`
(`if (status.state === 'package-missing') return 'Repair'`) — confirmed by
reading the source, not just the payload; the live-confirmed `packageFault:
'broken'` is what drives Repair over Install.

### State 2 — Kokoro missing entirely (`kokoro_onnx` + its dist-info removed from the throwaway venv)

```
before load: kokoro_package_installed: false   (find_spec correctly fails)
after forced load: kokoro_import_ok: false, kokoro_package_installed: false
```

Admin console:

```
"detail": "reachable · Kokoro package missing — install in Model Manager"
```

Exact match, and correctly distinct from State 1's copy.

`/api/setup/models-status`:

```
kokoro: { state: 'package-missing', packageBroken: false, packageFault: 'missing' }
```

Correctly distinguished from State 1's `packageFault: 'broken'`. Model
Manager's own diskPath/size fields (`GET /api/models/inventory`) also
correctly reported the weights present but the package absent once the
Kokoro weight files were copied in (`installState: 'package-missing'`,
`present: true` — the coarse enum here is fine for this row's own criterion,
since it's the `models-status` payload above, not this one, that the
Repair/Install button reads).

### Qwen — mirrored broken-import case

Restored Kokoro clean, broke `qwen_tts/__init__.py` the same way, forced
`POST :9111/load {"engine":"qwen"}`:

```
qwen_import_ok: false, qwen_package_installed: true
/api/setup/models-status → qwen: { state: 'ready', packageBroken: true, packageFault: 'broken' }
```

Matches the Kokoro shape. DISCHARGED.

### Qwen — the over-claim case (post-import failure must NOT produce a false Repair prompt)

This is the row's most novel claim and the one most likely to silently
regress. Restored `qwen_tts/__init__.py` clean first (a genuinely working
import — the point is a failure *after* the import succeeds). Isolated the
sidecar's Hugging Face cache to a throwaway `HF_HOME` (a read-only robocopy
of just the 2.34 GB `models--Qwen--Qwen3-TTS-12Hz-0.6B-Base` snapshot — the
**real, shared** `~/.cache/huggingface/hub` was deliberately never renamed
in place, since it's machine-wide and other lanes may read it), renamed the
copied snapshot to `...-Base.bak`, started the sidecar with
`HF_HUB_OFFLINE=1` against that isolated cache, forced a Qwen load:

```
POST /load → 500 (Internal error)
kokoro-independent qwen_import_ok: true   -- STAYS true, does not flip to false
qwen_package_installed: true
qwen_weights_present: false               -- correct "knock-on", not a failure (row's own words)
```

Confirmed exactly what `main.py`'s own code comments describe:
`_record_qwen_import_result` wraps only the `from qwen_tts import
Qwen3TTSModel` statement; `from_pretrained` runs afterward and its failure
does not clear the already-recorded `true`. `/api/setup/models-status` (via
the isolated Node instance) read back `packageFault: 'ok'`,
`packageBroken: false` for this state — no false package-Repair prompt.
DISCHARGED for the sidecar-level claim. One caveat: the **Node-side** disk
weights-probe (`qwenWeightsPresent()`, used by `/api/setup/models-status`'s
own `state` field) reads a location independent of the sidecar's scoped
`HF_HOME`, so it did not itself flip to weights-missing in this run — an
artifact of running the two processes with deliberately different HF caches
for isolation, not a defect. The sidecar's own `/health` (the primary
source both the row and `model-paths.ts` describe) is unambiguous, so this
caveat doesn't weaken the DISCHARGE.

### Not run

- **Mixed-fault Setup-checker precedence** (Kokoro missing + Qwen broken
  simultaneously → checker must name Qwen). Not exercised — by the time the
  qwen isolated-broken and over-claim states were captured, reproducing the
  combined state would have meant a fourth full sidecar-restart cycle on top
  of the six already run for this row alone. **STILL OWED.**
- **Coqui-stays-out-of-diagnostics-when-not-installed.** Not exercised — this
  box's live venv has Coqui genuinely installed
  (`coqui_import_ok: true` throughout every state above), so there was no
  "Coqui absent" state to observe without a further venv mutation. **STILL
  OWED**, low risk (the Admin console's own STANDARD_TTS loop already reads
  as engine-scoped from the states above, and Coqui was never touched).

### Restore and final health

Restored both `__init__.py` files, restarted the sidecar against the
unmodified throwaway venv copy, forced both loads:

```
kokoro_import_ok: true, qwen_import_ok: true
kokoro_package_installed: true, qwen_package_installed: true
```

Admin console: `"detail": "reachable · kokoro, qwen"`, status `ok`.

## A29 — `qa.asr.model` reaches the sidecar and every server-side reader

**Verdict: DISCHARGED — all six checks run, real Hugging Face download.**

Prerequisite already satisfied without an edit: this worktree's `server/.env`
does not set `ASR_MODEL` (only `server/.env.example` ships the commented
default), so Advanced Configuration's override was never env-shadowed.

Ran against the **live sidecar venv, read-only** (`SIDECAR_VENV_DIR` pointed
at `server/tts-sidecar/.venv` in the main checkout — this row's own
precondition doesn't require a throwaway copy, unlike A27, since nothing is
edited in place; only an additive Hugging Face download happens, into the
real shared `~/.cache/huggingface/hub`), via the same isolated-port pattern
as A27 (standalone sidecar on :9111, Node server with
`DISABLE_AUTOSTART_SIDECAR=1` as a pure client) so the box's live :9000
sidecar was never restarted or reconfigured.

1. **Config reach to the resolver.** `PUT /api/config {"qa.asr.model":"small"}` →
   response confirms `"qa.asr.model":{"effective":"small","source":"override","overridden":true}`.
2. **Model Manager reflects the override before any download** (pure
   resolver read, no sidecar restart needed for this part):
   `GET /api/models/inventory` → whisper row's `diskPath` immediately became
   `...\models--Systran--faster-whisper-small` (not `...-base`), `present:
   false` (correctly — nothing downloaded yet).
3. **Real load + download.** Restarted the standalone sidecar with
   `ASR_MODEL=small` (mirrors what the Node supervisor's registry
   env-injection loop, `spawn-sidecar.ts`'s `buildSidecarEnv`, would inject
   on a real restart — see caveat below), then forced a real Whisper load
   via `POST :9111/transcribe` with one second of silent PCM (`/transcribe`
   is the only trigger for a lazy ASR load; there is no `/load` for the ASR
   engine). Result: `asr_loaded: true`, and
   `~/.cache/huggingface/hub` genuinely gained
   `models--Systran--faster-whisper-small` alongside the pre-existing
   `...-base` (additive, confirmed via directory listing before/after — the
   real network fetch this row exists to prove no unit test can substitute
   for).
4. **Model Manager reflects the real download:**
   `GET /api/models/inventory` → whisper row now `present: true, sizeBytes:
   486212412, diskPath: ...small, loaded: true`.
5. **Remove.** Restarted the sidecar fresh (so the model was unloaded —
   the removal guard correctly refuses to delete a loaded model) and called
   `POST /api/models/whisper/remove` → `{"removed":true,"freedBytes":486212412}`.
   Confirmed via directory listing: `...-small` deleted, `...-base`
   untouched — the exact inverse of the pre-fix bug PR #2008 describes.
6. **In-app installer path.** `node server/tts-sidecar/scripts/install-whisper.mjs --model small`
   (mirrors what the in-app installer always passes) →
   `"[install-whisper] Pre-fetching the Whisper 'small' model...", "prefetch ok"`.
   Re-fetched `small` correctly.
7. **Documented CLI path, no flags.** `node server/tts-sidecar/scripts/install-whisper.mjs`
   (no `--model`) → `"[install-whisper] Pre-fetching the Whisper 'base' model..."`.
   Confirms the script has no access to the live config override and
   correctly falls back to its own `'base'` default, exactly as the row
   (and PR #2008's own usage-comment fix) describes — **not** a defect.

**Caveat, stated plainly:** step 3's `ASR_MODEL=small` was set by hand on
the standalone sidecar's launch env, not produced by driving the Node
supervisor's real restart-sidecar env-injection loop end to end — the
single-instance-port-9000 constraint (see Environment note) made it unsafe
to exercise that exact mechanism against a live, possibly-shared supervisor
in this run. The registry wiring itself was confirmed by reading
`server/src/config/registry.ts`'s `qa.asr.model` entry
(`env: 'ASR_MODEL', apply: 'restart-sidecar'`) and
`spawn-sidecar.ts`'s injection loop (`buildSidecarEnv`, "Registry override
loop — any restart-sidecar knob whose effective value is not the registry
default"), but not executed live end-to-end through the supervisor. Every
downstream reader this row is actually about — the resolver, Model Manager,
Remove, both installer paths — WAS exercised for real and behaved correctly,
which is the load-bearing half of the row's own title ("reaches the sidecar
AND every server-side reader"). Restored the real HF cache back to its
pre-run state (deleted the downloaded `small` snapshot) at teardown; the
resolver's in-memory override lived only in this run's throwaway
`USER_SETTINGS_FILE` and never touched `~/.castwright/user-settings.json`.

## Live-safety verification (both rows)

Checked at the very start and again at the very end of this step:

- `server/tts-sidecar/.venv` in the **main checkout**
  (`C:\Claude\Projects\Audiobook-Generator`) — `kokoro_onnx/__init__.py`'s
  tail is the original `get_voices` method, no injected `raise`.
  `kokoro_onnx` and `qwen_tts` packages both present, dist-info sets
  unchanged.
- The box's live sidecar on `:9000` — `/health` queried read-only twice
  (once by accident at the start, caught before anything else happened;
  once deliberately at the end) — both times returned
  `kokoro_import_ok: null, qwen_import_ok: null`, i.e. untouched, never
  restarted or reconfigured by this run.
- `~/.cache/huggingface/hub` — the shared, real cache — gained nothing
  permanent: the `small` Whisper snapshot downloaded for A29 was deleted at
  teardown; only the pre-existing `...-base` remains.
- `~/.castwright/user-settings.json` — the shared, real settings file —
  never opened for writing; both rows used a throwaway
  `USER_SETTINGS_FILE` override instead.
- This worktree's own checkout: `git status --short` is clean. Two
  temporary NTFS junctions (`server/tts-sidecar/.venv` → a throwaway venv
  copy, later → the live venv read-only for the installer-script run) and
  one read-only copy of Kokoro's weight files were created for testing and
  removed before this file was written.

## Disposition

| Row | Verdict | Notes |
|---|---|---|
| A27 | DISCHARGED (core) | Null baseline, both broken-import states, both missing states, Qwen's over-claim case, Admin console copy, Setup-checker `packageFault` classification all confirmed for real. Mixed-fault precedence and Coqui-absent checks not run — STILL OWED, low risk. |
| A29 | DISCHARGED | All seven acceptance bullets run with real command output: config-reach, resolver, Model Manager (pre- and post-download), Remove, both installer paths (in-app `--model` and bare CLI default). |

Per the issue: this step does not edit `onbox-acceptance-register.md`, its
live-view HTML, or the staleness audit — step 9 of the wave-3 chain is the
single writer for those.

## Defect to route — Model Manager's `/api/models/inventory` endpoint cannot itself distinguish "broken" from "missing"

**Mechanism:** `buildModelInventory` (`server/src/routes/models-inventory.ts`)
derives each engine's `installState` via `deriveEngineHealth` off a single
`packageInstalled` boolean, computed as `pkgUsable = importOk ?? pkgInstalled(...)`.
Once a real load attempt has run and `importOk` is a real `false` (not
`null`), the `??` operator does **not** fall through — `false ?? X` is
`false` — so `packageInstalled` reads `false` regardless of whether the
package is genuinely absent from disk or merely present-but-unimportable.
Both states collapse to the same `installState: 'package-missing'` value at
this endpoint.

**Why this isn't user-facing today:** confirmed by reading
`src/views/model-manager.tsx` and `src/components/kokoro-install.tsx` that
the actual Repair-vs-Install button reads a **different** endpoint
(`GET /api/setup/models-status`, whose `packageFault` field genuinely does
distinguish `'broken'` from `'missing'` via `classifyPackageFault`) — so the
row's own acceptance criteria, tested against the right endpoint above, all
pass. `/api/models/inventory`'s `installState` is used elsewhere (the Remove
flow's `evaluateRemoval` guard, size/path display) where the broken-vs-missing
distinction doesn't matter.

**Worth a decision, not fixing here** (out of scope per the issue — "simple
bugs are routed to a fix... do not widen your own diff to fix it"): whether
`/api/models/inventory`'s `installState` enum should grow a fifth state
(e.g. `'package-broken'`) to match `models-status.ts`'s finer distinction, so
a future consumer of the inventory endpoint doesn't inherit this blind spot
the way the Repair/Install button already avoids it by reading the other
endpoint. Two defensible outcomes: (a) add the state, (b) leave
`/api/models/inventory` coarse by design and document that any
broken-vs-missing decision must read `models-status.ts` instead. Not
choosing this myself — it's a design call about whether a second endpoint's
scope should widen.
