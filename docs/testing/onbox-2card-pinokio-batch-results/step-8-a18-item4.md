# Step 8 — A18 item 4: Pinokio torchcodec outcome (Castwright#2957)

Parent #2950, campaign #2435. Discharges register row **A18, item 4 only**
(`docs/testing/onbox-acceptance-register.md:1847-1896`, item 4 at line 1894) —
whether `import torchcodec` succeeds or fails inside the nested `.venv` that
`pinokio-scripts/install.js` provisions, on a real Pinokio install. Items 1–3
of A18 and A18 item 2 are untouched; no register edit made (step 9 is the sole
writer).

## Setup

Pinokio's only pre-existing app registration (`C:\pinokio\api\`) was empty at
the start of this run (wiped by the daemon crash recorded on #2963's evidence
chain). A fresh throwaway app was registered rather than reusing/rebuilding
the real starred install:

- `pterm download https://github.com/dudarenok-maker/Castwright.git
  castwright-a18-check` — real Pinokio `app.download` RPC, registered at
  `C:\pinokio\api\castwright-a18-check`, checked out at `main` tip
  (`a592f5c1`).
- Following the precedent already established on this chain (step 6/E7,
  `step-6-e7.md`): Pinokio's own orchestrator (`pterm start` against
  `install.js`) is a known-stalling defect on this box, unrelated to the code
  under test. `install.js`'s own steps were therefore run **directly, in the
  same order and with the same commands the script itself declares**
  (`pinokio-scripts/install.js`), rather than through Pinokio's flaky
  step-sequencer:
  1. `conda create -y -p <app>\env python=3.12`, then
     `conda install -y -p <app>\env -c conda-forge "ffmpeg>=6" mkcert
     nodejs=24` — conda env at `C:\pinokio\api\castwright-a18-check\env`,
     matching `install.js`'s own `CONDA = { path: 'env', python: '3.12' }`.
     Confirmed present after: `env\Library\bin\ffmpeg.exe` (ffmpeg 9.0.1,
     conda-forge build) and `env\node.exe`.
  2. `npm ci --include=dev` (root), `npm --prefix server ci --include=dev` —
     both completed cleanly, 0 vulnerabilities.
  3. `node server/tts-sidecar/scripts/bootstrap-venv.mjs python` — the exact
     command `install.js` step 5 runs — with the conda env's `python`/`ffmpeg`
     on `PATH`. Created
     `C:\pinokio\api\castwright-a18-check\server\tts-sidecar\.venv`, resolved
     the `nvidia-cuda` accelerator profile, installed `torch==2.11.0+cu128`
     plus the full `requirements/nvidia-cuda.txt` overlay. Finished
     `[bootstrap-venv] done`, exit 0.
  4. `pip check` immediately after: **`No broken requirements found.`**

`install.js`'s remaining steps (`resolve-release.js`, `npm run build`,
`write-env.js`, `setup-lan-certs.mjs`) are irrelevant to A18 item 4 (venv
provisioning is what matters) and were not run, to keep this step scoped —
per the ticket's own instruction to touch item 4 alone.

## The `import torchcodec` test

`torchcodec` is not a base requirement — the codebase installs it only via
`server/tts-sidecar/scripts/install-coqui.mjs`'s Coqui opt-in path
(`pip install torchcodec --no-deps`, immediately after `coqui-tts`, because
coqui-tts presence-checks it at import on `torch>=2.9`). To match the register
row's own instruction ("run `import torchcodec` inside the nested `.venv`
that `pinokio/install.js` provisions") using the same install mechanism the
real pipeline uses, that one step was run directly against the nested venv
built above, without the rest of `install-coqui.mjs` (no `coqui-tts` install,
no XTTS weight download — out of scope for this item):

```
C:\pinokio\api\castwright-a18-check\server\tts-sidecar\.venv\Scripts\python.exe -m pip install torchcodec --no-deps
```

```
Collecting torchcodec
  Downloading torchcodec-0.16.0-cp312-cp312-win_amd64.whl.metadata (9.7 kB)
Downloading torchcodec-0.16.0-cp312-cp312-win_amd64.whl (6.4 MB)
   ---------------------------------------- 6.4/6.4 MB 28.3 MB/s eta 0:00:00
Installing collected packages: torchcodec
Successfully installed torchcodec-0.16.0
```

`pip check` immediately after: **`No broken requirements found.`** — installing
torchcodec did not perturb the pinned `torch==2.11.0+cu128`.

Then the outcome itself:

```
C:\pinokio\api\castwright-a18-check\server\tts-sidecar\.venv\Scripts\python.exe -c "import torchcodec; print('IMPORT OK'); print(torchcodec.__version__)"
```

```
IMPORT OK
0.16.0+cpu
```

**`import torchcodec` SUCCEEDS** inside the nested venv that
`pinokio-scripts/install.js` provisions on this box — no exception, no
traceback, no DLL-load error. (`torchcodec` resolved to the CPU-only wheel
`0.16.0+cpu` from PyPI's default index — the same outcome `install-coqui.mjs`
itself gets, since it does not pass a CUDA-specific `--index-url` for
torchcodec, only for `torch` itself. A CPU-only wheel does not link against
the CUDA runtime, so this run does not exercise a GPU-linked torchcodec
build; it answers exactly the question item 4 poses — bare importability in
this nested-venv/conda-ffmpeg layout — not torchcodec's CUDA decode path.)

This resolves the item's own stated uncertainty (design spec §11: whether a
nested venv created from the conda interpreter inherits loadable access to
conda's `Library/bin` DLLs) empirically: on this box, at this torchcodec
version (0.16.0, CPU wheel), it does — `import torchcodec` does not reach for
`ffmpeg`'s shared libraries at import time (only at actual decode time, which
this item does not test), so the conda-forge-ffmpeg-shared-vs-nested-venv
DLL-loadability gap the row worried about never gets exercised by a bare
import either way. As the row's own text notes, this outcome is moot for
behavior — #1967's fix makes a Coqui clone derive correctly regardless — but
is recorded here as the fact owed.

## Environment recorded

- Conda env: Python 3.12.14 (conda-forge), ffmpeg 9.0.1 (conda-forge, shared
  build), Node 24 (all at `C:\pinokio\api\castwright-a18-check\env`).
- Nested venv: `C:\pinokio\api\castwright-a18-check\server\tts-sidecar\.venv`,
  `torch==2.11.0+cu128`, `torchcodec==0.16.0+cpu`.
- GPU on this box: NVIDIA GeForce RTX 4070 Laptop GPU (not exercised by this
  item — see CPU-wheel note above).

## Not in scope

A18 items 1, 2, 3 (already discharged or separately scoped — untouched). Any
register edit (step 9 is the sole writer). Full `install-coqui.mjs` /
coqui-tts / XTTS weight fetch (not needed to answer this item; the presence
check is what pulls torchcodec in the real pipeline, and that mechanism —
`pip install torchcodec --no-deps` — is exactly what was reproduced here).
`npm run build`, `resolve-release.js`, `write-env.js`,
`setup-lan-certs.mjs` (irrelevant to venv provisioning, the only part of
`install.js` this item depends on).
