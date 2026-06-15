// Castwright — Pinokio update. Fetch tags, checkout the newest PUBLISHED release,
// rebuild, re-bootstrap the venv. We own the detached-HEAD checkout explicitly
// rather than using Pinokio's built-in git update.
const CONDA = { path: 'env', python: '3.12' };

module.exports = {
  run: [
    // Single resolve+checkout step (fetch + API + checkout + guard live inside
    // resolve-release.js) — same fix as install.js, no {{input.event}} capture.
    { method: 'shell.run', params: { conda: CONDA, message: 'node pinokio/lib/resolve-release.js' } },
    { method: 'shell.run', params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm ci --include=dev' } },
    { method: 'shell.run', params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm --prefix server ci --include=dev' } },
    { method: 'shell.run', params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm run build' } },
    { method: 'shell.run', params: { conda: CONDA, message: 'node server/tts-sidecar/scripts/bootstrap-venv.mjs python' } },
  ],
};
