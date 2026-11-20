import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findCrashRange,
  loadCrashRanges,
  loadNodeMinimum,
  nodeRuntimeRefusal,
  parseNodeVersion,
  type NodeCrashRange,
} from './node-runtime-guard.js';

const RANGES: NodeCrashRange[] = [
  { from: '0.0.0', toExclusive: '24.16.0' },
  { from: '25.0.0', toExclusive: '26.1.0' },
];
const MINIMUM = '24.16.0';

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
    ['0.0.0', 'from of range 1', true],
    ['20.19.5', 'Node 20 carries the bug', true],
    ['21.7.3', 'Node 21 carries the bug', true],
    ['22.0.0', 'Node 22', true],
    ['22.22.0', 'Node 22', true],
    ['22.23.5', 'last 22.x', true],
    ['23.0.0', 'first 23.x', true],
    ['23.11.1', 'last 23.x', true],
    ['24.0.0', '24.x below the fix', true],
    ['24.15.0', 'just below toExclusive of range 1', true],
    ['24.16.0', 'toExclusive of range 1', false],
    ['24.99.99', 'last good before range 2', false],
    ['25.0.0', 'from of range 2', true],
    ['25.9.0', 'last 25.x', true],
    ['26.0.0', 'just below toExclusive of range 2', true],
    ['26.1.0', 'toExclusive of range 2', false],
  ];
  it.each(cases)('v%s (%s) refused=%s', (version, _label, refused) => {
    expect(findCrashRange(`v${version}`, 'win32', RANGES) !== null).toBe(refused);
  });
});

describe('never refused', () => {
  it.each(['linux', 'darwin'])('%s is never refused', (platform) => {
    expect(findCrashRange('v24.15.0', platform, RANGES)).toBeNull();
    expect(nodeRuntimeRefusal('v22.22.0', platform, RANGES, MINIMUM)).toBeNull();
  });
  it('unparseable and empty versions are not refused', () => {
    expect(nodeRuntimeRefusal('', 'win32', RANGES, MINIMUM)).toBeNull();
    expect(nodeRuntimeRefusal('garbage', 'win32', RANGES, MINIMUM)).toBeNull();
  });
});

describe('nodeRuntimeRefusal message', () => {
  it('names the running version and the suggested version', () => {
    const msg = nodeRuntimeRefusal('v24.15.0', 'win32', RANGES, MINIMUM);
    expect(msg).toContain('v24.15.0');
    expect(msg).toContain('Install Node v24.16.0 or newer');
    expect(msg).toContain('libuv#5106');
  });
  it.each(['v20.19.5', 'v22.22.0', 'v23.0.0', 'v23.11.1', 'v25.9.0', 'v26.0.0'])(
    '%s is told to install the one minimum that works, not a range bound',
    (version) => {
      const msg = nodeRuntimeRefusal(version, 'win32', RANGES, MINIMUM);
      expect(msg).toContain('Install Node v24.16.0 or newer');
      expect(msg).not.toContain('v23.0.0 or newer');
      expect(msg).not.toContain('v26.1.0 or newer');
    },
  );
});

describe('nodeRuntimeRefusal under a Pinokio conda env', () => {
  const PREFIX = 'C:\\pinokio\\api\\castwright\\env';
  const inEnv = { CONDA_PREFIX: PREFIX };
  it('tells a conda-env Node to run Update again, not to install from nodejs.org', () => {
    const msg = nodeRuntimeRefusal('v24.14.1', 'win32', RANGES, MINIMUM, inEnv, `${PREFIX}\\node.exe`);
    expect(msg).toContain('v24.14.1');
    expect(msg).toContain('Update');
    expect(msg).toContain('v24.16.0');
    expect(msg).toContain('libuv#5106');
    expect(msg).not.toContain('nodejs.org');
  });
  it('matches the prefix case-insensitively and across slash styles', () => {
    const msg = nodeRuntimeRefusal(
      'v24.14.1', 'win32', RANGES, MINIMUM,
      { CONDA_PREFIX: 'c:/Pinokio/api/castwright/env/' },
      'C:\\pinokio\\api\\castwright\\env\\node.exe',
    );
    expect(msg).toContain('Update');
  });
  it('keeps the nodejs.org advice when the Node is outside the conda env', () => {
    const msg = nodeRuntimeRefusal('v24.14.1', 'win32', RANGES, MINIMUM, inEnv, 'C:\\Program Files\\nodejs\\node.exe');
    expect(msg).toContain('https://nodejs.org');
    expect(msg).not.toContain('Update');
  });
  it('keeps the nodejs.org advice when CONDA_PREFIX is unset or empty', () => {
    expect(nodeRuntimeRefusal('v24.14.1', 'win32', RANGES, MINIMUM, {}, `${PREFIX}\\node.exe`)).toContain('nodejs.org');
    expect(nodeRuntimeRefusal('v24.14.1', 'win32', RANGES, MINIMUM, { CONDA_PREFIX: '' }, `${PREFIX}\\node.exe`)).toContain('nodejs.org');
  });
  it('a sibling directory sharing the prefix text is not inside the env', () => {
    const msg = nodeRuntimeRefusal('v24.14.1', 'win32', RANGES, MINIMUM, inEnv, `${PREFIX}-old\\node.exe`);
    expect(msg).toContain('nodejs.org');
  });
});

describe('loadNodeMinimum', () => {
  it('derives the minimum from the real package.json engines floor', () => {
    expect(loadNodeMinimum()).toBe('24.16.0');
  });
  it('every real range is refused with advice that is itself allowed', () => {
    const ranges = loadCrashRanges();
    const min = loadNodeMinimum();
    expect(findCrashRange(`v${min}`, 'win32', ranges)).toBeNull();
    for (const v of ['20.19.5', '21.7.3', '22.22.0', '23.11.1', '25.9.0']) {
      const msg = nodeRuntimeRefusal(`v${v}`, 'win32', ranges, min);
      expect(msg).toContain(`Install Node v${min} or newer`);
    }
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
