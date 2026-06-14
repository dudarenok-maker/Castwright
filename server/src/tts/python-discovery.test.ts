import { describe, it, expect } from 'vitest';
import { findPython312 } from './python-discovery.js';
const ok = (v: string) => ({ status: 0, stdout: `Python ${v}\n`, stderr: '' });
const fail = () => ({ status: 1, stdout: '', stderr: 'not found' });

describe('findPython312', () => {
  it('win32 prefers py -3.12', () => {
    const r = findPython312({ platform: 'win32', runFn: (c, a) => (c === 'py' && a[0] === '-3.12' ? ok('3.12.4') : fail()) });
    expect(r).toEqual({ cmd: 'py', args: ['-3.12'] });
  });
  it('win32 falls back to bare python when it reports 3.12', () => {
    const r = findPython312({ platform: 'win32', runFn: (c, a) => (c === 'python' && a.length === 0 ? ok('3.12.4') : fail()) });
    expect(r).toEqual({ cmd: 'python', args: [] });
  });
  it('posix prefers python3.12 then python3', () => {
    const r = findPython312({ platform: 'linux', runFn: (c) => (c === 'python3' ? ok('3.12.2') : fail()) });
    expect(r).toEqual({ cmd: 'python3', args: [] });
  });
  it('rejects 3.11 and 3.13 — ONLY 3.12 is accepted', () => {
    expect(findPython312({ platform: 'linux', runFn: () => ok('3.11.9') })).toBeNull();
    expect(findPython312({ platform: 'linux', runFn: () => ok('3.13.0') })).toBeNull();
    expect(findPython312({ platform: 'linux', runFn: () => ok('3.10.0') })).toBeNull();
  });
  it('accepts exactly 3.12', () => {
    expect(findPython312({ platform: 'linux', runFn: () => ok('3.12.0') })).toEqual({ cmd: 'python3.12', args: [] });
  });
  it('null when nothing found', () => {
    expect(findPython312({ platform: 'win32', runFn: () => fail() })).toBeNull();
  });
  it('parses version from stderr', () => {
    const r = findPython312({ platform: 'linux', runFn: (c) => (c === 'python3.12' ? { status: 0, stdout: '', stderr: 'Python 3.12.0\n' } : fail()) });
    expect(r).toEqual({ cmd: 'python3.12', args: [] });
  });
});
