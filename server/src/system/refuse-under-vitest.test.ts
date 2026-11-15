import { describe, it, expect, vi } from 'vitest';
import { refuseUnderVitest } from './refuse-under-vitest.js';

describe('refuseUnderVitest', () => {
  it('H1: under vitest the wrapper throws exactly the message and never calls real', () => {
    const real = vi.fn(() => 'ran');
    const wrapped = refuseUnderVitest(real, 'refused (#3712)');
    expect(() => wrapped()).toThrow(new Error('refused (#3712)'));
    expect(real).toHaveBeenCalledTimes(0);
  });

  it('H2: VITEST is read at call time; when unset the real fn runs with the same args', () => {
    const real = vi.fn((a: number, b: string) => `${a}${b}`);
    const wrapped = refuseUnderVitest(real, 'refused');
    const prev = process.env.VITEST;
    process.env.VITEST = '';
    try {
      expect(wrapped(1, 'x')).toBe('1x');
      expect(real).toHaveBeenCalledTimes(1);
      expect(real).toHaveBeenCalledWith(1, 'x');
    } finally {
      if (prev === undefined) delete process.env.VITEST;
      else process.env.VITEST = prev;
    }
  });
});
