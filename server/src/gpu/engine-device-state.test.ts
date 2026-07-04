import { describe, it, expect, beforeEach } from 'vitest';
import {
  setLastKnownEngineDevices,
  getLastKnownEngineDevice,
  _resetEngineDevicesForTests,
} from './engine-device-state.js';

describe('engine-device-state', () => {
  beforeEach(() => _resetEngineDevicesForTests());

  it('defaults every tracked engine to unknown', () => {
    expect(getLastKnownEngineDevice('kokoro')).toBe('unknown');
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
    expect(getLastKnownEngineDevice('qwen')).toBe('unknown');
  });

  it('returns unknown for an engine outside {kokoro, coqui, qwen}', () => {
    expect(getLastKnownEngineDevice('gemini')).toBe('unknown');
  });

  it('records a reachable devices map per engine', () => {
    setLastKnownEngineDevices({ kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' });
    expect(getLastKnownEngineDevice('kokoro')).toBe('cpu');
    expect(getLastKnownEngineDevice('coqui')).toBe('cpu');
    expect(getLastKnownEngineDevice('qwen')).toBe('mps');
  });

  it('maps a null per-engine slot to unknown', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: null, qwen: 'cuda' });
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
  });

  it('a null devices map (old sidecar / malformed body) resets every engine to unknown', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    setLastKnownEngineDevices(null);
    expect(getLastKnownEngineDevice('kokoro')).toBe('unknown');
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
    expect(getLastKnownEngineDevice('qwen')).toBe('unknown');
  });

  it('an unreachable poll (undefined) leaves the last-known state intact', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    setLastKnownEngineDevices(undefined);
    expect(getLastKnownEngineDevice('kokoro')).toBe('cuda');
  });
});
