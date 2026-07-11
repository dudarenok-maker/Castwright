// Castwright — Pinokio reset. Remove derived runtime (venv, node_modules, dist),
// then reinstall from scratch. Does NOT touch server/.env or workspace/ (user data).
// Native `fs.rm` is the idiomatic, cross-platform reset primitive. script.start uri
// is sibling-relative to this script's dir (pinokio-scripts/), so 'install.js'.
//
// This script lives in pinokio-scripts/, one level below the app root — every fs.rm
// `path` is resolved relative to THIS script's own directory (per Pinokio's
// "distributed file URI" rule), so each target needs a `../` prefix to reach
// the app root instead of pinokio-scripts/ (see install.js's header comment). The
// script.start uri is unaffected — sibling-relative resolution is correct as-is.
module.exports = {
  run: [
    { method: 'fs.rm', params: { path: '../server/tts-sidecar/.venv' } },
    { method: 'fs.rm', params: { path: '../node_modules' } },
    { method: 'fs.rm', params: { path: '../server/node_modules' } },
    { method: 'fs.rm', params: { path: '../dist' } },
    { method: 'fs.rm', params: { path: '../server/dist' } },
    { method: 'script.start', params: { uri: 'install.js' } },
  ],
};
