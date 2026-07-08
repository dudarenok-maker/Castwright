// Castwright — Pinokio entry-point. Thin: derives state from Pinokio's runtime
// accessors and delegates ordering to the unit-tested pinokio/lib/menu.js.
// Accessor shapes below match shipping Pinokio apps (TRELLIS/comfy/facefusion);
// confirmed on-box in the regression plan acceptance matrix.
//
// This file lives at the repo root, under the root package.json's
// "type": "module" — Pinokio's runtime dynamically imports it in-process, so
// it must be genuine ESM (CommonJS globals like require/__dirname/module
// throw a ReferenceError at import time here). pinokio/lib/menu.js stays
// CommonJS (its own pinokio/package.json overrides type back to commonjs
// for the scripts Pinokio spawns as subprocesses); importing it from ESM
// picks up its `module.exports` as the default export.
import buildMenu from './pinokio/lib/menu.js';

export default {
  version: '1.0',
  title: 'Castwright',
  description: 'Any book, performed by a full cast — effortlessly.',
  icon: 'public/icon-512.png',
  menu: async (kernel, info) => {
    const installed = info.exists('node_modules') && info.exists('server/.env');
    // start.js runs the server in the FOREGROUND under Pinokio with `daemon: true`,
    // so Pinokio tracks it: info.running() is the idiomatic running-check.
    const running = info.running('pinokio/start.js');
    // info.local is a FUNCTION keyed by the script that set the local, not a
    // property. start.js does local.set({ url }).
    const local = info.local('pinokio/start.js');
    const url = (local && local.url) || null;
    return buildMenu({ installed, running, url });
  },
};
