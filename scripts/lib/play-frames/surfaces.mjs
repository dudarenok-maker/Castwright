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

const TABLET_SCENES = [
  { id: 'library-home', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Your library and\nwhat’s playing — side by side.' },
  { id: 'player', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Keep listening while\nyou browse the shelf.' },
  { id: 'book-detail', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Every chapter, open\nbeside your library.' },
  { id: 'library-offline', orientation: 'landscape', template: 'tabletLandscape',
    caption: 'Downloaded once.\nYours to hear offline.' },
  { id: 'settings', orientation: 'portrait', template: 'tabletPortrait',
    caption: 'Tuned exactly\nto how you listen.' },
  { id: 'pairing', orientation: 'portrait', template: 'tabletPortrait',
    caption: 'Pairs to your own server —\nnothing leaves your LAN.' },
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

SURFACES.push(
  { id: 'tablet7', rawSubdir: 'tablet7', outDir: 'screenshots/tablet-7', scenes: TABLET_SCENES },
  { id: 'tablet10', rawSubdir: 'tablet10', outDir: 'screenshots/tablet-10', scenes: TABLET_SCENES },
  {
    id: 'fold',
    outDir: 'screenshots/fold',
    scenes: [
      // Unfolded: reuse tablet10 landscape raws inside a fold bezel.
      { id: 'library-home', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'Unfold into\nyour whole library.' },
      { id: 'player', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'A full-cast performance,\nunfolded.' },
      { id: 'book-detail', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'Every chapter,\non the big screen.' },
      { id: 'library-offline', rawSubdir: 'tablet10', orientation: 'landscape', template: 'foldBezel',
        caption: 'Downloaded once.\nYours to hear offline.' },
      // Half-open seam: own capture; crease bisects library ∣ player.
      { id: 'library-home-seam', rawSubdir: 'fold', rawId: 'library-home', orientation: 'landscape',
        template: 'foldBezel', caption: 'Made for the\nhalf-open fold.' },
    ],
  },
);
