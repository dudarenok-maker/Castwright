export const DIMS = {
  phone: { w: 1764, h: 3136 },
  feature: { w: 1024, h: 500 },
  tabletLandscape: { w: 2560, h: 1600 },
  tabletPortrait: { w: 1600, h: 2560 },
};

/** Canvas dims for a template name. */
export function dimsForTemplate(template) {
  switch (template) {
    case 'phone': return DIMS.phone;
    case 'tabletPortrait': return DIMS.tabletPortrait;
    case 'tabletLandscape':
    case 'foldBezel': return DIMS.tabletLandscape;
    default: throw new Error(`unknown template: ${template}`);
  }
}

// Raw-capture path RELATIVE to RAW_DIR, as a pure fn so the surface/scene field
// wiring is unit-testable (the runner's I/O is not). rawSubdir resolves
// per-scene first (fold sets it per-scene), then surface, then '' (flat phone).
// rawId lets a scene read a differently-named raw (fold seam reuses 'library-home').
export function rawRelPath(surface, scene, theme) {
  const sub = scene.rawSubdir ?? surface.rawSubdir ?? '';
  const stem = scene.rawId ?? scene.id;
  return sub ? `${sub}/${stem}.${theme}.png` : `${stem}.${theme}.png`;
}

// Curated, ORDERED phone set — captions moved verbatim from the old SCENES array.
const PHONE_SCENES = [
  { id: 'library-home', caption: 'Your whole library,\nin one place.' },
  { id: 'player', caption: 'Every character,\ntheir own voice.' },
  { id: 'book-detail', caption: 'Every chapter,\nbeautifully in order.' },
  { id: 'library-offline', caption: 'Downloaded once.\nYours to hear offline.' },
  { id: 'pairing', caption: 'Pairs to your own server —\nnothing leaves your LAN.' },
  { id: 'settings', caption: 'Tuned exactly\nto how you listen.' },
];

export const SURFACES = [
  {
    id: 'phone',
    template: 'phone',
    rawSubdir: '', // flat — unchanged phone raw location
    outDir: 'screenshots/phone',
    scenes: PHONE_SCENES,
  },
];
