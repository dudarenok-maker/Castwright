import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeSecureUuid } from './secure-random';

describe('makeSecureUuid — CodeQL js/insecure-randomness guard', () => {
  let originalCrypto: Crypto | undefined;

  beforeEach(() => {
    originalCrypto = globalThis.crypto;
  });

  afterEach(() => {
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      });
    }
  });

  it('uses crypto.randomUUID when available', () => {
    expect(makeSecureUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('falls back to crypto.getRandomValues when randomUUID throws', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: vi.fn(() => {
          throw new TypeError('randomUUID is only available in secure context');
        }),
        getRandomValues: (buf: Uint8Array) => {
          for (let i = 0; i < buf.length; i++) {
            buf[i] = Math.floor(Math.random() * 256);
          }
          return buf;
        },
      },
      configurable: true,
    });

    const id = makeSecureUuid();
    expect(id).toBeTruthy();
    expect(id.length).toBe(16); // 8 bytes * 2 hex chars
    expect(id).toMatch(/^[0-9a-f]+$/i);
  });

  it('falls back to Date.now when crypto.randomUUID is unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: undefined,
        getRandomValues: undefined,
      },
      configurable: true,
    });

    const id = makeSecureUuid();
    expect(id).toBeTruthy();
    // Should be a base36 timestamp, all lowercase alphanumeric
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it('falls back to Date.now when crypto is undefined', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const id = makeSecureUuid();
    expect(id).toBeTruthy();
    // Should be a base36 timestamp, all lowercase alphanumeric
    expect(id).toMatch(/^[0-9a-z]+$/);
  });

  it('falls back to Date.now when getRandomValues throws', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: undefined,
        getRandomValues: vi.fn(() => {
          throw new Error('getRandomValues failed');
        }),
      },
      configurable: true,
    });

    const id = makeSecureUuid();
    expect(id).toBeTruthy();
    // Should be a base36 timestamp, all lowercase alphanumeric
    expect(id).toMatch(/^[0-9a-z]+$/);
  });
});
