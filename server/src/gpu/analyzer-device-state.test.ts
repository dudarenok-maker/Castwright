import { describe, it, expect, beforeEach } from 'vitest';
import { setLastKnownAnalyzerDevice, getLastKnownAnalyzerDevice } from './analyzer-device-state.js';

describe('analyzer-device-state', () => {
  beforeEach(() => setLastKnownAnalyzerDevice('unknown'));

  it('defaults to unknown', () => {
    expect(getLastKnownAnalyzerDevice()).toBe('unknown');
  });

  it('remembers the last set value', () => {
    setLastKnownAnalyzerDevice('cuda');
    expect(getLastKnownAnalyzerDevice()).toBe('cuda');
    setLastKnownAnalyzerDevice('cpu');
    expect(getLastKnownAnalyzerDevice()).toBe('cpu');
  });
});
