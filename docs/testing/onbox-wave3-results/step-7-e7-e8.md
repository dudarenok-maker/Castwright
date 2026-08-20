# Wave 3 step 7 — E7, E8

Issue: Castwright#2501 · Chain: Castwright#2497 step 7 of 10 · Plan of record: `docs/testing/onbox-wave3-plan.md` §4 (step 7)

Worktree: `wt-2497-onbox-wave3-run` @ `e19a3b1a` (HEAD at run time, unchanged — no source diff, docs-only). Dev server already running in this worktree on its isolated slot-11 port (`8190`), left running throughout and after.

## Summary verdicts

| Row | Verdict | One-line why |
|---|---|---|
| E7 | **Split** — server/API half **DISCHARGED**, rendered-card half **OPERATOR** | The register's own framing ("progress card") names a browser render; the job/poll wiring underneath it is server-side and was run for real, not mocked. |
| E8 | **STILL OWED** | No second machine or container with a genuinely different `ffmpeg` build exists on this box — checked and confirmed absent (below), not assumed. |

---

## E7 · fe-57 venv-bootstrap progress card ([#1883](https://github.com/dudarenok-maker/Castwright/issues/1883), plan [270](../../features/270-openapi-setup-surface.md))

**Re-resolved 2026-08-20** against the register (`docs/testing/onbox-acceptance-register.md` L3051-3085) and the wave-3 plan's own E7 row (L277-283). Nothing has changed since the plan's same-day re-derivation.

**Why split.** The register's own text names the fix as "the progress card" and its observations (steps 1-4) describe a rendered UI: a spinner, a "Setting up the voice engine runtime…" heading, and the step text changing visibly on screen within ~1.5s of a click. That is a browser observation and this run does not approximate it from an API response, per the issue's explicit instruction. But every one of those observations rides on the same job created by `POST /api/setup/venv/bootstrap` and polled by `GET /api/setup/venv/bootstrap/:id` (`server/src/routes/venv-bootstrap.ts`) — the exact wiring the register says "no automated test has ever driven... from a real bootstrap job" (L3064-3065), because every existing test mocks `fetch`. That half is server-side, is not mocked here, and is this step's to run.

**Precondition — venv genuinely absent, not just untouched:**

```
$ ls server/tts-sidecar/.venv
ls: cannot access 'server/tts-sidecar/.venv': No such file or directory
```

This worktree's `tts-sidecar/.venv` has never existed (a fresh worktree checkout, not a deletion of a real one) — satisfies the plan's "absence state" precondition without touching any live venv anywhere on the box.

**1. Detect (no job) — confirms the absent-venv precondition through the real API, not just the filesystem:**

```
$ curl -s http://127.0.0.1:8190/api/setup/venv/detect
{"state":"absent","venvPresent":false,"pythonFound":true,"installed":false}
```

**2-4. Real bootstrap job, polled to completion — a real `bootstrap-venv.mjs` subprocess, real network installs, no mock:**

```
$ curl -s -X POST http://127.0.0.1:8190/api/setup/venv/bootstrap
{"id":"1","status":"bootstrapping","step":"Starting venv bootstrap…","error":null,"startedAt":1787207150036,"updatedAt":1787207150091}

$ # polled GET /api/setup/venv/bootstrap/1 every 10s; distinct step values over the run:
2026-08-20T06:26:05Z bootstrapping — "pre-installing torch from the nvidia index (https://download.pytorch.org/whl/cu128)"
2026-08-20T06:29:42Z bootstrapping — "installing requirements (nvidia overlay; this can take several minutes)"
2026-08-20T06:34:44Z bootstrapping — "swapping ONNX runtime → the nvidia GPU build"
2026-08-20T06:34:54Z installed    — "Done. Venv ready."
```

Total wall-clock ~8m49s (06:26:05 → 06:34:54) — the multi-minute, multi-step real install the register's ~2 GB-download timing is about. This proves the poll loop and the job are wired to a real advancing bootstrap (register observation 3: "the step text change... proves the poll loop and the card are wired to the same job, not just that a card rendered once") and that it reaches a genuine terminal `installed` state (observation 4).

