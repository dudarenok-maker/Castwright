# Step 6 — E7: ORT marker, the Pinokio Update path (Castwright#2963)

Parent #2950, campaign #2435. Discharged register row **E7**
(`docs/testing/onbox-acceptance-register.md:4361-4399`, #2192, plan 282) —
`ensureOrtMarker`'s boot-time self-heal, and the underlying
`applyOrtMarkerWrite` swap, reached through the real Pinokio Update and
Install entry points.

## Operator-approved documented substitute (release gap)

The ORT marker fix (`ensureOrtMarker` self-heal, `bf3586da`; the swap fix,
PR #2237/`a6e8454e`) has never shipped in a **published** GitHub release —
`gh api repos/dudarenok-maker/Castwright/releases/latest` still returns
`v1.14.0` (2026-07-23), which predates it. `resolve-release.js`'s real
release-resolution step (`GET .../releases/latest`) can therefore never reach
the fix today, real or fallback (no local `vX.Y.Z` tag past v1.14.0 exists
either). Operator decision (2026-09-07, on issue #2963): **documented
substitute** — deliberately force the "API unreachable → highest local tag"
fallback branch, not a real release cut. Mechanism used: `LATEST_URL` in the
throwaway's own **local, uncommitted-to-any-branch, never-pushed** copy of
`pinokio-scripts/lib/resolve-release.js` was pointed at an unreachable host
(`https://127.0.0.1:1/...`), and a local-only git tag (`v1.15.0`) was created
pointing at the current `main` tip (which contains the fix), so the
**unmodified** fallback code picks it up exactly as it would a real release.
This is noted explicitly here per the operator's instruction so the row and
this evidence stay honest about what was actually exercised — the real
Update entry point mechanics (fetch → fallback → checkout → guard) are
exercised unmodified; only the release-resolution *input* is substituted.

## Existing-install caution superseded

An earlier attempt this chain found the box's only Pinokio-managed install
(`C:\pinokio\api\castwright` — starred, 62 UI launches) and stopped rather
than risk it (near-miss recorded on #2963, 2026-09-06). Operator confirmed
2026-09-08: that install was test data, fine to delete or reuse. This step
still used a **separate throwaway** (below) rather than touching it, since
building a fresh one was already in flight and the isolation costs nothing.

## Setup

- Throwaway app registered via `pterm download` at
  `C:\pinokio\api\castwright-e7-throwaway`, pinned to **v1.13.0**
  (2026-07-12) — confirmed pre-fix: `git merge-base --is-ancestor bf3586da
  v1.13.0` exits 1.
- Full baseline install built manually (conda env + `npm ci` ×2 + `npm run
  build` + `bootstrap-venv.mjs`) to avoid `install.js`'s own
  `resolve-release.js` step overriding the v1.13.0 pin before the baseline
  was established.
- **Baseline `pip check` reproduced the row's own pre-fix symptom exactly**:
  `faster-whisper`, `kokoro-onnx`, `qwen-tts` all report `requires
  onnxruntime, which is not installed` — only `onnxruntime-gpu` present, no
  `castwright-ort-marker` dist-info.

## Update path

1. `pterm start pinokio-scripts/update.js --ref
   pinokio://.../castwright-e7-throwaway` — the **real** Pinokio Update
   entry point.
   - **Pinokio's own orchestrator repeatedly stalled mid-run** (traced via
     `Win32_Process`: the `cmd.exe` child it spawns goes fully idle — near-
     zero CPU, no children — while `pterm status`/`pterm logs` keep
     reporting `"running": true` indefinitely; also saw the whole Pinokio
     control plane drop and restart once, `ECONNREFUSED` on its own port,
     unrelated to anything this chain did). This is a Pinokio orchestrator
     defect, not a defect in the code under test — confirmed by re-running
     the exact same commands directly (bypassing only Pinokio's step-
     sequencer), which completed cleanly every time. Worth a follow-up
     report against Pinokio itself; out of scope for this row.
   - `[resolve-release] API unreachable; falling back to local tag v1.15.0` →
     `git checkout v1.15.0` → HEAD lands on the fix-containing commit.
2. `npm ci` ×2, `npm run build`, `bootstrap-venv.mjs` all completed cleanly.
3. **`pip check` after Update: `No broken requirements found.`** — the
   `onnxruntime` / `onnxruntime-gpu` conflict from the pre-fix baseline is
   gone.

## Server-boot self-heal (criterion 3)

Server started directly (`node server/dist/index.js`, isolated
`WORKSPACE_DIR`/ports, no other lane touched) against the throwaway's own
rebuilt venv:

- Boot completed cleanly (`listening on http://localhost:8271`, sidecar
  spawned).
- `ensureOrtMarker` ran (server/src/index.ts:130, unconditional on every
  boot) and reported **`noop`** — `pip list` showed `onnxruntime` and
  `onnxruntime-gpu` coexisting as two separate, mutually-consistent
  dist-infos (not the `owner==='swap'`-with-a-stray-plain-dist-info
  "clobbered" state the marker exists to catch), so there was nothing to
  heal. `pip check` stayed clean before and after boot. This is a
  legitimate, honest outcome — the self-heal code path executed without
  error on every boot; this run's particular install state didn't happen to
  need it. It does **not** substitute for criterion 3's own dedicated
  unit/acceptance test coverage of the healing branches themselves
  (`server/src/tts/ort-ensure-marker.test.ts`), which is unaffected by this
  finding.

## Qwen3 install, no `WinError5` (criterion 4)

`POST /api/sidecar/load {"engine":"qwen"}` → `{"status":"ready"}`. Sidecar
log (`logs/tts.err.log`) shows a clean load: model fetch, talker/encoder/
decoder init, `Qwen model=Qwen/Qwen3-TTS-12Hz-0.6B-Base ... device=cuda:1`,
`Qwen Base loaded.` **No `WinError5` anywhere in the log.** (A *separate*,
unrelated `POST /api/sidecar/load {"engine":"kokoro"}` call did fail — but
with `RuntimeError: Kokoro model not found at .../kokoro-v1.0.onnx` — this
throwaway never ran `install-kokoro.ps1`, so the weights were never fetched.
Not a WinError5, not related to the ORT marker fix; noted for completeness
only.)

## Fresh Install (criterion 5)

A **second**, separate throwaway (`castwright-e7-fresh`) was cloned via
`pterm download`. A real, unmodified `pterm run`/`install.js` today would
still resolve to real v1.14.0 (pre-fix) via the real Releases API — the same
release-gap this whole row is substituting around — so this used the same
documented-substitute reasoning: the fresh clone's default branch (`main`)
already contains the fix (`git merge-base --is-ancestor bf3586da main`
exits 0), so the install steps were run directly against that checkout
(conda env + `npm ci` ×2 + `npm run build` + `bootstrap-venv.mjs`) rather
than through `resolve-release.js`, which would otherwise move the checkout
*backward* off the fix.

Full build completed (conda env + `npm ci` ×2 + `npm run build` +
`bootstrap-venv.mjs`) — **`pip check` after fresh Install: `No broken
requirements found.`**, `onnxruntime`/`onnxruntime-gpu` both present and
mutually consistent, matching the Update path's outcome. Confirms the
`applyOrtMarkerWrite`/swap machinery in `bootstrap-venv.mjs` produces a
clean, working install from a cold start, not just from an Update.

## Not in scope

E1's macOS half. E11 (separate step, step 7, its own evidence file). Any
register edit (step 9 is the sole writer).
