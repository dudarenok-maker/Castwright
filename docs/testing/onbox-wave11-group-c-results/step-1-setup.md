# Group C step 1 — setup and detached launch

Ref: [Castwright#2896](https://github.com/dudarenok-maker/Castwright/issues/2896), parent
[#2616](https://github.com/dudarenok-maker/Castwright/issues/2616), campaign
[#2435](https://github.com/dudarenok-maker/Castwright/issues/2435).

## Re-verify unblocked

Both blockers re-confirmed CLOSED via `gh api` immediately before starting (not trusted from
the issue body alone):

- [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) — `state: closed`,
  `closed_at: 2026-08-26T22:54:16Z`
- [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279) — `state: closed`,
  `closed_at: 2026-08-14T00:25:18Z`

## §1 Pre-flight

**§1.1 eGPU hard gate — PASS.**

```
index, name, memory.total [MiB], memory.free [MiB]
0, NVIDIA GeForce RTX 4070 Laptop GPU, 8188 MiB, 7948 MiB
1, NVIDIA GeForce RTX 5070 Ti, 16303 MiB, 15799 MiB
```

Both cards enumerate with real free memory (not merely `Get-PnpDevice`-listed). No recovery
needed.

**§1.2 box-quiet hard gate — PASS (idle, not contending).** The `vitest|verify-cache|playwright`
process filter matched 9 processes (two `verify-cache.mjs`, two sibling-worktree vitest
workers, plus idle Playwright MCP stdio servers), matching the run sheet's documented
false-positive pattern. CPU time was sampled twice 5 s apart rather than judged by presence
alone: the two vitest workers moved 0.00 s and 0.03 s of CPU time in that window (≈0.6% of one
core) — indistinguishable from idle. Judged quiet by the run sheet's own corrected criterion
("Judge by CPU, not by name match").

**§1.3 the rest:**

- Ollama model: run sheet's `qwen36-cw-iq4-32k` is **not present** on this box (confirmed via
  `ollama list`). Per the issue's own instruction, this is not re-litigated — the operator's
  named replacement `qwen38-cw-iq3-80k:latest` (11 GB) is used, and is already the active
  `analyzer.ollama.model` override in the operator's global `~/.castwright/user-settings.json`.
  Worth a one-line bug filing per CLAUDE.md's incidental-findings rule for the stale run-sheet
  citation — not filed in this step (out of scope: this step touches no `server/**` code and
  files no register edits), left for whoever runs step 4.
- Source EPUB confirmed present: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night
  Watch Tetralogy\Ночной дозор\manuscript.epub` (416,002 bytes).

## GPU pin — a separate pinned Ollama instance, not a restart of the shared daemon

The issue asks to pin *the process serving this model* to GPU index 1
(`CUDA_VISIBLE_DEVICES=1`). The box's existing Ollama daemon (PID 34332, port 11434) is a
single shared instance with no model currently loaded (`ollama ps` empty at the time), but it
is shared infrastructure this chain's own standing rule forbids stopping or restarting
("Never stop or kill another agent's process or model"). Restarting it to inject an env var
would have required killing it.

Instead: launched a **second, independent** `ollama serve` process, `OLLAMA_HOST=127.0.0.1:11435`,
`CUDA_VISIBLE_DEVICES=1`, detached via `Start-Process -WindowStyle Hidden`. It shares the same
on-disk model store (no `OLLAMA_MODELS` override), so `ollama list` against port 11435
immediately showed the full existing model library including `qwen38-cw-iq3-80k:latest` — no
re-pull needed. The main daemon on 11434 was never touched and stayed listed separately
throughout (`ollama ps` against 11434 empty before and after).

Verified from the pinned instance's own boot log
(`%OE_RUN_SCRATCH%\ollama-pinned.log`): `CUDA_VISIBLE_DEVICES=1` restricted CUDA enumeration to
exactly one device — `CUDA0`, `pci_id=0000:05:00.0`, `description="NVIDIA GeForce RTX 5070 Ti"`
— with the 4070 Laptop GPU visible only via the (unused) Vulkan fallback backend, not CUDA.

- Pinned instance: PID **48020**, listening on `127.0.0.1:11435`.
- Log: `%OE_RUN_SCRATCH%\ollama-pinned.log` (`%OE_RUN_SCRATCH%` =
  `C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\claude-2896-20260904-231323`).
- Launch script: `%OE_RUN_SCRATCH%\ollama-pinned-launch.ps1`.

**Confirmed empirically, not just from the launch command** (per the issue's own instruction):
once the analysis job loaded the phase-0 model, `nvidia-smi` read:

```
index, name, memory.used [MiB], memory.total [MiB], utilization.gpu [%]
0, NVIDIA GeForce RTX 4070 Laptop GPU, 0 MiB, 8188 MiB, 0 %
1, NVIDIA GeForce RTX 5070 Ti, 4537 MiB, 16303 MiB, 73 %
```

GPU 0 idle at 0 MiB / 0%; GPU 1 (the pin target) carrying 100% of the load. `ollama ps` against
the pinned instance separately confirmed `qwen3.5:4b … 100% GPU`.

## §2.1 Import the throwaway

Imported via the raw API (`POST /api/import` then `POST /api/books`) rather than the UI —
functionally identical (the UI is a thin client over the same two routes) and scriptable for a
detached/headless run. One operational note: Git Bash's `curl -F file=@<path>` failed
(`curl: (26) Failed to open/read local data`) against the Cyrillic manuscript path; copying the
EPUB byte-for-byte to an ASCII scratch path first (`Get-FileHash` not compared here since the
import response's own `byteSize: 416002` round-trips the source file's size) resolved it. Not a
server-side issue — a Git-Bash/curl argument-parsing quirk with non-ASCII paths, worth knowing
for step 2/4 if they also shell out to curl against this book.

- Title: `Ночной дозор (Group C throwaway)`
- Series: `The Night Watch Tetralogy (Group C throwaway)` — a **distinct series slug**, not just
  a distinct title, so the throwaway's book directory, cache, cast and edits are fully isolated
  from both the library book and the historical `(C2 throwaway)` / `(C1 throwaway)` imports the
  old run sheet used.
- Author: `Сергей Лукьяненко` (as detected from the EPUB).
- Language: as auto-detected by `/api/import` (Russian; not overridden).
- **`manuscriptId`: `mns_a_x7EBUule`**
- `bookId`/`paths`: written under this worktree's own workspace,
  `C:\Claude\Projects\wt-2616-onbox-group-c\castwright-workspace\` (per `server/.env`'s
  `WORKSPACE_DIR=../castwright-workspace`) — never the primary checkout's.

## §2.2 Settings — worktree-local copy, not the shared global file

The issue's own "Not in scope" list forbids editing `~/.castwright/user-settings.json`
"outside this worktree's own copy." The settings file's own resolution code
(`user-settings-path.ts`) supports exactly this via a `USER_SETTINGS_FILE` env var override,
with `server/user-settings.json` (gitignored, line 122) as the documented legacy per-checkout
location. Used that path instead of touching the operator's shared global file at all:

1. Seeded `C:\Claude\Projects\wt-2616-onbox-group-c\server\user-settings.json` from the global
   file (byte-for-byte copy, confirmed via `sha256sum` before editing).
2. Changed exactly two fields in the worktree-local copy:
   - `"allowCloudFallback": false` (was `true`)
   - `"ollamaUrl": "http://127.0.0.1:11435"` (was `http://localhost:11434`) — points at the
     GPU-pinned instance above, not the shared daemon.
3. Left `analyzer.ollama.model` override (`qwen38-cw-iq3-80k:latest`), `analysisEngine: "local"`,
   and `dualModelEnabled: true` exactly as the operator's global file already had them —
   nothing else needed changing.
4. Launched this worktree's server with `USER_SETTINGS_FILE` pointed at that copy and
   `DISABLE_AUTOSTART_SIDECAR=1`, so neither setting change nor the sidecar-off requirement
   touches any other worktree or the primary checkout. The operator's global
   `~/.castwright/user-settings.json` was read once (to seed the copy) and never written.

`analyzer.structure.enabled` (default `true`) and `analyzer.structure.escalation` (default
`'local'`) already match what the run sheet asks for at the shipped default — no override
needed for either.

Server: launched via `npx tsx src/index.ts` (no `--watch`, deliberately, per the run sheet's own
2026-08-12/13 finding that `tsx watch` restarts under a concurrent `main` merge and killed
attempt 1 of that run).

- Server: PID **50624** (via the `node` child under `tsx`'s launcher PID 21332), listening on
  `http://localhost:8130`.
- Log: `%OE_RUN_SCRATCH%\server.log`.
- Launch script: `%OE_RUN_SCRATCH%\server-launch.ps1`.
- Confirmed `[sidecar] auto-start disabled (user pref or DISABLE_AUTOSTART_SIDECAR=1)` in the
  boot log.

## §2.3 Run

`POST /api/manuscripts/mns_a_x7EBUule/analysis` with `{"fresh": true}`, model left unspecified
(resolves from the worktree-local settings above). Opened the SSE stream just long enough to
observe the job start, then let the client disconnect (`curl --max-time 25`) — the route's own
"sticky semantics" comment (`analysis.ts` around the subscribe/start dispatch) states the
analyzer does **not** abort on subscriber disconnect, only on `/pause` or an explicit
`fresh: true` displacement. Verified empirically, not just trusted from the code comment: a
second `POST` with `{}` (no `fresh`) 90+ seconds later rejoined the **same** in-flight job — its
`elapsedMs` had kept climbing past the first client's disconnect — and `nvidia-smi` showed load
on GPU 1 throughout, confirming the job survived unattended.

Log line at start: `"Estimated total time: ~65m 6s (refined after stage 1)"` — this is phase-0
(cast detection, `qwen3.5:4b`, the operator's global `defaultAnalysisModel` — a lighter model
than the structure-analysis one by the box's existing `dualModelEnabled: true` design, not a
misconfiguration introduced by this step); phase-1 structure/attribution on
`qwen38-cw-iq3-80k` follows and is the part §2.4/§2.5's per-chapter figures in the run sheet
are about. Step 2 should watch the log for phase-1's own model line and its own ETA once
phase-0 clears.

- **Launching command:** `POST http://localhost:8130/api/manuscripts/mns_a_x7EBUule/analysis`,
  JSON body `{"fresh": true}`.
- **Process:** the worktree server, PID 50624 (above) — the analysis runs in-process, not as a
  separate child.
- **Log for step 2 to poll:** `%OE_RUN_SCRATCH%\server.log` (structured `[analysis] mns=... ` /
  `[analysis:structure] ch=...` lines land here as the job progresses). Re-subscribe with
  `POST` (no `fresh`) to the same URL for a live SSE view instead of tailing the file, if
  preferred — confirmed above to rejoin cleanly.

## Not done in this step (by design — step 2's job)

- Did not wait for completion or for chapter 1's alignment positive control (§2.4) — that is
  step 2's polling job, "possibly over many hours."
- Did not touch C1 (Session B, cloud pass) — separate, per the issue.
- Did not edit the register or close #2187.

## Rollback owed later (not this step, flagging for whoever runs §4/§5)

- Worktree-local `server/user-settings.json` (`allowCloudFallback: false`,
  `ollamaUrl: 127.0.0.1:11435`) stays as long as this worktree's server needs it for this run;
  it never touched the shared global file, so no revert is owed there.
- The pinned Ollama instance on 11435 (PID 48020) should be left running until step 2's run
  completes — it is what's serving the model. Nothing to revert on the shared daemon (11434),
  since it was never stopped or reconfigured.
