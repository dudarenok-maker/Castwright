# Wave 5 step 1 — A27: `qa.asr.model` reaches the sidecar AND every server-side reader

Issue: Castwright#2615 (wave 5 of the on-box register campaign, #2435; step 1 of #2606). Track: sidecar venv only, no GPU needed.

Worktree: `wt-2606-onbox-wave5` @ branch `docs/docs-2606-onbox-wave5`.

## Why this run is not a repeat of wave-3/wave-4

Wave-3 (`onbox-wave3-results/step-3-sidecar-install-config-reach.md`) discharged every downstream reader (resolver, Model Manager, Remove, both installer paths) against a **standalone sidecar started by hand**, not the real Node supervisor — because the box's shared `:9000` sidecar was up and healthy at the time, so any worktree's own server would **adopt** it, never spawn its own child. Wave-4 (`onbox-wave4-results/step-4-b2-step8-and-a29-blocker.md`, Part 2) re-derived that same blocker live: `spawnSidecar`'s fitness probe found the shared sidecar "fit to adopt" and confirmed, live, that the registry env-injection loop (`buildSidecarEnv`, reached only on an owned **spawn**) was structurally unreachable without either disturbing the shared sidecar (forbidden) or waiting for it to go down (not arrangeable). Both waves left this row **STILL OWED** on exactly that one point.

**This run found the box's shared `:9000` sidecar not running** (`Get-NetTCPConnection -LocalPort 9000` returned nothing at the start of this pass). That flips the fitness-probe outcome: with nothing to adopt, this worktree's own server **spawns** its own owned sidecar child — which is exactly the code path `buildSidecarEnv`'s registry override loop needs. This is the first pass able to drive the real restart-sidecar env-injection loop end to end, not read it from source or fake it on a standalone process.

## Box-safety setup — throwaway venv copy, never the live one

Per the brief, worked on a copy of the live sidecar venv, never the live one directly:

**Before, baseline (PowerShell, recursive file count + total size + two file hashes):**
```
COUNT=56542 SIZE=6483355726
PYVENV_CFG_HASH=B956F1946831CAEA6ACD2A8EA484379B2709E33C59B2F82EDCA1331AF326C6C7
FASTER_WHISPER_INIT_HASH=5396C3A025A7B0CF81246FCD680C0BB7E384E2E587CC2E18F9518CEF4C26D56C
```

