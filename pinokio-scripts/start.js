// Castwright — Pinokio start. Runs the built server in the FOREGROUND under
// Pinokio's shell with `daemon: true`, so Pinokio tracks it as a running daemon
// (powers info.running() + native Stop). The server autostarts the sidecar
// (plan 43) and, on SIGTERM from Pinokio's Stop, tears it down
// (server/src/index.ts:494). The `on:` matcher captures the ready URL from the
// server's `[server] listening on <proto>://localhost:<port>` line
// (server/src/index.ts:180) and `done: true` advances to local.set while keeping
// the daemon alive.
//
// The URL is CAPTURED, not hardcoded, so both modes work: default HTTP is
// http://localhost:8080, but with LAN sharing on (server/.env LAN_HTTPS=1) the
// server binds HTTPS on 8443 and prints https://localhost:8443. Anchoring the
// regex to `localhost` grabs the loopback URL Pinokio's browser can open — the
// server prints that line first, before the LAN-IP `[server] LAN URL:` lines.
//
// This script lives in pinokio-scripts/, one level below the app root — `path: '..'`
// is required so the shell (and CONDA's relative env path) resolve against
// the app root, not pinokio-scripts/ (see install.js's header comment).
//
// The server's env load is CWD-RELATIVE (`process.loadEnvFile('.env')` in
// server/src/load-env.ts) — it must run with its working directory at
// server/, or server/.env (WORKSPACE_DIR / GEN_WORKERS / GPU_VRAM_BUDGET /
// analyzer / GPU tuning) silently never loads and the server runs on bare
// defaults. So we keep `path: '..'` (for CONDA's env resolution) but
// `cd server &&` before node, exactly mirroring the prod launcher, which
// spawns `node dist/index.js` with `cwd: server/` (scripts/start-app-prod.mjs).
const APP_ROOT = '..';
const CONDA = { path: 'env', python: '3.12' }; // path-keyed conda env at <app>/env (relative to APP_ROOT)

module.exports = {
  daemon: true,
  run: [
    {
      method: 'shell.run',
      params: {
        path: APP_ROOT,
        conda: CONDA,
        // `cd server &&` (not `path: 'server'`) so CONDA's relative env path
        // still resolves against APP_ROOT — only the node process's own cwd
        // moves to server/, so its cwd-relative server/.env load works.
        message: 'cd server && node dist/index.js',
        // Match http://localhost:8080 (default) OR https://localhost:8443 (LAN
        // sharing). Capture group 1 is the exact URL, consumed below as
        // input.event[1] per the gepeto "Critical Pattern Lock".
        on: [{ event: '/(https?:\\/\\/localhost:[0-9]+)/', done: true }],
      },
    },
    { method: 'local.set', params: { url: '{{input.event[1]}}' } },
  ],
};
