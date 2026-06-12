# fs-21 Wave 1 — In-app Kokoro installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the first-run wizard (and the Model Manager) a **one-click, in-app** way to install the **Kokoro TTS weights** — the default engine, excluded from the release zip, and the only TTS hard-blocker with no in-app installer today. Qwen/Coqui/Whisper already install in-app via Node `.mjs`; Kokoro only had terminal scripts.

**Architecture:** Mirror the existing install machinery exactly — a Node `install-*.mjs` spawned by an in-memory-job bootstrap class, fronted by a `POST /install` + `GET /install/:id` **polling** route (no SSE), and a self-contained `fetch`-polling React component wired into the Model Manager's `INSTALLER_BY_ID`. Kokoro is a pure file-download installer (no venv, no Python).

**Tech Stack:** Node 20 + TypeScript (server, ESM `.js` import extensions), `node:child_process` spawn, `node:crypto` SHA256, Vitest (server + frontend), React 18 + `fetch`-polling component, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-06-12-fs21-first-run-wizard-design.md` · **Epic:** #474 · **Branch:** `feat/fs21-wave1-install-parity` off `main` (worktree `C:\Claude\Projects\wt-fs21-wave1`).

> **Framing (corrected by the pre-execution adversarial review):** Kokoro terminal installers `install-kokoro.ps1` (Windows, SHA-verifying) and `install-kokoro.sh` (POSIX) **already exist and already work cross-platform**. The gap this wave closes is **in-app one-click** install: the install-bootstrap classes spawn `node <script>.mjs` uniformly, and can't portably spawn a `.ps1` on Linux or a `.sh` on Windows — so the button-driven path needs a **Node `install-kokoro.mjs`** (which also ports the `.ps1`'s SHA256 verify, which the `.sh` lacks). The new `.mjs` **coexists** with the terminal `.ps1`/`.sh` (INSTALL.md still references those) — it does not retire them.

> **Spec corrections to fold into the Wave 4 doc pass:** install progress is **polling, not SSE**; no `runInstallScript` platform-dispatch helper (the `.mjs` pattern needs none).

> **Scope split (adversarial review):** the **venv bootstrap (decision Z) moved to Wave 1b** — it's unverifiable on this box (the idempotent guard no-ops because a venv already exists) and its real `pip install` is inherently OWED, whereas this Kokoro wave is fully verifiable + independently valuable. The two share no code.

> **Per the standing rule, this plan already passed an adversarial review; the fixes below are folded in.**

---

## File Structure

- Create `server/tts-sidecar/scripts/install-kokoro.mjs` — Node downloader: fetch the two ONNX files to the kokoro weight dir, SHA256-verify against `model-hashes.json` (ports `install-kokoro.ps1` logic the `.sh` lacks), emit `[install-kokoro] <step>` stdout lines, delete + exit(1) on hash mismatch. Respects `KOKORO_MODEL_PATH`/`KOKORO_VOICES_PATH` env overrides (versioned-install layout). Coexists with the `.ps1`/`.sh`.
- Create `server/src/tts/kokoro-install-detect.ts` — `detectKokoroInstalledOnDisk(repoRoot): boolean`.
- Create `server/src/tts/kokoro-install-bootstrap.ts` — `class KokoroInstallBootstrap` (mirror `CoquiInstallBootstrap`, **binary** state — no `weights-missing`).
- Create `server/src/routes/kokoro-install.ts` — `kokoroInstallRouter` (mirror `coqui-install.ts`).
- Create `src/components/kokoro-install.tsx` — mirror `coqui-install.tsx` (fetch-polling).
- Modify `server/src/index.ts` (register `/api/kokoro`), `src/views/model-manager.tsx` (`INSTALLER_BY_ID` + comment), `src/views/model-manager.test.tsx` (invert the "no installer for kokoro" assertion), `server/src/tts/engine-presence.ts` (DRY via the new detect helper), `scripts/release-manifest.test.mjs` (pin the new `.mjs`), `INSTALL.md` (note the in-app option).
- Tests: `install-kokoro-helpers.test.ts`, `kokoro-install-detect.test.ts`, `kokoro-install-bootstrap.test.ts`, `kokoro-install.route.test.ts` (slow pool), `kokoro-install.test.tsx`.

---

## Task A1: `install-kokoro.mjs` (Node downloader + SHA256 verify)

**Files:** Create `server/tts-sidecar/scripts/install-kokoro.mjs`; Test `server/src/tts/install-kokoro-helpers.test.ts`.

- [ ] **Step 1: Write the failing helper test.** Mirror `server/src/tts/install-qwen3-helpers.test.ts` — note it imports the `.mjs` with a `// @ts-expect-error` (the `.mjs` ships no `.d.ts`). The new `.mjs` exports `sha256File(path)` and `kokoroHashes()`.

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error — .mjs script ships no type declarations (matches install-qwen3-helpers.test.ts)
import { sha256File, kokoroHashes } from '../../tts-sidecar/scripts/install-kokoro.mjs';

