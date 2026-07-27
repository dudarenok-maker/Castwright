// Castwright — Pinokio install. Fully self-contained: conda provides Python 3.12
// + ffmpeg + a pinned Node 24 (step 1), so nothing here depends on Pinokio's own
// bundled Node. Builds from the latest PUBLISHED release, bootstraps the venv via
// the SHARED bootstrap-venv.mjs, writes .env.
// Kokoro weights are deferred to the in-app fs-21 wizard at first run.
//
// Every pinokio-scripts/*.js script here lives ONE LEVEL BELOW the app root (where
// package.json/server/ live) — Pinokio starts a shell.run's cwd at the
// currently running script's OWN directory (pinokio-scripts/), not the app root, so
// every step needs an explicit `path: '..'` to reach it. Confirmed on-box
// 2026-07-11: without it, conda's relative env path resolved to
// pinokio-scripts/env instead of <app>/env (see docs/features/218-pinokio-installer.md).
const APP_ROOT = '..';
const CONDA = { path: 'env', python: '3.12' }; // conda env created at <app>/env (relative to APP_ROOT)

module.exports = {
  run: [
    // 1. conda env: Python 3.12 + ffmpeg + mkcert + a pinned Node. mkcert is here so
    //    the LAN-HTTPS default (phone/tablet listening + pairing) can auto-provision
    //    certs in step 7 — Pinokio runs `node dist/index.js` directly and never goes
    //    through start-app-prod.mjs's boot auto-provision, so the install must do it.
    //    `nodejs=24` pins every later `node`/`npm` step (this file + update.js) to the
    //    Node major this repo actually tests on (.nvmrc, every CI workflow), instead of
    //    whatever unpinned/unverifiable Node Pinokio's own kernel happens to bundle —
    //    which could sit below the `>=22.22.0` engines floor react-router 8 raised in
    //    #1859. The conda env's Node shadows Pinokio's bundled one on PATH for every
    //    step below (conda envs prepend to PATH). See docs/testing/onbox-acceptance-register.md
    //    (E1) for what's still owed on-box.
    //
    //    `"ffmpeg>=6"` (ops-35, #1877) is a CONSTRAINT, not a pin. The audio path
    //    parses ffmpeg's loudnorm JSON output, so the version is part of our
    //    contract, and package.json's `castwright.ffmpeg.minimum` declares the
    //    supported floor. `>=` excludes builds below that floor while leaving
    //    security updates free to flow — #1876 wanted exactly this and declined
    //    only because no validated floor existed yet. conda-forge ships 8.x today,
    //    so this is a guard, not a behaviour change. ffmpeg-pin.test.js parses the
    //    major back out of package.json so the two cannot drift apart.
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        message: 'conda install -y -c conda-forge "ffmpeg>=6" mkcert nodejs=24',
      },
    },
    // 2. Fetch + resolve + checkout the latest published release (detached HEAD),
    //    all inside resolve-release.js — no fragile cross-step variable capture.
    //    The script also guards against a pre-Pinokio release.
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, message: 'node pinokio-scripts/lib/resolve-release.js' },
    },
    // 3. Node deps — --include=dev so Vite (a devDependency) installs for the build.
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, env: { NODE_ENV: '' }, message: 'npm ci --include=dev' },
    },
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        env: { NODE_ENV: '' },
        message: 'npm --prefix server ci --include=dev',
      },
    },
    // 4. Build dist/ + server/dist/.
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, env: { NODE_ENV: '' }, message: 'npm run build' },
    },
    // 5. Venv bootstrap via the SHARED chain — accelerator-profile resolver picks
    //    the overlay (nvidia-cuda/cpu/amd-rocm) + installs torch. ~2.5 GB.
    //    `python` is the conda interpreter; bootstrap-venv creates a nested .venv.
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        message: 'node server/tts-sidecar/scripts/bootstrap-venv.mjs python',
      },
    },
    // 6. Write server/.env (idempotent) with WORKSPACE_DIR=<app>/workspace.
    //    write-env.js defaults appDir to process.cwd() (the app root).
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, message: 'node pinokio-scripts/lib/write-env.js' },
    },
    // 7. Provision mkcert LAN certs so the first Start serves HTTPS on :8443 and
    //    phones/tablets can pair. Best-effort + non-fatal: setup-lan-certs.mjs
    //    exits 0 even if mkcert is unavailable (server falls back to loopback HTTP).
    //    conda: CONDA puts the step-1 mkcert on PATH. Each device still installs the
    //    mkcert root CA once (the pairing QR carries the CA fingerprint to pin).
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, message: 'node scripts/setup-lan-certs.mjs --best-effort' },
    },
  ],
};
