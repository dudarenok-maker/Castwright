// scripts/tests/deps-watch.test.mjs
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KGP_PLUGINS,
  compareSemver,
  parseOutdated,
  parsePins,
} from '../deps-watch.mjs';

test('KGP_PLUGINS is exactly the three tracked plugins', () => {
  assert.deepEqual(
    [...KGP_PLUGINS].sort(),
    ['audio_session', 'flutter_foreground_task', 'mobile_scanner'],
  );
});

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

test('parsePins strips the caret and reads only requested names', () => {
  const pubspec = [
    '  flutter_foreground_task: ^9.2.2',
    '  audio_session: ^0.2.3',
    '  connectivity_plus: 6.1.0',
    '  mobile_scanner: ^7.2.0',
  ].join('\n');
  const pins = parsePins(pubspec, KGP_PLUGINS);
  assert.deepEqual(pins, {
    audio_session: '0.2.3',
    flutter_foreground_task: '9.2.2',
    mobile_scanner: '7.2.0',
  });
});

import {
  computeBehind,
  computePluginStatus,
  extractState,
  buildState,
  computeTransitions,
  exitCodeFor,
  findSticky,
  stickyRequest,
} from '../deps-watch.mjs';

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

test('computePluginStatus: ahead when latest>pin; absent pkg treated as at-pin', () => {
  const pins = { audio_session: '0.2.3', flutter_foreground_task: '9.2.2', mobile_scanner: '7.2.0' };
  const map = pkgMap({
    audio_session: { kind: 'direct', current: '0.2.3', latest: '0.2.4' }, // newer
    flutter_foreground_task: { kind: 'direct', current: '9.2.2', latest: '9.2.2' },
    // mobile_scanner absent -> at pin
  });
  const status = computePluginStatus(map, pins);
  const byName = Object.fromEntries(status.map((s) => [s.name, s]));
  assert.equal(byName.audio_session.ahead, true);
  assert.equal(byName.audio_session.latest, '0.2.4');
  assert.equal(byName.flutter_foreground_task.ahead, false);
  assert.equal(byName.mobile_scanner.ahead, false);
  assert.equal(byName.mobile_scanner.latest, '7.2.0'); // falls back to pin
});

test('extractState parses the embedded JSON; empty/garbage -> {}', () => {
  const body = `${'<!-- ops-17-deps-watch -->'}\n<!-- state: {"audio_session":{"latest":"0.2.3","ahead":false}} -->\nbody`;
  assert.deepEqual(extractState(body), { audio_session: { latest: '0.2.3', ahead: false } });
  assert.deepEqual(extractState(undefined), {});
  assert.deepEqual(extractState('no marker here'), {});
});

test('computeTransitions: fires only on at-pin -> ahead', () => {
  const status = [
    { name: 'audio_session', ahead: true },
    { name: 'mobile_scanner', ahead: true },
  ];
  // audio_session was already ahead last run; mobile_scanner just flipped.
  const prior = { audio_session: { ahead: true }, mobile_scanner: { ahead: false } };
  assert.deepEqual(computeTransitions(status, prior), ['mobile_scanner']);
  // empty prior (first run) -> every currently-ahead plugin transitions
  assert.deepEqual(computeTransitions(status, {}), ['audio_session', 'mobile_scanner']);
});

test('computeTransitions: ahead->ahead does NOT re-fire (transition fires once)', () => {
  // The core A2 guarantee: a plugin already ahead last run must not re-spam #790.
  const status = [{ name: 'audio_session', ahead: true }];
  assert.deepEqual(computeTransitions(status, { audio_session: { ahead: true } }), []);
});

test('computeBehind: empty payload -> [] and exitCodeFor -> 0 (the green baseline)', () => {
  // parseOutdated is imported in the Task 1 block of this same test file.
  assert.deepEqual(computeBehind(parseOutdated('{}')), []);
  assert.deepEqual(computeBehind(parseOutdated('{"packages":[]}')), []);
  assert.equal(exitCodeFor(computeBehind(parseOutdated('{}'))), 0);
});

test('computeBehind: a direct dep ABSENT from the payload cannot be behind (absent = at latest)', () => {
  const map = pkgMap({ just_audio: { kind: 'direct', current: '0.10.5', latest: '0.10.5' } });
  assert.deepEqual(computeBehind(map), []); // audio_session etc. simply absent -> not behind, not an error
});

test('computePluginStatus: a MAJOR bump the caret pin blocks still reads as ahead (drives off latest)', () => {
  // The headline A2 scenario: pin ^7.2.0 caps resolvable, but latest shows 8.0.0.
  const pins = { mobile_scanner: '7.2.0' };
  const map = pkgMap({ mobile_scanner: { kind: 'direct', current: '7.2.0', latest: '8.0.0' } });
  const [s] = computePluginStatus(map, pins, ['mobile_scanner']);
  assert.equal(s.ahead, true);
  assert.equal(s.latest, '8.0.0');
});

test('extractState: marker present but JSON malformed -> {} (no throw)', () => {
  const body = '<!-- ops-17-deps-watch -->\n<!-- state: {not valid json -->\nbody';
  assert.deepEqual(extractState(body), {});
});

test('buildState round-trips through extractState; records ahead:false too', () => {
  const status = [
    { name: 'audio_session', pin: '0.2.3', latest: '0.2.4', ahead: true },
    { name: 'mobile_scanner', pin: '7.2.0', latest: '7.2.0', ahead: false },
  ];
  const state = buildState(status);
  assert.deepEqual(state, {
    audio_session: { latest: '0.2.4', ahead: true },
    mobile_scanner: { latest: '7.2.0', ahead: false },
  });
});

test('findSticky: locates the marker comment even when a human commented later', () => {
  const comments = [
    { id: 1, body: 'a human note' },
    { id: 2, body: '<!-- ops-17-deps-watch -->\nstatus' },
    { id: 3, body: 'a later human note' },
  ];
  assert.equal(findSticky(comments).id, 2);
  assert.equal(findSticky([{ id: 9, body: 'nothing here' }]), null);
  assert.equal(findSticky([]), null);
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
