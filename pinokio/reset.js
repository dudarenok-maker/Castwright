// Castwright — Pinokio reset. Remove derived runtime (venv, node_modules, dist),
// then reinstall from scratch. Does NOT touch server/.env or workspace/ (user data).
// Native `fs.rm` is the idiomatic, cross-platform reset primitive. script.start uri
// is sibling-relative to this script's dir (pinokio/), so 'install.js'.
module.exports = {
  run: [
    { method: 'fs.rm', params: { path: 'server/tts-sidecar/.venv' } },
    { method: 'fs.rm', params: { path: 'node_modules' } },
    { method: 'fs.rm', params: { path: 'server/node_modules' } },
    { method: 'fs.rm', params: { path: 'dist' } },
    { method: 'fs.rm', params: { path: 'server/dist' } },
    { method: 'script.start', params: { uri: 'install.js' } },
  ],
};
