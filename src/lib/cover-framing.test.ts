import { describe, expect, it } from 'vitest';
import { clampFraming, computeCoverStyle, DEFAULT_FRAMING } from './cover-framing';

describe('computeCoverStyle', () => {
  it('returns {} when framing is undefined', () => {
    expect(computeCoverStyle(undefined)).toEqual({});
  });

  it('returns {} when framing is null', () => {
    expect(computeCoverStyle(null)).toEqual({});
  });

  it('emits objectPosition without transform for default framing', () => {
    expect(computeCoverStyle(DEFAULT_FRAMING)).toEqual({ objectPosition: '50% 50%' });
  });

  it('maps negative offsetX to the left edge', () => {
    expect(computeCoverStyle({ offsetX: -100, offsetY: 0, zoom: 1 })).toEqual({
      objectPosition: '0% 50%',
    });
  });

  it('maps positive offsetX to the right edge', () => {
    expect(computeCoverStyle({ offsetX: 100, offsetY: 0, zoom: 1 })).toEqual({
      objectPosition: '100% 50%',
    });
  });

  it('maps negative offsetY to the top edge', () => {
    expect(computeCoverStyle({ offsetX: 0, offsetY: -100, zoom: 1 })).toEqual({
      objectPosition: '50% 0%',
    });
  });

  it('maps positive offsetY to the bottom edge', () => {
    expect(computeCoverStyle({ offsetX: 0, offsetY: 100, zoom: 1 })).toEqual({
      objectPosition: '50% 100%',
    });
  });

  it('adds transform when zoom > 1', () => {
    expect(computeCoverStyle({ offsetX: 0, offsetY: 0, zoom: 1.5 })).toEqual({
      objectPosition: '50% 50%',
      transform: 'scale(1.5)',
    });
  });

  it('omits transform when zoom is exactly 1', () => {
    const style = computeCoverStyle({ offsetX: 0, offsetY: 0, zoom: 1 });
    expect(style).toEqual({ objectPosition: '50% 50%' });
    expect(style.transform).toBeUndefined();
  });

  it('clamps out-of-range offsets and zoom', () => {
    expect(computeCoverStyle({ offsetX: 200, offsetY: -200, zoom: 5 })).toEqual({
      objectPosition: '100% 0%',
      transform: 'scale(3)',
    });
  });

  it('clamps zoom below 1 back to 1 (no transform emitted)', () => {
    const style = computeCoverStyle({ offsetX: 0, offsetY: 0, zoom: 0.5 });
    expect(style).toEqual({ objectPosition: '50% 50%' });
    expect(style.transform).toBeUndefined();
  });
});

describe('clampFraming', () => {
  it('passes through valid values', () => {
    expect(clampFraming({ offsetX: 50, offsetY: -30, zoom: 2 })).toEqual({
      offsetX: 50,
      offsetY: -30,
      zoom: 2,
    });
  });

  it('clamps boundary values', () => {
    expect(clampFraming({ offsetX: 200, offsetY: -200, zoom: 5 })).toEqual({
      offsetX: 100,
      offsetY: -100,
      zoom: 3,
    });
  });

  it('clamps zoom below 1 back to 1', () => {
    expect(clampFraming({ offsetX: 0, offsetY: 0, zoom: 0.5 }).zoom).toBe(1);
  });
});

describe('DEFAULT_FRAMING', () => {
  it('is the reset target: centred offsets, zoom 1', () => {
    expect(DEFAULT_FRAMING).toEqual({ offsetX: 0, offsetY: 0, zoom: 1 });
  });
});
