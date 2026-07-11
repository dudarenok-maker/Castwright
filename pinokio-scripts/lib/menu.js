// buildMenu(state) → ordered Pinokio menu items. Pure; unit-tested.
// `state` is derived in pinokio.js from Pinokio's runtime accessors.
// Item shape (icon/default/text/href) matches shipping Pinokio apps.
//
// @param {{installed:boolean, running:boolean, url:string|null}} state
// @returns {Array<{default?:boolean, icon:string, text:string, href:string}>}
function buildMenu(state) {
  if (!state.installed) {
    return [{ default: true, icon: 'fa-solid fa-download', text: 'Install', href: 'pinokio-scripts/install.js' }];
  }
  if (state.running) {
    // The server takes ~1-2 min to reach its `listening on …` line (sidecar
    // autostart + engine warmup), so state.url is null for most of startup.
    // Mirror every shipping Pinokio app (comfy/flux-webui/dia/Kokoro-TTS): show
    // the live Terminal as the default until the URL is captured, then flip the
    // default to Open Web UI. NEVER render Open Web UI with a null href —
    // Pinokio can't navigate it and falls back to a bare terminal, which reads
    // to a first-time user as "there's no way to open the app".
    const terminal = { icon: 'fa-solid fa-terminal', text: 'Terminal', href: 'pinokio-scripts/start.js' };
    const stop = { icon: 'fa-solid fa-stop', text: 'Stop', href: 'pinokio-scripts/stop.js' };
    if (state.url) {
      // No `target` — Pinokio opens the web UI itself. state.url is the captured URL.
      return [
        { default: true, icon: 'fa-solid fa-rocket', text: 'Open Web UI', href: state.url },
        terminal,
        stop,
      ];
    }
    return [{ ...terminal, default: true }, stop];
  }
  return [
    { default: true, icon: 'fa-solid fa-play', text: 'Start', href: 'pinokio-scripts/start.js' },
    { icon: 'fa-solid fa-rotate', text: 'Update', href: 'pinokio-scripts/update.js' },
    {
      icon: 'fa-solid fa-trash',
      text: 'Reset',
      href: 'pinokio-scripts/reset.js',
      // Reset wipes node_modules/venv/dist and reinstalls (several minutes).
      // Every shipping Pinokio app confirms this destructive action.
      confirm: 'Reset Castwright? This deletes node_modules, the Python venv, and dist/, then reinstalls (several minutes). Your books and settings are kept.',
    },
  ];
}

module.exports = buildMenu;
