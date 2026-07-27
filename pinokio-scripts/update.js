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
    //    it — an install created before this pin existed would keep running on
    //    Pinokio's bundled Node forever, even across updates, without this step.
    //    `conda install` is idempotent, so on an already-pinned env this is a cheap
    //    no-op.
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        message: 'conda install -y -c conda-forge nodejs=24',
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
