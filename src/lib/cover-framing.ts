/* Pan + zoom framing applied at render time to the on-disk cover JPEG.
   Pure metadata — `<bookDir>/.audiobook/cover.jpg` is never re-encoded,
   so the export pipeline's `covr` / `APIC` frames stay correct.

   Mapping: offset∈[-100,100] maps linearly to object-position 0%–100%
   with 0 → 50% (centred). Plan
   [40](docs/features/40-cover-framing-and-upload.md). */

import type { CSSProperties } from 'react';
import type { components } from './api-types';

export type CoverFraming = components['schemas']['CoverFraming'];

export const DEFAULT_FRAMING: CoverFraming = { offsetX: 0, offsetY: 0, zoom: 1 };

export function clampFraming(framing: CoverFraming): CoverFraming {
  return {
    offsetX: clamp(framing.offsetX, -100, 100),
    offsetY: clamp(framing.offsetY, -100, 100),
    zoom: clamp(framing.zoom, 1, 3),
  };
}

export function computeCoverStyle(framing?: CoverFraming | null): CSSProperties {
  if (!framing) return {};
  const { offsetX, offsetY, zoom } = clampFraming(framing);
  const style: CSSProperties = {
    objectPosition: `${50 + offsetX / 2}% ${50 + offsetY / 2}%`,
  };
  if (zoom > 1) style.transform = `scale(${zoom})`;
  return style;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
