import { describe, it, expect } from 'vitest';
import { findPython311 } from './python-discovery.js';
const ok = (v: string) => ({ status: 0, stdout: `Python ${v}\n`, stderr: '' });
const fail = () => ({ status: 1, stdout: '', stderr: 'not found' });

describe('findPython311', () => {
  it('win32 prefers py -3.11', () => {
    const r = findPython311({ platform: 'win32', runFn: (c, a) => (c === 'py' && a[0] === '-3.11' ? ok('3.11.9') : fail()) });
    expect(r).toEqual({ cmd: 'py', args: ['-3.11'] });
  });
  it('posix falls back python3.11 → python3', () => {
    const r = findPython311({ platform: 'linux', runFn: (c) => (c === 'python3' ? ok('3.12.2') : fail()) });
    expect(r).toEqual({ cmd: 'python3', args: [] });
  });
  it('rejects too-old / too-new', () => {
    expect(findPython311({ platform: 'linux', runFn: () => ok('3.9.1') })).toBeNull();
    expect(findPython311({ platform: 'linux', runFn: () => ok('3.13.0') })).toBeNull();
  });
  it('null when nothing found', () => {
    expect(findPython311({ platform: 'win32', runFn: () => fail() })).toBeNull();
  });
  it('parses version from stderr', () => {
    const r = findPython311({ platform: 'linux', runFn: (c) => (c === 'python3.11' ? { status: 0, stdout: '', stderr: 'Python 3.11.0\n' } : fail()) });
    expect(r).toEqual({ cmd: 'python3.11', args: [] });
  });
});
