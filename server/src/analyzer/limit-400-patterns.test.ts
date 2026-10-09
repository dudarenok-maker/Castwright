import { describe, it, expect } from 'vitest';
import { LIMIT_400_PATTERNS, namesContextOrTokenLimit } from './limit-400-patterns.js';

describe('LIMIT_400_PATTERNS (#3084 P7, P24)', () => {
  it.each(LIMIT_400_PATTERNS)('matches its own quoted example ($provider)', (row) => {
    expect(row.pattern.test(row.example)).toBe(true);
    expect(namesContextOrTokenLimit(row.example)).toBe(true);
  });
  it('does not match a structured-output rejection', () => {
    expect(namesContextOrTokenLimit("'response_format.type' must be 'json_schema' or 'text'")).toBe(false);
    expect(namesContextOrTokenLimit('Invalid JSON payload received. Unknown name "minLength"')).toBe(false);
  });
});
