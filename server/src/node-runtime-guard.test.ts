import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findCrashRange,
  loadCrashRanges,
  nodeRuntimeRefusal,
  parseNodeVersion,
  type NodeCrashRange,
} from './node-runtime-guard.js';

const RANGES: NodeCrashRange[] = [
  { from: '22.0.0', toExclusive: '23.0.0' },
  { from: '24.0.0', toExclusive: '24.16.0' },
  { from: '25.0.0', toExclusive: '26.1.0' },
];

describe('parseNodeVersion', () => {
  it('parses with and without the v prefix', () => {
    expect(parseNodeVersion('v24.15.0')).toEqual([24, 15, 0]);
    expect(parseNodeVersion('24.15.0')).toEqual([24, 15, 0]);
  });
  it.each(['', 'abc', '24.15', 'v24.15.0-nightly'])('returns null for %j', (v) => {
    expect(parseNodeVersion(v)).toBeNull();
  });
});

describe('findCrashRange boundaries (win32)', () => {
  const cases: Array<[string, string, boolean]> = [
    ['21.9.9', 'below first range', false],
    ['22.0.0', 'from of range 1', true],
    ['22.99.99', 'just below toExclusive of range 1', true],
    ['23.0.0', 'toExclusive of range 1', false],
    ['23.99.99', 'last good before range 2', false],
    ['24.0.0', 'from of range 2', true],
    ['24.15.0', 'just below toExclusive of range 2', true],
    ['24.16.0', 'toExclusive of range 2', false],
    ['24.99.99', 'last good before range 3', false],
    ['25.0.0', 'from of range 3', true],
    ['26.0.0', 'just below toExclusive of range 3', true],
    ['26.1.0', 'toExclusive of range 3', false],
  ];
  it.each(cases)('v%s (%s) refused=%s', (version, _label, refused) => {
    expect(findCrashRange(`v${version}`, 'win32', RANGES) !== null).toBe(refused);
  });
});

describe('never refused', () => {
  it.each(['linux', 'darwin'])('%s is never refused', (platform) => {
    expect(findCrashRange('v24.15.0', platform, RANGES)).toBeNull();
    expect(nodeRuntimeRefusal('v22.22.0', platform, RANGES)).toBeNull();
  });
  it('unparseable and empty versions are not refused', () => {
    expect(nodeRuntimeRefusal('', 'win32', RANGES)).toBeNull();
    expect(nodeRuntimeRefusal('garbage', 'win32', RANGES)).toBeNull();
  });
});

describe('nodeRuntimeRefusal message', () => {
  it('names the running version and the suggested version', () => {
    const msg = nodeRuntimeRefusal('v24.15.0', 'win32', RANGES);
    expect(msg).toContain('v24.15.0');
    expect(msg).toContain('v24.16.0');
    expect(msg).toContain('libuv#5106');
  });
});

describe('loadCrashRanges', () => {
  it('reads a non-empty list from the real package.json', () => {
    const ranges = loadCrashRanges();
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every((r) => parseNodeVersion(r.from) && parseNodeVersion(r.toExclusive))).toBe(true);
  });
});

describe('index.ts import order', () => {
  it('imports the guard boot module first', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const first = readFileSync(join(here, 'index.ts'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('import'));
    expect(first).toBe("import './node-runtime-guard-boot.js';");
  });
});
