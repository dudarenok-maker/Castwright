import { describe, it, expect } from 'vitest';
import { redactKnownSecrets, REDACTED } from './redact.js';

describe('redactKnownSecrets (#3084 PR 3b)', () => {
  it('replaces every occurrence of each secret, longest first', () => {
    const out = redactKnownSecrets('key sk-abcdefgh1234 and again sk-abcdefgh1234; prefix sk-abcdefgh', [
      'sk-abcdefgh',
      'sk-abcdefgh1234',
    ]);
    expect(out).toBe(`key ${REDACTED} and again ${REDACTED}; prefix ${REDACTED}`);
  });
  it('ignores secrets shorter than 8 characters and empty/null entries', () => {
    expect(redactKnownSecrets('json mode rejected', ['json', '', null, undefined])).toBe('json mode rejected');
  });
  it('also redacts the JSON-escaped spelling of a key with a quote or backslash', () => {
    for (const key of ['sk-abc"defgh12345', 'sk-abc\\defgh12345']) {
      const escaped = JSON.stringify({ message: `invalid key ${key} supplied` });
      const out = redactKnownSecrets(escaped, [key]);
      expect(out).not.toContain('defgh12345');
      expect(out).toBe(JSON.stringify({ message: `invalid key ${REDACTED} supplied` }));
    }
  });
  it('leaves text byte-identical when no secret is present', () => {
    expect(redactKnownSecrets('{"a":"x\\"y"}', ['sk-abc"defgh12345'])).toBe('{"a":"x\\"y"}');
  });
});
