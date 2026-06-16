import { describe, it, expect, beforeEach } from 'vitest';
import { setLastKnownVram, getLastKnownVram } from './vram-state.js';

describe('last-known VRAM cache', () => {
  beforeEach(() => setLastKnownVram(null)); // reset to "never probed"

  it('defaults to unknown / null before any probe', () => {
    expect(getLastKnownVram()).toEqual({ accelerator: 'unknown', totalMb: null });
  });
  it('records a CUDA total as accelerator cuda', () => {
    setLastKnownVram({ totalMb: 8188 });
    expect(getLastKnownVram()).toEqual({ accelerator: 'cuda', totalMb: 8188 });
  });
  it('records a reachable-but-no-CUDA probe as cpu', () => {
    setLastKnownVram({ totalMb: null });
    expect(getLastKnownVram()).toEqual({ accelerator: 'cpu', totalMb: null });
  });
  it('an unreachable poll (undefined) leaves the last-known state intact', () => {
    setLastKnownVram({ totalMb: 8188 });
    setLastKnownVram(undefined);
    expect(getLastKnownVram()).toEqual({ accelerator: 'cuda', totalMb: 8188 });
  });
});
