import type { CharColor } from './types';

export interface CharColorEntry { hex: string; tint: string; ring: string; }

export const CHAR_COLORS: Record<CharColor, CharColorEntry> = {
  narrator: { hex: '#6B6663', tint: 'rgba(107,102,99,0.08)',  ring: 'rgba(107,102,99,0.30)'  },
  halloran: { hex: '#F79A83', tint: 'rgba(247,154,131,0.12)', ring: 'rgba(247,154,131,0.45)' },
  eliza:    { hex: '#A43C6C', tint: 'rgba(164,60,108,0.10)',  ring: 'rgba(164,60,108,0.40)'  },
  marcus:   { hex: '#7C5C8C', tint: 'rgba(124,92,140,0.10)',  ring: 'rgba(124,92,140,0.40)'  },
};

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
