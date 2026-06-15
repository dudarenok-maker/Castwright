// Castwright — Pinokio install. Fully self-contained: conda provides Python 3.12
// + ffmpeg; Pinokio's bundled node provides npm. Builds from the latest PUBLISHED
// release, bootstraps the venv via the SHARED bootstrap-venv.mjs, writes .env.
// Kokoro weights are deferred to the in-app fs-21 wizard at first run.
//
// conda is path-keyed (matches shipping apps); steps default to the app-root cwd
// (Pinokio runs from the cloned repo root, where package.json lives), so no `path:`
// override is needed for git/npm/build. Confirmed on-box in the acceptance matrix.
const CONDA = { path: 'env', python: '3.12' }; // conda env created at <app>/env

module.exports = {
  run: [
    // 1. conda env: Python 3.12 + ffmpeg. (If Pinokio's bundled node < 20.19,
    //    add `conda install -y -c conda-forge nodejs` to this message.)
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'conda install -y -c conda-forge ffmpeg' },
    },
    // 2. Fetch + resolve + checkout the latest published release (detached HEAD),
    //    all inside resolve-release.js — no fragile cross-step variable capture.
    //    The script also guards against a pre-Pinokio release.
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'node pinokio/lib/resolve-release.js' },
    },
    // 3. Node deps — --include=dev so Vite (a devDependency) installs for the build.
    {
      method: 'shell.run',
      params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm ci --include=dev' },
    },
    {
      method: 'shell.run',
      params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm --prefix server ci --include=dev' },
    },
    // 4. Build dist/ + server/dist/.
    {
      method: 'shell.run',
      params: { conda: CONDA, env: { NODE_ENV: '' }, message: 'npm run build' },
    },
    // 5. Venv bootstrap via the SHARED chain — accelerator-profile resolver picks
    //    the overlay (nvidia-cuda/cpu/amd-rocm) + installs torch. ~2.5 GB.
    //    `python` is the conda interpreter; bootstrap-venv creates a nested .venv.
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'node server/tts-sidecar/scripts/bootstrap-venv.mjs python' },
    },
    // 6. Write server/.env (idempotent) with WORKSPACE_DIR=<app>/workspace.
    //    write-env.js defaults appDir to process.cwd() (the app root).
    {
      method: 'shell.run',
      params: { conda: CONDA, message: 'node pinokio/lib/write-env.js' },
    },
  ],
};
