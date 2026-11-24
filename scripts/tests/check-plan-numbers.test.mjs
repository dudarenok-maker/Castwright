// Tests for scripts/check-plan-numbers.mjs - the docs/features plan-number
// duplicate checker (parent #4582; checker and tests land in child #4604).
// Cases (a)-(g) exercise the pure function against synthetic tracked-path
// lists (no network, no scratch repos); case (h) runs the real CLI against
// THIS repo once and expects the acceptance baseline: the branch tree is
// clean of any duplicate outside the frozen legacy allowlist, so the
// checker must exit 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  findPlanNumberProblems,
  extractPlanKey,
  listDocsFeaturesFiles,
  LEGACY_DUPLICATES,
} from '../check-plan-numbers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', 'check-plan-numbers.mjs');

// Every legacy-derived case pulls a REAL frozen entry out of the exported
// allowlist instead of hardcoding paths, so these tests survive the
// allowlist's own one-way tightening without going stale.
const LEGACY_ENTRY = Object.entries(LEGACY_DUPLICATES)[0];
const LEGACY_KEY = LEGACY_ENTRY[0];
const LEGACY_FILES = LEGACY_ENTRY[1];

test('(a) a clean set of tracked plan paths reports no problems', () => {
  const tracked = [
    'docs/features/294-node-loopback-crash-guard.md',
    'docs/features/295-chapter-take-lifecycle.md',
    'docs/features/archive/293-qwen-tier-keep-set.md',
  ];
  assert.deepEqual(findPlanNumberProblems(tracked, {}), []);
});

test('(b) a new duplicate fails with kind duplicate naming key 292 and both files', () => {
  const tracked = ['docs/features/292-a.md', 'docs/features/292-b.md'];
  const problems = findPlanNumberProblems(tracked, {});
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'duplicate');
  assert.equal(problems[0].key, '292');
  assert.deepEqual(problems[0].files, ['docs/features/292-a.md', 'docs/features/292-b.md']);
});

test('(c) an allowlisted legacy pair passes - scoped, and across the whole allowlist', () => {
  assert.deepEqual(
    findPlanNumberProblems([...LEGACY_FILES], { [LEGACY_KEY]: [...LEGACY_FILES] }),
    [],
  );
  const everyLegacyFile = Object.values(LEGACY_DUPLICATES).flat();
  assert.deepEqual(findPlanNumberProblems(everyLegacyFile, LEGACY_DUPLICATES), []);
});