**Confirmed installed, independently, via `detect` and the filesystem (not just the job object's own say-so):**

```
$ curl -s http://127.0.0.1:8190/api/setup/venv/detect
{"state":"present","venvPresent":true,"pythonFound":true,"installed":true}

$ ls server/tts-sidecar/.venv
Include  Lib  Scripts  pyvenv.cfg  share
```

**What was not run, and why it stays OPERATOR:**

- Observations 1, 2, 4, 5 (the "Set up the voice engine runtime" button, the progress card appearing within ~1.5s with spinner and heading, the green ready card, `onBootstrapped` refetching without a reload, the brief `detecting` frame) are all rendered-page states — no API-only substitute is stated in the row, and none was approximated here.
- Observation 6 (failure path via "no Python 3.12 on PATH") needs removing Python from PATH on a shared box other lanes may be using — not cheap here, not attempted.
- **Joins `onbox-sitting-device-browser.md`** (the wave-2 pack already carrying the phone/Mac/browser rows E1, E2, E3, E5, E6, E9, E10) for the remaining rendered-card observations. Step 9 of this chain should add E7's browser half there; this step does not edit the sitting plan itself, per the issue's own "not in scope."

**Nothing excluded** — the row's full remaining criteria are exactly the register's six numbered observations; none was narrowed, only split along the server/browser line the issue itself directed.

---

## E8 · ops-36 golden-assembly on a second ffmpeg build ([#1880](https://github.com/dudarenok-maker/Castwright/issues/1880), plan [272](../../features/272-golden-assembly-comparison.md))

**Re-resolved 2026-08-20** against the register (L3088-3105) and the plan's own E8 row (L284-287, which itself suggests "a 22.04 container with archive ffmpeg 4.4").

**Baseline ffmpeg on this box:**

```
$ ffmpeg -version
ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers
```

**Checked for a second, genuinely different build — none found:**

```
$ docker --version
bash: docker: command not found

$ wsl --version
The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.

$ find /c/Claude -iname "ffmpeg.exe"
(no match)

$ find /c/Users/dudar -iname "ffmpeg.exe"
C:\Users\dudar\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe
```

The only other `ffmpeg.exe` on the box is the WinGet package backing the same `8.1.1-full_build-www.gyan.dev` binary already on `PATH` — not a different build. No Docker, no WSL, no container runtime of any kind is installed, and no second machine is available to this run.

**STILL OWED.** `npm run test:golden-audio:assembly` was **not run** — running it here would only repeat the same single-ffmpeg case the register already says "proves nothing" (L3095: "cannot be exercised on a box with one ffmpeg"), and the issue is explicit that running the suite twice against the same ffmpeg is not the row. Installing WSL or a container runtime to manufacture a second build is a box-level environment change — out of scope for this pass and not attempted without operator sign-off.

**Nothing excluded** — the row's full remaining criteria (L1-L4 tier results and deltas, whether L4 takes the LOOSE path, L4-loose's actual RMS-error, all under a genuinely different build) are unchanged; none was narrowed. **No `--bless` was run at any point in this pass** — the suite itself was never invoked.

---

## Box-safety confirmation

- No sidecar venv anywhere on the box was modified, wiped, or force-reinstalled — E7's bootstrap ran against this worktree's own, previously-nonexistent `tts-sidecar/.venv`, never the live one.
- The dev server on port `8190` was already running before this pass and was left running, untouched, after — no server or sidecar was stopped.
- No other lane's process was touched.
- No real book data was read, written, or mutated — neither row touches workspace data.
- No `--apply`/`--write`/`--fix` mode was exercised.
- No environment change (Docker, WSL) was installed to work around E8's missing infrastructure.

## Re-resolution note

Dated **2026-08-20**. Both rows' owed text was re-read directly from `docs/testing/onbox-acceptance-register.md` at this worktree's current HEAD (`e19a3b1a`), matching the wave-3 plan's own same-day citations exactly. **Nothing excluded** — E7's split follows the issue's own instruction, not a narrowing of scope; E8's block is a live, independently-checked infrastructure gap, not assumed from the plan's suggestion of a container.
