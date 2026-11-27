// scripts/tests/deps-watch.test.mjs
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STICKY_MARKER,
  compareSemver,
  parseOutdated,
  computeBehind,
  exitCodeFor,
  findSticky,
  stickyRequest,
  stickyWriteArgs,
  renderSticky,
  renderSummary,
} from '../deps-watch.mjs';

test('compareSemver orders by numeric component, not string', () => {
  assert.equal(compareSemver('0.2.4', '0.2.3'), 1);
  assert.equal(compareSemver('7.2.0', '7.10.0'), -1); // 2 < 10 numerically
  assert.equal(compareSemver('9.2.2', '9.2.2'), 0);
  assert.equal(compareSemver('1.0.0', '1.0.0-beta'), 0); // prerelease/build ignored
});

test('parseOutdated reads kind + current/latest, tolerating nulls', () => {
  const payload = {
    packages: [
      { package: 'audio_session', kind: 'direct', current: { version: '0.2.3' }, latest: { version: '0.2.3' } },
      { package: 'build_runner', kind: 'dev', current: { version: '2.15.0' }, latest: { version: '2.16.0' } },
      { package: 'meta', kind: 'transitive', current: null, latest: { version: '1.0.0' } },
    ],
  };
  const map = parseOutdated(payload);
  assert.equal(map.get('audio_session').kind, 'direct');
  assert.equal(map.get('build_runner').latest, '2.16.0');
  assert.equal(map.get('meta').current, null);
});

test('parseOutdated accepts a JSON string too', () => {
  const map = parseOutdated('{"packages":[{"package":"x","kind":"direct","current":{"version":"1.0.0"},"latest":{"version":"1.0.1"}}]}');
  assert.equal(map.get('x').latest, '1.0.1');
});

const pkgMap = (entries) => new Map(Object.entries(entries));

test('computeBehind: only direct/dev with latest>current', () => {
  const map = pkgMap({
    audio_session: { kind: 'direct', current: '0.2.3', latest: '0.2.3' }, // current
    build_runner: { kind: 'dev', current: '2.15.0', latest: '2.16.0' },   // behind (dev)
    just_audio: { kind: 'direct', current: '0.10.5', latest: '0.10.6' },  // behind (direct)
    meta: { kind: 'transitive', current: '1.0.0', latest: '2.0.0' },      // transitive: ignored
  });
  const behind = computeBehind(map).map((b) => b.name).sort();
  assert.deepEqual(behind, ['build_runner', 'just_audio']);
});

test('exitCodeFor: red iff something is behind', () => {
  assert.equal(exitCodeFor([]), 0);
  assert.equal(exitCodeFor([{ name: 'x' }]), 1);
});

test('computeBehind: empty payload -> [] and exitCodeFor -> 0 (the green baseline)', () => {
  assert.deepEqual(computeBehind(parseOutdated('{}')), []);
  assert.deepEqual(computeBehind(parseOutdated('{"packages":[]}')), []);
  assert.equal(exitCodeFor(computeBehind(parseOutdated('{}'))), 0);
});

test('computeBehind: a direct dep ABSENT from the payload cannot be behind (absent = at latest)', () => {
  const map = pkgMap({ just_audio: { kind: 'direct', current: '0.10.5', latest: '0.10.5' } });
  assert.deepEqual(computeBehind(map), []); // audio_session etc. simply absent -> not behind, not an error
});

test('findSticky: locates the marker comment even when a human commented later', () => {
  const comments = [
    { id: 1, body: 'a human note' },
    { id: 2, body: '<!-- ops-17-deps-watch -->\nstatus', user: { login: 'github-actions[bot]' } },
    { id: 3, body: 'a later human note' },
  ];
  assert.equal(findSticky(comments).id, 2);
  assert.equal(findSticky([{ id: 9, body: 'nothing here' }]), null);
  assert.equal(findSticky([]), null);
});

