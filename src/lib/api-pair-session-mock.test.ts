import { describe, it, expect } from 'vitest';
import { mockCreatePairSession } from './api';

// app-17: the pairing mock must emit the verified deep-link URL (mock mode drives
// the modal in dev / e2e / marketing screenshots), not the retired CWP1 string.
describe('mockCreatePairSession qrPayload', () => {
  it('is the verified www.castwright.ai deep-link URL carrying h/c/f', async () => {
    const info = await mockCreatePairSession();
    const url = new URL(info.qrPayload);
    expect(url.origin + url.pathname).toBe('https://www.castwright.ai/pair');
    expect(url.searchParams.get('h')).toBe(info.hostPort);
    expect(url.searchParams.get('c')).toBe(info.code);
    expect(url.searchParams.get('f')).toBe(info.fpTag);
  });
});
