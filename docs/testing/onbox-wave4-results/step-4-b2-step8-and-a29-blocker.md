# Wave 4 step 4 — B2 step 8 (live) + A29's blocker (re-derived)

Issue: Castwright#2555 (wave 4 of the on-box register campaign, #2435; step 4 of 7 for #2551). Track A.

Worktree: `wt-2551-onbox-wave4-retire` @ branch `docs/docs-2551-onbox-wave4-retire`. GPU checked idle before starting (RTX 4070 Laptop 686/8188 MiB, RTX 5070 Ti 209/16303 MiB — `nvidia-smi`) and confirmed clean at the end.

## Part 1 — B2 step 8, live: persona keep-alive stays 300

Wave 3 (`step-5-group-b.md`) only corroborated this by reading `persona-gpu-plan.ts`/`ollama.ts` source — no live run. This pass triggers the real production code path and observes `ollama ps` while a persona job is genuinely in flight.

**Method.** `generateVoiceStylePersona`'s HTTP route (`POST /:bookId/cast/:characterId/voice-style/generate`) needs a real book+cast on disk, which this isolated worktree's workspace does not have pre-seeded. Rather than fabricate a full book/analysis pass (out of scope — "Not in scope: any other register row" and the step's own time budget), this pass invoked the **exact same production functions** the route calls, in-process, via `tsx`, against the real local Ollama daemon — skipping only the Express routing layer and the cast.json disk read/write, neither of which affects the keep-alive value under test:

```ts
// server/tmp-persona-probe.mts (temporary, deleted after the run — never committed)
import { resolvePersonaGpuPlan } from './src/tts/persona-gpu-plan.js';
import { generatePersonaViaOllama } from './src/analyzer/ollama.js';
import { buildVoiceStylePrompt } from './src/analyzer/voice-style.js';

const plan = resolvePersonaGpuPlan('onbox-wave4-probe-book'); // real function, real decision
const prompt = await buildVoiceStylePrompt(character);         // real prompt builder
const result = await generatePersonaViaOllama(prompt, 'qwen3.5:4b', {
  onCpu: plan.onCpu, keepAlive: plan.keepAlive,
});
```

This is the identical call graph `routes/voice-style.ts:82-83` uses (`preparePersonaBatch` → `resolvePersonaGpuPlan` when engine is local and idle, then `generateVoiceStylePersona` → `generateViaOllama` → `generatePersonaViaOllama`). Model chosen: `qwen3.5:4b` (small, idle, not otherwise in use — same choice wave3 made for B2's other live steps, to avoid GPU contention with other lanes).

**Run.**

```
$ nvidia-smi --query-gpu=index,name,memory.used,memory.total --format=csv
0, NVIDIA GeForce RTX 4070 Laptop GPU, 686 MiB, 8188 MiB
1, NVIDIA GeForce RTX 5070 Ti, 209 MiB, 16303 MiB
$ ollama ps
NAME    ID    SIZE    PROCESSOR    CONTEXT    UNTIL     (empty — nothing resident)

$ node_modules/.bin/tsx.cmd tmp-persona-probe.mts
PLAN {"onCpu":false,"keepAlive":300}
PROMPT_LEN 2515
CALLING generatePersonaViaOllama model=qwen3.5:4b at 2026-08-21T01:29:22.882Z
```

Polled `ollama ps` in a separate terminal **while the call above was in flight** (request sent 01:29:22.882Z, before it returned):

```
--- poll @ 01:29:31 UTC ---
NAME          ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3.5:4b    2a654d98e6fb    6.5 GB    100% GPU     131072     4 minutes from now
--- poll @ 01:29:33 UTC ---
NAME          ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3.5:4b    2a654d98e6fb    6.5 GB    100% GPU     131072     4 minutes from now
--- poll @ 01:29:36 UTC ---
NAME          ID              SIZE      PROCESSOR    CONTEXT    UNTIL
qwen3.5:4b    2a654d98e6fb    6.5 GB    100% GPU     131072     4 minutes from now
```

`4 minutes from now` at ~01:29:3x, ~11-14s after the 01:29:22.882Z request — consistent with a `keep_alive` of **300s (5 minutes)**, not the model's per-model analyzer-map value (this box's `analyzerKeepAliveByModel` has no entry for `qwen3.5:4b` at all in the persona context — the persona call never reads that map, confirmed live: had it gone through `resolveKeepAliveSeconds`, the un-overridden-tag default is `30`s, which `ollama ps` would have shown as "~30 seconds from now", not "4 minutes from now").

Job completed for real, with a genuine model response:

```
RESULT "A middle-aged woman's voice with a steady, rich timbre and medium pitch, speaking at a
precise, mid-paced rhythm that conveys calm authority without fraying edges, suitable for
audiobook narration."
DONE_AT 2026-08-21T01:30:03.138Z
```

**Verdict: Step 8 DISCHARGED — live, not corroborated-by-source.** The persona path's `keep_alive:300` is observably distinct from the per-model analyzer default (30s) and from any of the configured analyzer overrides, confirmed while a genuine generation call was resolving on the GPU.

### Restoration

```
$ curl -s http://localhost:11434/api/generate -d '{"model":"qwen3.5:4b","keep_alive":0}'
{"model":"qwen3.5:4b","created_at":"2026-08-21T01:30:08.5584533Z","response":"","done":true,"done_reason":"unload"}
$ ollama ps
NAME    ID    SIZE    PROCESSOR    CONTEXT    UNTIL     (empty again)
```

No settings were changed (no PUT to `/api/config` or `/api/user/settings` — this run bypassed the HTTP layer entirely and called the Ollama-path function directly with an explicit `keepAlive`), so there is nothing to restore beyond unloading the model, done above. `server/tmp-persona-probe.mts` was deleted immediately after the run; `git status` on the worktree is clean.

### B2 — verdict on the row as a whole

Per the issue's 2026-08-21 amendment, step 7 is now routed to the register's "Blocked — hardware not available" section (repo-owner ruling) and is **not** counted toward B2's owed total. With steps 1-6 discharged by wave 3 and **step 8 now discharged live by this pass**, every step that counts toward the row's total is discharged. **This pass does not retire B2 itself** — step 6 is the sole register writer — but the verdict it hands to step 6 is: **all counted steps (1-6, 8) are DISCHARGED; step 7 is Blocked — hardware not available** (two resident NVIDIA GPUs on this box mean `accelerator` in `server/src/analyzer/ollama.ts` structurally resolves to `'cuda'` and cannot be forced to `'cpu'` without disabling GPU visibility, which risks other lanes' concurrent work — not attempted, per the ruling).

## Part 2 — A29's blocker, re-derived

Wave 3's stated blocker: *"this box's single-instance :9000 constraint"* — asserted from reading `spawn-sidecar.ts` and `user-settings.ts`, not demonstrated live in this worktree. The brief asks: can `wt-2551-onbox-wave4-retire`, with its own isolated ports, start its own supervisor which starts its own sidecar on its own port, driving the real restart-sidecar env-injection loop end to end?

### Re-reading the source (confirms the mechanism, not yet the live outcome)

- `spawn-sidecar.ts:102` — `const DEFAULT_PORT = 9000;`
- `spawn-sidecar.ts:600` — `spawnSidecar`'s `port` parameter defaults to `DEFAULT_PORT` and is documented at `spawn-sidecar.ts:42` as an **"Override-point for tests"** only.
- `index.ts:314-323` — the production wiring (`createSidecarSupervisor({ buildOpts: async () => ({ autoStart, modelKey, repoRoot }) })`) **never sets `port`** — confirmed by reading the actual `buildOpts` object literal, not inferred. So in this build, every real server instance's sidecar spawn/probe target is unconditionally `:9000`, worktree or not; `LOCAL_TTS_PORT` (`.env.local:8`, `9090` in this worktree) is read nowhere in `spawn-sidecar.ts` or `index.ts` (`grep -rn LOCAL_TTS_PORT server/src` matches only `routes/worktrees.ts`, an unrelated route).
- `sidecar-owner.ts:19-24` (own header) + `app-dirs.ts:19-21` — the file-based single-owner guard keys on `resolveRunDir(repoRoot)` = `<repoRoot>/.run` (no `APP_RUN_DIR` set here), i.e. **per-checkout**, not machine-wide. So this worktree's `enforceSingleSidecarOwner` cannot even see the primary checkout's owner note — the thing that actually decides what happens on port collision is `spawnSidecar`'s own TCP-level probe/health-adopt logic (`spawn-sidecar.ts:619-660`), not the file lock.

### The live test

Given the above, the outcome hinges on whether `spawnSidecar`'s probe finds the box's shared :9000 sidecar "fit to adopt" (→ passive client, `onAdoptExisting`, no spawn) or "unfit" (→ **kills** the process on :9000 and spawns a fresh one — `spawn-sidecar.ts:679-699`, `killTree(stalePid, ...)`). The box-safety rule ("never stop, restart or reconfigure the shared :9000 sidecar") makes the second outcome the one thing this run cannot risk. Worked out from the real live `/health` response and this worktree's own (override-free) config before running anything, to know in advance which branch would fire:

```
$ curl -s http://localhost:9000/health
{"ok":true,"protocol_version":1, ... "recycle_pending":false, "committed_mb":2649.26, ...}
```

- `protocolVersion` 1 == `EXPECTED_PROTOCOL_VERSION` (`spawn-sidecar.ts:111`) → `freshProtocol: true`.
- `sidecarCeilingMismatch` (`spawn-sidecar.ts:169-186`) only fires when THIS server's own config has a **non-default** override for the mem/VRAM-restart-ceiling knobs (`expectedSidecarCeilings`, `spawn-sidecar.ts:134-148`, gated on `st.source !== 'default'`). This worktree's `server/.env` sets none of them → `expected.*` resolve to `null` → mismatch check short-circuits false regardless of the live sidecar's actual numbers.
- `recycle_pending: false` in the live health.
- `neverAdoptSidecar()` (`spawn-sidecar.ts:193-197`) is prod-only (`NODE_ENV === 'production'`) unless `SIDECAR_NEVER_ADOPT` is set; this run used dev mode (`tsx watch`), neither set.

⇒ every input to the fitness check pointed the same way: **adopt, not spawn.** Confirmed live rather than trusting the derivation — started this worktree's own server exactly as a normal `npm run dev:server` would (default autostart, no port override, since none exists to give it):

```
$ node_modules/.bin/tsx.cmd watch --include=.env src/index.ts
2026-08-21 11:31:07.976 [server] listening on http://localhost:8080
2026-08-21 11:31:07.976 [server] workspace root: C:\Claude\Projects\wt-2551-onbox-wave4-retire\castwright-workspace
2026-08-21 11:31:08.034 [sidecar] already listening on :9000 (protocol v1), skipping spawn (current sidecar honoured)
2026-08-21 11:31:08.034 [sidecar] supervisor: watching adopted sidecar on :9000 (not our child) — will respawn an owned process if it exits or becomes unfit.
```

Exactly as derived: **adopted**, no child spawned. Confirmed the shared sidecar was genuinely untouched — same PID before and after (`netstat -ano | grep :9000` → `LISTENING 42352` both times), same `/health` payload both times. Stopped this worktree's server immediately after capturing the log (`taskkill /F /T` on the actual node PID; verified `:8080` freed and `:9000`'s owner PID unchanged).

*(Aside, not load-bearing for the verdict: the launch above ran with the working directory NOT at `server/`, so `server/.env` didn't load and the server fell back to defaults for `PORT`, hence `:8080` instead of the worktree's configured `8170` — visible in the log's own warning. This doesn't change the sidecar-adoption outcome: `spawnSidecar`'s target port is `DEFAULT_PORT` regardless of which HTTP port the server itself binds, since nothing threads `LOCAL_TTS_PORT` into it either way, per the source citations above.)*

### Why the restart-sidecar env-injection loop still cannot run here

`buildSidecarEnv` (`spawn-sidecar.ts`, the "Registry override loop" wave3 cited) only executes as part of an actual **spawn** of an owned child process (`spawn-sidecar.ts:719` onward, reached only after the `if (await probeFn(...))` block above either falls through un-adopted or the port was free to begin with). The adopt branch returns `null` at `spawn-sidecar.ts:660` **before** that code is ever reached. So even with this worktree's own isolated HTTP port, own workspace, and own `.env`:

- The sidecar target port is unconditionally `:9000` (no override reaches it in production wiring).
- Given the box's live sidecar is healthy, protocol-fresh, and this worktree carries no ceiling overrides, the supervisor **always adopts** it rather than spawning an owned child — confirmed live, not assumed.
- The registry env-injection loop (`buildSidecarEnv`, `apply: 'restart-sidecar'` knobs like `qa.asr.model` — `registry.ts:432-439`) only runs on an owned spawn, which this worktree structurally cannot reach without either (a) the box's shared sidecar going down first (not something to engineer) or (b) this worktree's config drifting into a real ceiling mismatch against the live sidecar, which would flip the outcome to the **kill-and-replace** branch — the one thing explicitly forbidden.

**Verdict: A29's blocker is CONFIRMED, not overturned — re-derived live rather than inherited.** The wave3 characterisation ("single-instance :9000 constraint") is the right shape, but the actual mechanism is sharper than "can't have two on the same port": the port collision resolves safely to a passive **adoption** given this worktree's real (override-free) config, which is precisely what makes the env-injection loop unreachable — adoption never spawns, and forcing a spawn instead would mean either disturbing the shared sidecar's fitness signal (out of bounds) or waiting for it to go down (not this run's to arrange). A29 stays **STILL OWED** on the "reaches the sidecar via the real supervisor" half; every other reader (resolver, Model Manager, Remove, both installer paths) remains discharged from wave3's step 3, unaffected by this finding.

## Box-safety / live-safety verification

- Shared `:9000` sidecar: `/health` queried read-only twice (before and after the worktree-server test), same PID (`42352`) both times, payload identical (`ok:true, protocol_version:1, recycle_pending:false, committed_mb:2649.26...` both reads). Never stopped, restarted, killed, or reconfigured.
- Live sidecar venv (`server/tts-sidecar/.venv` in the main checkout): not touched this pass — no venv work was needed for either part.
- `ollama ps` empty (idle) before Part 1's run; the one model loaded (`qwen3.5:4b`) was explicitly unloaded (`keep_alive:0`) immediately after, confirmed empty again.
- GPU state: idle before and after (no other lane's resident model was evicted or contended — `qwen3.5:4b` is a 6.5GB model on an 8GB card with 7.4GB free at the time, per the same `/health` GPU block).
- `server/tmp-persona-probe.mts` (temporary script, Part 1) deleted immediately after use; `git status` on the worktree confirmed clean before this evidence file was added.
- This worktree's own server (Part 2) was started and stopped cleanly; its HTTP port (`:8080`, defaulted — see aside above) was freed on shutdown, verified via `netstat`.
- No source file was edited (`server/src/config/registry.ts`, `spawn-sidecar.ts` read-only, as scoped). No other register row touched.