const BOT = { login: 'github-actions[bot]' };
const QUOTE = { id: 5, body: '> <!-- ops-17-deps-watch -->\n> status', user: { login: 'human' } };

test('findSticky: a human comment quoting the marker is skipped for the real bot sticky', () => {
  const real = { id: 6, body: '<!-- ops-17-deps-watch -->\nstatus', user: BOT };
  assert.equal(findSticky([QUOTE, real]).id, 6);
});

test('findSticky: a quoting human comment alone is not a sticky', () => {
  assert.equal(findSticky([QUOTE]), null);
});

test('findSticky: a bot comment starting with the marker is found', () => {
  assert.equal(findSticky([{ id: 7, body: '<!-- ops-17-deps-watch -->', user: BOT }]).id, 7);
});

test('findSticky: a HUMAN comment starting with the marker is not a sticky (login check)', () => {
  const human = { id: 8, body: STICKY_MARKER + '\nstatus', user: { login: 'someone' } };
  assert.equal(findSticky([human]), null);
});

test('findSticky: a bot comment with the marker NOT at the start is not a sticky (startsWith)', () => {
  const mid = { id: 10, body: 'note\n' + STICKY_MARKER, user: BOT };
  assert.equal(findSticky([mid]), null);
});

test('findSticky: finds what renderSticky writes (render -> find round trip)', () => {
  const body = renderSticky({ behind: [], today: '2026-11-27' });
  assert.equal(findSticky([{ id: 9, body, user: BOT }])?.id, 9);
});

test('stickyRequest: PATCH on the existing numeric id, else POST to the issue', () => {
  assert.deepEqual(stickyRequest({ id: 42 }, 'o/r', '790'), {
    method: 'PATCH',
    path: 'repos/o/r/issues/comments/42',
  });
  assert.deepEqual(stickyRequest(null, 'o/r', '790'), {
    method: 'POST',
    path: 'repos/o/r/issues/790/comments',
  });
});

test('stickyWriteArgs: the exact gh argv for a new (POST) and existing (PATCH) sticky', () => {
  assert.deepEqual(stickyWriteArgs(stickyRequest(null, 'o/r', '790'), 'B'), [
    'api', 'repos/o/r/issues/790/comments', '--method', 'POST', '-f', 'body=B',
  ]);
  assert.deepEqual(stickyWriteArgs(stickyRequest({ id: 42 }, 'o/r', '790'), 'B'), [
    'api', 'repos/o/r/issues/comments/42', '--method', 'PATCH', '-f', 'body=B',
  ]);
});

test('renderSticky carries the marker and no KGP wording (#4649)', () => {
  const md = renderSticky({ behind: [], today: '2026-07-01' });
  assert.ok(md.includes(STICKY_MARKER));
  assert.ok(!/KGP/i.test(md));
  assert.ok(!md.includes('state:'));
});

test('renderSummary (no marker) shows the all-clear line when nothing is behind', () => {
  const md = renderSummary({ behind: [], today: '2026-07-01' });
  assert.ok(!md.includes(STICKY_MARKER));
  assert.ok(/None — all direct\/dev deps current/i.test(md));
});

test('renderSummary lists behind deps in a table', () => {
  const md = renderSummary({
    behind: [{ name: 'build_runner', kind: 'dev', current: '2.15.0', latest: '2.16.0' }],
    today: '2026-07-01',
  });
  assert.ok(md.includes('build_runner'));
  assert.ok(md.includes('2.16.0'));
});

test('deps-watch sticky posts on #4726 by default, not the KGP issue #790 (#4696)', () => {
  // The IO orchestrator is not unit-tested (it shells out to gh), so pin its
  // default issue number by reading its source.
  const src = readFileSync(new URL('../deps-watch-run.mjs', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.OPS17_ISSUE \|\| '4726'/);
  assert.doesNotMatch(src, /\|\| '790'/);
});