describe('install-kokoro helpers', () => {
  it('sha256File matches node:crypto', () => {
    const d = mkdtempSync(join(tmpdir(), 'k-')); const f = join(d, 'x');
    writeFileSync(f, 'hello kokoro');
    const want = createHash('sha256').update('hello kokoro').digest('hex');
    expect(sha256File(f)).toBe(want);
    rmSync(d, { recursive: true, force: true });
  });
  it('kokoroHashes exposes the two pinned weight files', () => {
    const h = kokoroHashes();
    expect(h['kokoro-v1.0.onnx'].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(h['voices-v1.0.bin'].sizeBytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`cd server && npx vitest run src/tts/install-kokoro-helpers.test.ts`).

- [ ] **Step 3: Implement `install-kokoro.mjs`.** Port `install-kokoro.ps1` (the SHA-verifying reference, ~lines 53-117) to Node, copying the structure of `install-qwen3.mjs` (repoRoot resolution, `sha256File` at qwen :54, `JSON.parse(readFileSync(model-hashes.json))` at qwen :45-46, main-guard at qwen :265 `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`):
  - Target dir: dirname of `process.env.KOKORO_MODEL_PATH`/`KOKORO_VOICES_PATH` if set, else `<repoRoot>/server/tts-sidecar/voices/kokoro`.
  - URLs: `https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/{kokoro-v1.0.onnx,voices-v1.0.bin}`.
  - `export function sha256File(p)`; `export function kokoroHashes()` → returns `JSON.parse(readFileSync(<scripts>/model-hashes.json)).kokoro` (object keyed by filename).
  - For each file: if present AND `sha256File === pin.sha256` → `[install-kokoro] <name> already present, verified`; else download (Node `https`/`fetch`), then verify sha256 vs pin; on mismatch `[install-kokoro] ERROR sha256 mismatch for <name>`, delete the file, `process.exit(1)`.
  - Emit `[install-kokoro] <step>` lines. `main()` runs only under the import-meta main-guard.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(sidecar): in-app install-kokoro.mjs with SHA256 verify (fs-21 wave 1)` (`git add server/tts-sidecar/scripts/install-kokoro.mjs server/src/tts/install-kokoro-helpers.test.ts`).

---

## Task A2: `kokoro-install-detect.ts` (+ DRY engine-presence)

**Files:** Create `server/src/tts/kokoro-install-detect.ts`, `server/src/tts/kokoro-install-detect.test.ts`; modify `server/src/tts/engine-presence.ts`.

- [ ] **Step 1: Failing test** — `detectKokoroInstalledOnDisk(repoRoot)` false on an empty temp root, true when both weight files exist under `server/tts-sidecar/voices/kokoro/` (mirror `engine-presence.test.ts`'s temp-tree / mock approach).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `export function detectKokoroInstalledOnDisk(repoRoot: string): boolean { return totalSizeBytes(kokoroWeightPaths(repoRoot)).fileCount > 0; }` (import both from `./model-paths.js`). Then refactor `server/src/tts/engine-presence.ts` to call `detectKokoroInstalledOnDisk(repoRoot)` for its kokoro check instead of the inline `totalSizeBytes(kokoroWeightPaths(repoRoot)).fileCount > 0`. The existing `engine-presence.test.ts` mocks `./model-paths.js`, and the new helper calls the same mocked functions transitively, so it stays green — verify by running it.
- [ ] **Step 4: Run → PASS** (`kokoro-install-detect.test.ts` + `engine-presence.test.ts` both green).
- [ ] **Step 5: Commit** `refactor(server): extract detectKokoroInstalledOnDisk + DRY engine-presence (fs-21 wave 1)`.

---

## Task A3: `KokoroInstallBootstrap`

**Files:** Create `server/src/tts/kokoro-install-bootstrap.ts`, `server/src/tts/kokoro-install-bootstrap.test.ts`.

- [ ] **Step 1: Read `server/src/tts/coqui-install-bootstrap.ts` + `coqui-install-bootstrap.test.ts` in full.** Mirror for Kokoro, with these deliberate divergences:
  - **Binary state only** — `detect()` maps `detectKokoroInstalledOnDisk` to `'not-installed' | 'installed'`. **DO NOT copy Coqui's `weights-missing` middle state or its post-spawn `weights-missing` error branch** (that's Coqui's venv-package-vs-weights split, which Kokoro doesn't have).
  - Spawn `this.spawnFn('node', [join(repoRoot,'server','tts-sidecar','scripts','install-kokoro.mjs'), ...installArgs], { cwd: repoRoot, windowsHide: true })`.
  - `[install-kokoro]` stdout step regex; stderr-tail on non-zero exit; in-memory `Map<string, KokoroInstallJob>`; `detect/start/getJob/getActiveJob/recheck/_reset`.
- [ ] **Step 2: Write the failing test** mirroring `coqui-install-bootstrap.test.ts` (stubbed `spawnFn` + `detectFn`): start() spawns exactly once; short-circuits to `installed` without spawning when already present; non-zero exit → `error` with stderr tail; `[install-kokoro]` lines update `job.step`.
- [ ] **Step 3: Run → FAIL; Step 4: implement; Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(server): KokoroInstallBootstrap (fs-21 wave 1)`.

---

## Task A4: `kokoro-install.ts` route + registration (slow-pool route test)

**Files:** Create `server/src/routes/kokoro-install.ts`, `server/src/routes/kokoro-install.route.test.ts`; modify `server/src/index.ts`, `server/vitest.config.slow.ts`, `server/vitest.config.ts`.

- [ ] **Step 1: Read `server/src/routes/coqui-install.ts` + its registration (`index.ts:248`).** Mirror: `kokoroInstallRouter` with GET `/detect`, POST `/install`, GET `/install/:id`, POST `/install/:id/recheck`, backed by a module-singleton `KokoroInstallBootstrap`, exposing the same test-injection hook coqui's route has.
- [ ] **Step 2: Write the slow-pool route test** (mirror coqui route test + Wave 0's `setup-readiness.route.test.ts`): stubbed bootstrap; assert detect/poll shapes + 202 on install. Add `'src/routes/kokoro-install.route.test.ts'` to `SLOW_FILES` (`server/vitest.config.slow.ts`) AND `SLOW_FILES_TO_EXCLUDE` (`server/vitest.config.ts`).
- [ ] **Step 3: Run → FAIL; Step 4: implement route + register `app.use('/api/kokoro', kokoroInstallRouter)` after the coqui line (index.ts:248); Step 5: run slow test → PASS + `npm run typecheck`.**
- [ ] **Step 6: Commit** `feat(server): /api/kokoro in-app install route (fs-21 wave 1)`.

---

## Task A5: `kokoro-install.tsx` component

**Files:** Create `src/components/kokoro-install.tsx`, `src/components/kokoro-install.test.tsx`.

- [ ] **Step 1: Read `src/components/coqui-install.tsx` in full.** Mirror: `KokoroInstall({ onInstalled })`, `POLL_INTERVAL_MS = 1_500`, `fetch('/api/kokoro/detect')` / `POST /api/kokoro/install` / `GET /api/kokoro/install/:id`, four render states (installed / installing+step / error+retry / not-installed+button). Design tokens only, no hex.
- [ ] **Step 2: Write the failing test** mirroring `coqui-install.test.tsx` (mock `fetch`): renders install button when not installed; shows step while installing; calls `onInstalled` when status flips to `installed`.
- [ ] **Step 3: Run → FAIL; Step 4: implement; Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(frontend): KokoroInstall polling component (fs-21 wave 1)`.

---

## Task A6: wire Kokoro into the Model Manager (INVERT the existing assertion)

**Files:** Modify `src/views/model-manager.tsx`, `src/views/model-manager.test.tsx`.

- [ ] **Step 1: Read `src/views/model-manager.test.tsx` around line 377.** There is an EXISTING passing test "**offers no install toggle for a release-bundled model (kokoro)**" asserting `queryByTestId('model-install-toggle-kokoro')` is **null**. Adding the kokoro installer will make that toggle render → that test goes red. **Invert it**: rename/rewrite it to assert the kokoro install toggle now RENDERS (mirror how the test asserts the coqui/qwen-base/whisper toggles render). This is the blocking step the adversarial review flagged.
- [ ] **Step 2: Run → the inverted assertion FAILS** (toggle not yet rendered) `npx vitest run src/views/model-manager.test.tsx`.
- [ ] **Step 3: Implement** — import `KokoroInstall`, add `kokoro: KokoroInstall` to `INSTALLER_BY_ID` (`model-manager.tsx:40-44`), and **update the stale comment at `model-manager.tsx:39`** ("kokoro ships in the release bundle… none get a row installer") to note kokoro now has an in-app installer (fs-21 wave 1; weights are fetched at install time, not bundled).
- [ ] **Step 4: Run → PASS + `npm run typecheck`.**
- [ ] **Step 5: Commit** `feat(frontend): wire Kokoro installer into Model Manager (fs-21 wave 1)`.

---

## Task A7: docs + release-manifest hygiene

**Files:** Modify `scripts/release-manifest.test.mjs`, `INSTALL.md`.

- [ ] **Step 1:** In `scripts/release-manifest.test.mjs`, add an `INCLUDED`-assertion line for `server/tts-sidecar/scripts/install-kokoro.mjs` next to where `install-kokoro.ps1`/`.sh` are pinned (~lines 47-48). Run the manifest test → PASS (it already passes via the `server/tts-sidecar/**` wildcard; this just pins it explicitly).
- [ ] **Step 2:** In `INSTALL.md`, where `install-kokoro.ps1`/`install-kokoro.sh` are referenced (~lines 44-45, 77-78, 115-116), add a one-line note that Kokoro can now also be installed **in-app via the Model Manager** (no terminal needed). Keep the terminal commands.
- [ ] **Step 3: Commit** `docs(scripts,docs): pin install-kokoro.mjs + note in-app install (fs-21 wave 1)`.

---

## Task A8: Full verify + draft PR

- [ ] **Step 1:** `npm run verify` green (retry the `test:server` worker-flake under contention as in Wave 0 — cache-aware verify heals incrementally).
- [ ] **Step 2:** `gh pr create --draft --title "feat(server,frontend,sidecar): fs-21 wave 1 — in-app Kokoro installer" --body "... Refs #474. OWED: real Kokoro install on a Mac + a Linux box (the .mjs is Node-cross-platform; logic + offline flow are tested here)."` Then `gh pr ready` once green.

---

## Self-Review

**Spec coverage (Wave 1 = Kokoro in-app installer):** install-kokoro.mjs (A1) → detect helper + DRY (A2) → bootstrap (A3) → route (A4) → component (A5) → Model Manager wiring + inverted test (A6) → docs/manifest (A7) → verify/PR (A8). The venv bootstrap is **Wave 1b** (separate plan).

**Adversarial-review fixes folded in:** (1) A6 inverts the existing `model-manager.test.tsx:377` "no kokoro installer" assertion + updates the comment [was the blocking defect]; (2) A1 test carries `// @ts-expect-error` on the `.mjs` import; (3) A3 explicitly drops Coqui's `weights-missing` branch (Kokoro is binary); (4) framing fixed — `.sh`/`.ps1` already exist, the value is in-app one-click, the `.mjs` coexists; (5) INSTALL.md + release-manifest ripples named (A7). The `/api/setup/venv` mount question is moot (moved to 1b). Express-5 multi-mount + engine-presence DRY were verified safe.

**OWED (not CI-gated):** real Kokoro install on Mac + Linux boxes (the `.mjs` is Node-cross-platform; offline + stubbed-spawn flow is fully tested here).
