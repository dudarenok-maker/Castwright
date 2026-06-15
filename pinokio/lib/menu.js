// buildMenu(state) → ordered Pinokio menu items. Pure; unit-tested.
// `state` is derived in pinokio.js from Pinokio's runtime accessors.
// Item shape (icon/default/text/href) matches shipping Pinokio apps.
//
// @param {{installed:boolean, running:boolean, url:string|null}} state
// @returns {Array<{default?:boolean, icon:string, text:string, href:string}>}
function buildMenu(state) {
  if (!state.installed) {
    return [{ default: true, icon: 'fa-solid fa-download', text: 'Install', href: 'pinokio/install.js' }];
  }
  const items = [];
  if (state.running) {
    // No `target` — Pinokio opens the web UI itself. state.url is the captured URL.
    items.push({ default: true, icon: 'fa-solid fa-rocket', text: 'Open Web UI', href: state.url });
    items.push({ icon: 'fa-solid fa-stop', text: 'Stop', href: 'pinokio/stop.js' });
  } else {
    items.push({ default: true, icon: 'fa-solid fa-play', text: 'Start', href: 'pinokio/start.js' });
  }
  items.push({ icon: 'fa-solid fa-rotate', text: 'Update', href: 'pinokio/update.js' });
  items.push({ icon: 'fa-solid fa-trash', text: 'Reset', href: 'pinokio/reset.js' });
  return items;
}

module.exports = buildMenu;