test('(d) a third file joining a legacy number fails legacy-grew', () => {
  const thirdFile = `docs/features/${LEGACY_KEY}-third-arrival.md`;
  const problems = findPlanNumberProblems([...LEGACY_FILES, thirdFile], {
    [LEGACY_KEY]: [...LEGACY_FILES],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'legacy-grew');
  assert.equal(problems[0].key, LEGACY_KEY);
  assert.ok(problems[0].files.includes(thirdFile));
});

test('(e) a legacy entry whose file vanished fails legacy-stale', () => {
  const problems = findPlanNumberProblems([LEGACY_FILES[0]], {
    [LEGACY_KEY]: [...LEGACY_FILES],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'legacy-stale');
  assert.equal(problems[0].key, LEGACY_KEY);
});

const moveToArchive = (file) =>
  `docs/features/archive/${file.slice(file.lastIndexOf('/') + 1)}`;
const moveToTopLevel = (file) => `docs/features/${file.slice(file.lastIndexOf('/') + 1)}`;

test('(d2) archiving one legacy file, then both, is transparent (basename match)', () => {
  const frozen = { [LEGACY_KEY]: [...LEGACY_FILES] };
  const [first, second] = LEGACY_FILES;
  assert.deepEqual(findPlanNumberProblems([moveToArchive(first), second], frozen), []);
  assert.deepEqual(findPlanNumberProblems([moveToTopLevel(first), second], frozen), []);
  assert.deepEqual(
    findPlanNumberProblems([moveToArchive(first), moveToArchive(second)], frozen),
    [],
  );
});

test('(d3) a real third file still fails legacy-grew after a legacy file moved to archive/', () => {
  const thirdFile = `docs/features/${LEGACY_KEY}-third-arrival.md`;
  const problems = findPlanNumberProblems(
    [moveToArchive(LEGACY_FILES[0]), LEGACY_FILES[1], thirdFile],
    { [LEGACY_KEY]: [...LEGACY_FILES] },
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'legacy-grew');
});

test('(d4) a legacy basename present in two directories counts as a grown set', () => {
  const [first, second] = LEGACY_FILES;
  const problems = findPlanNumberProblems(
    [moveToArchive(first), moveToTopLevel(first), second],
    { [LEGACY_KEY]: [...LEGACY_FILES] },
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'legacy-grew');
});

test('(d5) a vanished legacy file after an archive move of the other is still legacy-stale', () => {
  const problems = findPlanNumberProblems([moveToArchive(LEGACY_FILES[0])], {
    [LEGACY_KEY]: [...LEGACY_FILES],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'legacy-stale');
});

test('(f) a .html twin, INDEX.md, TEMPLATE.md, README.md and unnumbered plans are ignored', () => {
  const tracked = [
    'docs/features/archive/277-v115-bug-chore-sweep-board.html',
    'docs/features/INDEX.md',
    'docs/features/TEMPLATE.md',
    'docs/features/README.md',
    'docs/features/companion-offline-waveform.md',
    'docs/features/fs-cross-device-finished-sync.md',
  ];
  assert.deepEqual(findPlanNumberProblems(tracked, {}), []);
});

test('(g) 70a-x.md and 70b-y.md are distinct keys, not a collision', () => {
  const tracked = ['docs/features/archive/70a-x.md', 'docs/features/archive/70b-y.md'];
  assert.equal(extractPlanKey(tracked[0]), '70a');
  assert.equal(extractPlanKey(tracked[1]), '70b');
  assert.deepEqual(findPlanNumberProblems(tracked, {}), []);
});

test('LEGACY_DUPLICATES invariants: frozen two-file POSIX sets keyed on basenames', () => {
  const entries = Object.entries(LEGACY_DUPLICATES);
  assert.ok(entries.length >= 1, 'the allowlist must hold the frozen legacy duplicates');
  for (const [key, files] of entries) {
    assert.match(key, /^\d+[a-z]?$/);
    assert.equal(files.length, 2, `key ${key}: frozen as exactly two files`);
    assert.deepEqual(files, [...files].sort(), `key ${key}: file set sorted`);
    for (const file of files) {
      assert.ok(!file.includes('\\'), `POSIX separators expected: ${file}`);
      assert.ok(file.startsWith('docs/features/'), `under docs/features: ${file}`);
      assert.ok(file.endsWith('.md'), `markdown only: ${file}`);
      assert.ok(
        file.slice(file.lastIndexOf('/') + 1).startsWith(`${key}-`),
        `key on basename: ${file}`,
      );
      assert.equal(extractPlanKey(file), key);
    }
  }
});

test('(h) the CLI run against THIS repo exits 0 with the OK line', () => {
  const result = spawnSync(process.execPath, [CLI_PATH], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: process.env,
  });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /check:plan-numbers: OK\./);
});


test('(i) a leading-zero number collides with its unpadded spelling', () => {
  assert.equal(extractPlanKey('docs/features/archive/07-audio-tag-vocabulary.md'), '7');
  assert.equal(extractPlanKey('docs/features/7-foo.md'), '7');
  assert.equal(extractPlanKey('docs/features/archive/00-zero.md'), '0');
  const problems = findPlanNumberProblems(
    ['docs/features/archive/07-audio-tag-vocabulary.md', 'docs/features/7-foo.md'],
    {},
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'duplicate');
  assert.equal(problems[0].key, '7');
});

test('(j) the .md extension is matched case-insensitively', () => {
  const problems = findPlanNumberProblems(
    ['docs/features/296-x.md', 'docs/features/296-y.MD'],
    {},
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'duplicate');
  assert.equal(problems[0].key, '296');
});

test('(k) the single-letter suffix is folded to lower case', () => {
  assert.equal(extractPlanKey('docs/features/296A-x.md'), '296a');
  const problems = findPlanNumberProblems(
    ['docs/features/296a-x.md', 'docs/features/296A-y.md'],
    {},
  );
  assert.equal(problems.length, 1);
  assert.equal(problems[0].kind, 'duplicate');
  assert.equal(problems[0].key, '296a');
});

test('(l) a non-ASCII basename is listed unquoted and still collides', () => {
  const repo = mkdtempSync(join(HERE, 'scratch-repo-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true });
    git('init', '-q');
    mkdirSync(join(repo, 'docs', 'features'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'features', '296-café.md'), 'x');
    writeFileSync(join(repo, 'docs', 'features', '296-plain.md'), 'y');
    git('add', '.');
    const tracked = listDocsFeaturesFiles(repo);
    assert.ok(tracked.includes('docs/features/296-café.md'), `listed: ${tracked.join('|')}`);
    const problems = findPlanNumberProblems(tracked, {});
    assert.equal(problems.length, 1);
    assert.equal(problems[0].kind, 'duplicate');
    assert.equal(problems[0].key, '296');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
