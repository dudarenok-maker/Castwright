import type { CharColor } from './types';

export interface CharColorEntry { hex: string; tint: string; ring: string; }

/* The frontend palette. `narrator` is the gray slot reserved for narrative
   prose. The next three (`halloran`, `eliza`, `marcus`) are kept by name
   because fixture data in src/data/* refers to them. `slot-4`..`slot-30`
   are generated procedurally — together with the three named slots they
   give the analysis backend 30 distinct character colours before any
   cycling occurs (see server/src/routes/analysis.ts assignPaletteColors). */

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

function entry(hex: string): CharColorEntry {
  return { hex, tint: hexToRgba(hex, 0.10), ring: hexToRgba(hex, 0.40) };
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const v = lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(v * 255);
  };
  const r = f(0), g = f(8), b = f(4);
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/* Procedural slot-4..slot-30: 27 evenly-spaced hues around the wheel, with
   alternating saturation and lightness so adjacent slots feel distinct. */
function generateSlots(): Record<string, CharColorEntry> {
  const out: Record<string, CharColorEntry> = {};
  const count = 27;
  for (let i = 0; i < count; i++) {
    const hue = (i * (360 / count) + 40) % 360;
    const sat = 50 + (i % 3) * 8;            // 50 / 58 / 66
    const light = 48 + ((i + 1) % 3) * 6;    // 48 / 54 / 60
    out[`slot-${i + 4}`] = entry(hslToHex(hue, sat, light));
  }
  return out;
}

export const CHAR_COLORS: Record<string, CharColorEntry> = {
  narrator: entry('#6B6663'),
  halloran: entry('#F79A83'),
  eliza:    entry('#A43C6C'),
  marcus:   entry('#7C5C8C'),
  ...generateSlots(),
};

/* Stable ordered list of the 30 *character* slot names (excludes narrator).
   The server picks slot names from this order to colour characters in
   roster order; the array is kept in sync with CHAR_COLORS above. Exported
   for tests/tooling — not used by the runtime UI. */
export const CHARACTER_SLOTS: readonly string[] = [
  'halloran', 'eliza', 'marcus',
  ...Array.from({ length: 27 }, (_, i) => `slot-${i + 4}`),
];

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  let r = (n >> 16) + amt;
  let g = ((n >> 8) & 0xff) + amt;
  let b = (n & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

/* CharColor is widened to string for runtime flexibility (procedural slot
   names can't be a finite TS union usefully), but the named constants
   above remain the canonical entries. Re-export the alias so callers don't
   need to import from lib/types directly. */
export type { CharColor };
