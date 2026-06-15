// Castwright — Pinokio stop. Pinokio's NATIVE Stop (SIGTERM to the daemon) is the
// primary path and the server reaps the sidecar on SIGTERM. This explicit stop.js
// is a defensive sweep: stop:prod reads the pid files, tree-kills any survivors,
// and sweeps :8080/:9000 — covering the case where a child outlived the signal.
const CONDA = { path: 'env', python: '3.12' };

module.exports = {
  run: [
    { method: 'shell.run', params: { conda: CONDA, message: 'npm run stop:prod' } },
    { method: 'local.set', params: { url: null } },
  ],
};
