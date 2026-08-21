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

  it('generates different values on successive calls', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const result1 = makeSecureRandom(alphabet, 12);
    const result2 = makeSecureRandom(alphabet, 12);
    /* Two random strings should differ — collision probability is negligible
       for 12-char base32. */
    expect(result1).not.toBe(result2);
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