Copied `C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv` to a scratch path (`robocopy /E`, exit code 1 = files copied, no errors — robocopy's own success convention). Pointed the sidecar spawn at the copy via `SIDECAR_VENV_DIR` (an existing override point read at `spawn-sidecar.ts:578-579`, `process.env.SIDECAR_VENV_DIR ?? join(repoRoot, 'server', 'tts-sidecar', '.venv')`) — this worktree has no `.venv` of its own, so this env var was the only way to spawn without touching the primary checkout's venv.

`install-whisper.mjs` (the documented bare-CLI installer, tested separately below) does **not** honour `SIDECAR_VENV_DIR` — it resolves `.venv` relative to its own script location unconditionally (`install-whisper.mjs:100`, `join(SIDECAR_DIR, '.venv')`). To exercise both the in-app installer and the bare-CLI installer against the same throwaway copy without ever touching the live venv, created a Windows directory **junction** at `server/tts-sidecar/.venv` (in the worktree, which had no such path before) pointing at the scratch copy — a junction is a filesystem pointer, not a copy, so it added no risk beyond the copy already made. Deleted the junction (`(Get-Item $link).Delete()`, which removes only the reparse point, not the target) before deleting the scratch copy.

**After, cleanup verification (identical method):**
```
COUNT=56542 SIZE=6483355726
PYVENV_CFG_HASH=B956F1946831CAEA6ACD2A8EA484379B2709E33C59B2F82EDCA1331AF326C6C7
FASTER_WHISPER_INIT_HASH=5396C3A025A7B0CF81246FCD680C0BB7E384E2E587CC2E18F9518CEF4C26D56C
```
Identical to baseline — the live venv was never touched.

## Method — driving the real supervisor spawn

Confirmed `server/.env` in this worktree has no `ASR_MODEL` set (so the knob is not env-locked). Started this worktree's own server (`tsx watch --include=.env src/index.ts`, `PORT=8200` from `.env`) detached, polled its log file to completion rather than blocking in the foreground.

```
2026-08-23 09:01:01.618 [server] listening on http://localhost:8200
2026-08-23 09:01:01.720 [sidecar] spawned pid=32760 (PRELOAD_COQUI=0, PRELOAD_QWEN=sidecar-default, PRELOAD_KOKORO=sidecar-default, modelKey=qwen3-tts-1.7b)
```

`spawned`, not `adopted` — confirmed live from the server's own log line, not inferred. `curl http://localhost:9000/health` returned a healthy payload from the newly spawned child.

## Step 1 — config reach: `PUT /api/config` sets the override

```
$ curl http://localhost:8200/api/config   (before)
"qa.asr.model":{"key":"qa.asr.model","effective":"base","source":"default","locked":false,"overridden":false}

$ curl -X PUT http://localhost:8200/api/config -d '{"qa.asr.model":"small"}'
"qa.asr.model":{"key":"qa.asr.model","effective":"small","source":"override","locked":false,"overridden":true}
```

## Step 2 — the real restart-sidecar env-injection loop, driven end to end

```
$ curl -X POST http://localhost:8200/api/sidecar/restart
{"ok":true}
```
Server log: `supervisor: child exited (code=1 signal=null); respawning...` then `spawned pid=38600` — a fresh **owned** child, not an adoption.

Triggered a real ASR load by POSTing 1s of silent PCM to `POST /transcribe` (`X-Sample-Rate: 16000`) directly against the spawned sidecar (`:9000`). Sidecar log (`logs/tts.err.log`):

```
2026-08-23 09:05:53.614 [sidecar] Loading Whisper ASR model=small device=cpu compute=int8 revision=(unpinned) ...
Xet Storage is enabled for this repo, but the 'hf_xet' package is not installed. Falling back to regular HTTP download.
2026-08-23 09:06:13.075 [sidecar] Whisper ASR loaded (model=small device=cpu).
```

**This is the piece wave-3 and wave-4 could not reach**: `ASR_MODEL=small` genuinely crossed from the UI override, through `PUT /api/config`, through `POST /api/sidecar/restart`, through the Node supervisor's real owned spawn, into the Python child's `os.environ.get("ASR_MODEL", "base")` (`main.py:7150`) — confirmed by the sidecar's own log naming `small`, not `base`, and by a genuine Hugging Face HTTP download (the `hf_xet` fallback line only fires on a real network fetch, not a cache hit).

**Verdict on the config-reach half: DISCHARGED — live, via the real supervisor, not a standalone process or a source read.**

## Step 3 — Model Manager reflects `small`

```
$ curl http://localhost:8200/api/models/inventory
"id":"whisper", "present":true, "sizeBytes":486212412,
"diskPath":"C:\\Users\\dudar\\.cache\\huggingface\\hub\\models--Systran--faster-whisper-small",
"loaded":true, "installState":"loaded"
```

Reports `small`'s real on-disk size and path, `loaded:true` — not `base`. **DISCHARGED**, driven through the real running server, same session as the spawn above (not a fresh standalone read).

## Step 4 — Remove deletes `small`, leaves `base` untouched

`base` was already present in the shared Hugging Face cache (`C:\Users\dudar\.cache\huggingface\hub\models--Systran--faster-whisper-base`) alongside the newly-fetched `small`. Whisper had to be unloaded first (sidecar restart — the model-loaded guard returned 409 `model-loaded` on the first attempt, exactly as `evaluateRemoval` documents):

```
$ curl -X POST http://localhost:8200/api/models/whisper/remove   (while loaded)
{"code":"model-loaded","error":"Whisper ASR (faster-whisper) is currently loaded in GPU memory.","remediation":"Unload it first, then remove."}

$ curl -X POST http://localhost:8200/api/sidecar/restart   (unloads everything)
{"ok":true}
$ curl http://localhost:8200/api/models/inventory   → whisper.loaded:false

$ curl -X POST http://localhost:8200/api/models/whisper/remove
{"id":"whisper","removed":true,"freedBytes":486212412}

$ ls ~/.cache/huggingface/hub | grep whisper
models--Systran--faster-whisper-base
```

`small`'s snapshot directory is gone; `base`'s is untouched — the inverse of the pre-fix defect (which deleted `base` and left the model actually in use on disk). **DISCHARGED — live.**

## Step 5 — in-app installer fetches `small`, with an explicit `--model` flag

`qa.asr.model` was still overridden to `small` at this point. First attempt failed for an environment reason unrelated to the row (`install-whisper.mjs` resolves `.venv` relative to its own script path, not `SIDECAR_VENV_DIR`, and this worktree has no `.venv` of its own) — worked around with the junction described above, not by touching the live venv.

```
$ curl -X POST http://localhost:8200/api/whisper/install
{"id":"2","status":"detecting",...}
$ curl http://localhost:8200/api/whisper/install/2   (poll)
{"id":"2","status":"installing","step":"Pre-fetching the Whisper 'small' model into the default Hugging Face cache...",...}
{"id":"2","status":"installed","step":"Done. Whisper ASR installed.",...}

$ ls ~/.cache/huggingface/hub | grep whisper
models--Systran--faster-whisper-base
models--Systran--faster-whisper-small
```

The install card's own step copy names `small`, not a hard-coded `base` (the m1 fix) — confirmed from the route's own polled status text, not the source. **DISCHARGED — live.**

## Step 6 — documented bare-CLI path (no flags) still fetches `base`, as designed

```
$ node C:\Claude\Projects\wt-2606-onbox-wave5\server\tts-sidecar\scripts\install-whisper.mjs
[install-whisper] Using venv python: ...\.venv\Scripts\python.exe
[install-whisper] Pre-fetching the Whisper 'base' model into the default Hugging Face cache...
[install-whisper] prefetch ok
[install-whisper] Done. Whisper ASR installed.
[install-whisper]   - The 'base' model is in the default Hugging Face cache.
```

Confirmed: with the UI override still set to `small`, the documented bare-CLI path (no access to `user-settings.json`) still names and fetches `base`. **This is expected, not a defect** — pinned live, matching the row's own note.

## Cleanup / box-safety verification

- Server + spawned sidecar (and all descendant python/uvicorn processes) killed via `taskkill /T /F` on the whole process tree; confirmed `:8200` and `:9000` both freed via `Get-NetTCPConnection` immediately after (both queries returned no listener).
- `.venv` junction at `server/tts-sidecar/.venv` (this worktree) deleted; scratch venv copy deleted afterward.
- Live venv (`C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv`) byte-verified unchanged: file count (56542), total size (6483355726 bytes), and two file hashes (`pyvenv.cfg`, `faster_whisper/__init__.py`) all identical before and after — pasted above in both places.
- No other register row touched. No source file edited (`registry.ts`, `spawn-sidecar.ts`, `install-whisper.mjs`, `models-inventory.ts` all read-only). `server/.env` in this worktree untouched (no `ASR_MODEL` line added — the override lived only in `user-settings.json` for the duration of the run, via the API).
- No book/workspace data touched — this worktree's `castwright-workspace` was not used for anything beyond the server boot log.
- `git status` on the worktree is clean except this new evidence file.

## Verdict

**A27: DISCHARGED.** Every criterion in the row is now confirmed live, including the one piece wave-3 and wave-4 could only reach by standalone process or source read: the registry's `apply: 'restart-sidecar'` env-injection loop genuinely carries a UI-set `qa.asr.model` override through the real Node supervisor's owned spawn into the Python sidecar's `ASR_MODEL` environment variable, and every server-side reader (resolver/config API, Model Manager, Remove, the in-app installer) agrees with that value — while the one reader that is documented to disagree (the bare-CLI installer) does so exactly as designed. This supersedes wave-3's and wave-4's STILL OWED disposition, which was correct for what those passes could reach (the box's shared sidecar was up both times) but is no longer the live state of this row.
