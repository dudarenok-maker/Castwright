// Pins .github/dependabot.yml (ops-60, #2433, folded #2791 review findings)
// against regressions nobody else would catch:
//  - the file stays valid YAML, version: 2, with exactly the three intended
//    `updates:` entries;
//  - EVERY composite action actually on disk under .github/actions/ has its
//    directory listed in the github-actions entry's `directories:` -- this
//    is the important one. #2791 replaced a `/.github/actions/*` glob (whose
//    behavior for this ecosystem is undocumented -- see the dependabot.yml
//    header comment and dependabot-core#10884) with explicit paths, which
//    means a newly added composite action gets silently un-bumped unless
//    someone remembers to add a line here. This test derives the expected
//    set from the filesystem, not from a hardcoded list, so it stays true
//    as the repo grows;
//  - each entry's commit-message.prefix produces a subject the repo's own
//    scripts/validate-commit-msg.mjs accepts, and no entry sets
//    `include: scope` -- that combination is exactly what reintroduced the
//    "chore(deps-dev)" pr-title-lint failure the header comment describes;
//  - each ecosystem carries both a version-updates and a security-updates
//    group, per the #2424 security-sweep rationale in the header comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateCommitSubject } from '../validate-commit-msg.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = resolve(repoRoot, '.github', 'dependabot.yml');
const actionsDir = resolve(repoRoot, '.github', 'actions');

function loadConfig() {
  return yaml.load(readFileSync(configPath, 'utf8'));
}

// The set of composite-action directories actually on disk, as
// dependabot.yml directory strings (e.g. '/.github/actions/setup').
function actionsOnDisk() {
  return readdirSync(actionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter(
      (entry) =>
        existsSync(join(actionsDir, entry.name, 'action.yml')) ||
        existsSync(join(actionsDir, entry.name, 'action.yaml')),
    )
    .map((entry) => `/.github/actions/${entry.name}`)
    .sort();
}

test('dependabot.yml parses as YAML with version: 2', () => {
  const config = loadConfig();
  assert.equal(config.version, 2);
});

test('dependabot.yml has exactly three updates entries with the expected ecosystem/directory pairs', () => {
  const config = loadConfig();
  assert.ok(Array.isArray(config.updates), 'expected an `updates:` array');
  assert.equal(config.updates.length, 3, 'expected exactly three updates entries');

  const [rootNpm, serverNpm, actions] = config.updates;

  assert.equal(rootNpm['package-ecosystem'], 'npm');
  assert.equal(rootNpm.directory, '/');

  assert.equal(serverNpm['package-ecosystem'], 'npm');
  assert.equal(serverNpm.directory, '/server');

  assert.equal(actions['package-ecosystem'], 'github-actions');
  assert.ok(
    Array.isArray(actions.directories),
    'expected the github-actions entry to use `directories:` (plural)',
  );
  assert.ok(
    actions.directories.includes('/'),
    'github-actions `directories:` must still include the root "/" (covers .github/workflows)',
  );
});

test('every composite action on disk is covered by the github-actions directories list', () => {
  const config = loadConfig();
  const actionsEntry = config.updates.find((u) => u['package-ecosystem'] === 'github-actions');
  assert.ok(actionsEntry, 'no github-actions entry found in dependabot.yml');

  const onDisk = actionsOnDisk();
  assert.ok(onDisk.length > 0, 'expected at least one composite action on disk to test against');

  const listed = new Set(actionsEntry.directories);
  for (const dir of onDisk) {
    assert.ok(
      listed.has(dir),
      `composite action directory ${dir} is on disk but missing from dependabot.yml's ` +
        `github-actions \`directories:\` list -- it will not receive Dependabot bumps`,
    );
  }
});

test("every entry's commit-message prefix produces a subject the commit-msg validator accepts, with no `include: scope`", () => {
  const config = loadConfig();
  for (const entry of config.updates) {
    const commitMessage = entry['commit-message'];
    assert.ok(
      commitMessage && typeof commitMessage.prefix === 'string',
      `entry ${entry['package-ecosystem']} (${entry.directory ?? entry.directories}) is missing commit-message.prefix`,
    );
    assert.equal(
      commitMessage.include,
      undefined,
      `entry ${entry['package-ecosystem']} sets commit-message.include -- ` +
        `\`include: scope\` appends "(deps)"/"(deps-dev)" and "deps-dev" is not an ` +
        'allowed scope in scripts/validate-commit-msg.mjs, which would fail pr-title-lint.yml',
    );

    const sampleSubject = `${commitMessage.prefix}: bump some-package from 1.0.0 to 1.0.1`;
    const result = validateCommitSubject(sampleSubject);
    assert.ok(
      result.ok,
      `sample subject "${sampleSubject}" (derived from entry ` +
        `${entry['package-ecosystem']}'s commit-message.prefix) was rejected by ` +
        `validateCommitSubject: ${result.reason}`,
    );
  }
});

test('each ecosystem has both a version-updates and a security-updates group', () => {
  const config = loadConfig();
  for (const entry of config.updates) {
    const groups = entry.groups;
    assert.ok(
      groups && typeof groups === 'object',
      `entry ${entry['package-ecosystem']} is missing a groups: block`,
    );
    const appliesTo = Object.values(groups).map((g) => g['applies-to']);
    assert.ok(
      appliesTo.includes('version-updates'),
      `entry ${entry['package-ecosystem']} has no group with applies-to: version-updates`,
    );
    assert.ok(
      appliesTo.includes('security-updates'),
      `entry ${entry['package-ecosystem']} has no group with applies-to: security-updates`,
    );
  }
});
