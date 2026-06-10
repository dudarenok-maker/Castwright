import { describe, it, expect } from 'vitest';
import { crockfordBase32 } from './crockford-base32.js';

describe('crockfordBase32', () => {
  it('encodes 10 bytes to 16 chars (80 bits / 5)', () => {
    const bytes = Buffer.from('00112233445566778899', 'hex');
    expect(crockfordBase32(bytes)).toHaveLength(16);
  });

  it('encodes 5 bytes to 8 chars (40 bits / 5)', () => {
    expect(crockfordBase32(Buffer.from('0000000000', 'hex'))).toBe('00000000');
  });

  it('uses the Crockford alphabet (no I L O U, upper-case)', () => {
    const out = crockfordBase32(Buffer.from('ffffffffff', 'hex'));
    expect(out).toBe('ZZZZZZZZ');
    expect(out).not.toMatch(/[ILOU]/);
  });

  it('is deterministic and stable for a known vector', () => {
    expect(crockfordBase32(Buffer.from('0102030405', 'hex'))).toBe('04106105');
  });
});
