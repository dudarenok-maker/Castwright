// Castwright — Pinokio install. Fully self-contained: conda provides Python 3.12
// + ffmpeg; Pinokio's bundled node provides npm. Builds from the latest PUBLISHED
// release, bootstraps the venv via the SHARED bootstrap-venv.mjs, writes .env.
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
    // 1. conda env: Python 3.12 + ffmpeg + mkcert. mkcert is here so the LAN-HTTPS
    //    default (phone/tablet listening + pairing) can auto-provision certs in
    //    step 7 — Pinokio runs `node dist/index.js` directly and never goes through
    //    start-app-prod.mjs's boot auto-provision, so the install must do it.
    //    (If Pinokio's bundled node < 20.19, add `nodejs` to this message too.)
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, message: 'conda install -y -c conda-forge ffmpeg mkcert' },
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
