// Castwright — Pinokio update. Fetch tags, checkout the newest PUBLISHED release,
// rebuild, re-bootstrap the venv. We own the detached-HEAD checkout explicitly
// rather than using Pinokio's built-in git update.
//
// This script lives in pinokio-scripts/, one level below the app root — `path: '..'`
// is required so the shell resolves against the app root (see install.js).
const APP_ROOT = '..';
const CONDA = { path: 'env', python: '3.12' };

module.exports = {
  run: [
    // 0. Re-assert the pinned Node (see install.js step 1) before any node/npm step
    //    below. update.js reuses the EXISTING conda env and never otherwise touches
    //    it, so without this step an install created before the pin existed would
    //    keep running on Pinokio's bundled Node forever, across every update.
    //    `conda install` is idempotent, so on an already-pinned env this is a cheap
    //    no-op (a solve, not a download).
    //
    //    ONE-UPDATE LAG — do not read this step as covering the update that
    //    introduces it. Pinokio loads THIS file from the currently checked-out
    //    release and iterates the run[] it loaded; step 1 below (resolve-release.js)
    //    `git checkout`s the new tag mid-run, replacing this file on disk without
    //    affecting the already-loaded array. So a user updating FROM a pre-pin
    //    release runs their old update.js — no step 0 — and does that update's
    //    `npm ci`/build on the bundled Node. The pin applies from their NEXT
    //    update onward. Nothing here can close that window; it is called out in
    //    218-pinokio-installer.md open verification 2 and register row E1 so the
    //    on-box tester expects the lag instead of reporting it as a broken pin.
    //
    //    `"ffmpeg>=6"` (ops-35, #1877) rides this SAME step for the same reason:
    //    an env created before the constraint existed would otherwise keep
    //    whatever conda-forge ffmpeg it was born with, forever, across every
    //    update. The ONE-UPDATE LAG above applies to it identically — a user
    //    updating FROM a pre-ops-35 release runs their old update.js, which has
    //    no ffmpeg constraint, so it applies from their NEXT update onward.
    //    See install.js step 1 for why `>=` rather than an equality pin.
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        message: 'conda install -y -c conda-forge "ffmpeg>=6" nodejs=24',
      },
    },
    // Single resolve+checkout step (fetch + API + checkout + guard live inside
    // resolve-release.js) — same fix as install.js, no {{input.event}} capture.
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, message: 'node pinokio-scripts/lib/resolve-release.js' },
    },
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
    {
      method: 'shell.run',
      params: { path: APP_ROOT, conda: CONDA, env: { NODE_ENV: '' }, message: 'npm run build' },
    },
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        message: 'node server/tts-sidecar/scripts/bootstrap-venv.mjs python',
      },
    },
  ],
};
