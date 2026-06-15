// Castwright — Pinokio start. Runs the built server in the FOREGROUND under
// Pinokio's shell with `daemon: true`, so Pinokio tracks it as a running daemon
// (powers info.running() + native Stop). The server autostarts the sidecar
// (plan 43) and, on SIGTERM from Pinokio's Stop, tears it down
// (server/src/index.ts:494). The `on:` matcher captures the ready URL — the
// server prints `[server] listening on http://localhost:8080` (index.ts:320) —
// and `done: true` advances to local.set while keeping the daemon alive.
const CONDA = { path: 'env', python: '3.12' }; // path-keyed conda env at <app>/env

module.exports = {
  daemon: true,
  run: [
    {
      method: 'shell.run',
      params: {
        conda: CONDA,
        message: 'node server/dist/index.js',
        on: [{ event: '/http:\\/\\/localhost:8080/', done: true }],
      },
    },
    { method: 'local.set', params: { url: 'http://localhost:8080' } },
  ],
};
