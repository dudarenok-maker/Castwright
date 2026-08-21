import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeSecureUuid, makeSecureRandom } from './secure-random';

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
    const uuid = makeSecureUuid();
    /* crypto.randomUUID returns a UUID v4 string: 8-4-4-4-12 hex digits */
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('primary path generates distinct UUIDs across many rapid calls', () => {
    const uuids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      uuids.add(makeSecureUuid());
    }
    /* All 100 calls should produce distinct values */
    expect(uuids.size).toBe(100);
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
    /* getRandomValues fallback returns UUID-like format: 8-4-4-4-12 hex */
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('getRandomValues fallback generates distinct UUIDs across many rapid calls', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: vi.fn(() => {
          throw new TypeError('randomUUID unavailable');
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

    const uuids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      uuids.add(makeSecureUuid());
    }
    expect(uuids.size).toBe(100);
  });

  it('falls back to Date.now+counter when crypto is unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const id = makeSecureUuid();
    expect(id).toBeTruthy();
    /* Fallback returns UUID-like format: 8-4-4-4-12 hex digits */
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('final fallback generates DISTINCT values across 1000 rapid calls', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const uuids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      uuids.add(makeSecureUuid());
    }
    /* All 1000 rapid calls should produce distinct values (previously failed: got 1) */
    expect(uuids.size).toBe(1000);
  });

  it('final fallback generates distinct UUIDs when getRandomValues throws', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        randomUUID: undefined,
        getRandomValues: vi.fn(() => {
          throw new Error('getRandomValues failed');
        }),
      },
      configurable: true,
    });

    const uuids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      uuids.add(makeSecureUuid());
    }
    expect(uuids.size).toBe(1000);
  });
});

describe('makeSecureRandom — CodeQL js/insecure-randomness guard for custom alphabets', () => {
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

  it('generates a string of the requested length', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const result = makeSecureRandom(alphabet, 12);
    expect(result.length).toBe(12);
  });

  it('uses only characters from the provided alphabet', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const result = makeSecureRandom(alphabet, 100);
    for (const char of result) {
      expect(alphabet).toContain(char);
    }
  });

  it('generates different values on successive calls (primary path)', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const result1 = makeSecureRandom(alphabet, 12);
    const result2 = makeSecureRandom(alphabet, 12);
    /* Two random strings should differ — collision probability is negligible
       for 12-char base32. */
    expect(result1).not.toBe(result2);
  });

  it('primary path generates distinct strings across many rapid calls', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slugs = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      slugs.add(makeSecureRandom(alphabet, 12));
    }
    expect(slugs.size).toBe(100);
  });

  it('handles short lengths', () => {
    const alphabet = 'ABC';
    const result = makeSecureRandom(alphabet, 1);
    expect(result.length).toBe(1);
    expect(alphabet).toContain(result);
  });

  it('falls back gracefully when crypto.getRandomValues is unavailable', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const result = makeSecureRandom(alphabet, 12);
    expect(result.length).toBe(12);
    for (const char of result) {
      expect(alphabet).toContain(char);
    }
  });

  it('fallback generates distinct strings across 1000 rapid calls', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slugs = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      slugs.add(makeSecureRandom(alphabet, 12));
    }
    /* All 1000 rapid calls should produce distinct values (previously failed: got ~2) */
    expect(slugs.size).toBe(1000);
  });

  it('falls back when getRandomValues throws', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: vi.fn(() => {
          throw new Error('getRandomValues failed');
        }),
      },
      configurable: true,
    });

    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const result = makeSecureRandom(alphabet, 12);
    expect(result.length).toBe(12);
    for (const char of result) {
      expect(alphabet).toContain(char);
    }
  });

  it('fallback generates distinct strings when getRandomValues throws', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: vi.fn(() => {
          throw new Error('getRandomValues failed');
        }),
      },
      configurable: true,
    });

    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slugs = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      slugs.add(makeSecureRandom(alphabet, 12));
    }
    expect(slugs.size).toBe(1000);
  });

  it('works with binary alphabet', () => {
    const alphabet = '01';
    const result = makeSecureRandom(alphabet, 8);
    expect(result.length).toBe(8);
    expect(/^[01]{8}$/.test(result)).toBe(true);
  });

  it('works with hex alphabet', () => {
    const alphabet = '0123456789abcdef';
    const result = makeSecureRandom(alphabet, 16);
    expect(result.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(result)).toBe(true);
  });

  it('produces Crockford base32 slugs that match the server pattern', () => {
    /* Server uses the same alphabet for share slugs. This tests that the
       mock can generate valid slugs. */
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slug = makeSecureRandom(alphabet, 12);
    expect(slug).toMatch(/^[0-9A-Z]{12}$/);
    /* Verify it's a valid share slug by checking the standard pattern */
    expect(/^[0-9A-Z]{12}$/.test(slug)).toBe(true);
  });
});
