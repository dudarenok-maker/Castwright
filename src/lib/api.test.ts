import { describe, it, expect, beforeEach } from 'vitest';
import { mockGetSetupReadiness, mockCompleteSetup } from './api';

describe('mockGetSetupReadiness', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = '#/';
  });

  it('returns ready by default', async () => {
    const r = await mockGetSetupReadiness();
    expect(r.ready).toBe(true);
  });

  it('latches not-ready from the setup=notready param and persists it across nav', async () => {
    window.location.hash = '#/?setup=notready';
    const first = await mockGetSetupReadiness();
    expect(first.ready).toBe(false);
    expect(first.blockers.tts).toBe('fail');
    window.location.hash = '#/setup';
    const second = await mockGetSetupReadiness();
    expect(second.ready).toBe(false);
  });
});

describe('mockCompleteSetup', () => {
  it('resolves an ISO completedAt', async () => {
    const r = await mockCompleteSetup();
    expect(typeof r.completedAt).toBe('string');
    expect(new Date(r.completedAt).toISOString()).toBe(r.completedAt);
  });
});
