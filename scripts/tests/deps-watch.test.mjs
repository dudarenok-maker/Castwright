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

test('computeTransitions: fires on at-pin -> ahead, and on first run for every currently-ahead plugin', () => {
  const status = [
    { name: 'audio_session', ahead: true, latest: '0.2.4' },
    { name: 'mobile_scanner', ahead: true, latest: '7.3.0' },
  ];
  // audio_session was already ahead last run at the SAME latest; mobile_scanner just flipped.
  const prior = { audio_session: { ahead: true, latest: '0.2.4' }, mobile_scanner: { ahead: false } };
  assert.deepEqual(computeTransitions(status, prior), ['mobile_scanner']);
  // empty prior (first run) -> every currently-ahead plugin transitions
  assert.deepEqual(computeTransitions(status, {}), ['audio_session', 'mobile_scanner']);
});

test('computeTransitions: ahead->ahead with unchanged latest does NOT re-fire (no cron spam)', () => {
  // The core no-re-spam guarantee (ops-17b, #2104): reshaped from an edge-detector
  // on `ahead` to one on `latest` — same prior AND current latest -> [].
  const status = [{ name: 'audio_session', ahead: true, latest: '0.3.0' }];
  const prior = { audio_session: { ahead: true, latest: '0.3.0' } };
  assert.deepEqual(computeTransitions(status, prior), []);
});

test('computeTransitions: fires on a genuine latest bump even though already ahead (ops-17b repro, #2104)', () => {
  const status = [{ name: 'flutter_foreground_task', ahead: true, latest: '10.1.0' }];
  const prior = { flutter_foreground_task: { ahead: true, latest: '10.0.0' } };
  assert.deepEqual(computeTransitions(status, prior), ['flutter_foreground_task']);
});

test('computeTransitions: a downgrade (latest moves backwards) does not fire', () => {
  const status = [{ name: 'mobile_scanner', ahead: true, latest: '10.0.0' }];
  const prior = { mobile_scanner: { ahead: true, latest: '10.1.0' } };
  assert.deepEqual(computeTransitions(status, prior), []);
});

test('computeTransitions: prior ahead:true with no usable latest fails loud (fires)', () => {
  const status = [{ name: 'mobile_scanner', ahead: true, latest: '7.4.0' }];
  const prior = { mobile_scanner: { ahead: true } }; // corrupt/legacy state: no `latest` recorded
  assert.deepEqual(computeTransitions(status, prior), ['mobile_scanner']);
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

import {
  STICKY_MARKER,
  renderSticky,
  renderSummary,
  renderTransitionComment,
} from '../deps-watch.mjs';

const STATUS_CLEAN = [
  { name: 'audio_session', pin: '0.2.3', latest: '0.2.3', ahead: false },
  { name: 'flutter_foreground_task', pin: '9.2.2', latest: '9.2.2', ahead: false },
  { name: 'mobile_scanner', pin: '7.2.0', latest: '7.2.0', ahead: false },
];
const STATUS_AHEAD = [
  { name: 'audio_session', pin: '0.2.3', latest: '0.3.0', ahead: true },
  { name: 'flutter_foreground_task', pin: '9.2.2', latest: '9.2.2', ahead: false },
  { name: 'mobile_scanner', pin: '7.2.0', latest: '7.2.0', ahead: false },
];

test('renderSticky embeds the marker + a parseable state block', () => {
  const md = renderSticky({ pluginStatus: STATUS_AHEAD, behind: [], today: '2026-07-01' });
  assert.ok(md.includes(STICKY_MARKER));
  assert.match(md, /<!-- state: .*audio_session.*-->/);
  assert.ok(md.includes('⚠️')); // banner when a plugin is ahead
  assert.ok(md.includes('verify')); // honest "verify whether it removed KGP" wording
});

test('renderSummary (no marker) shows the all-clear line when nothing is ahead', () => {
  const md = renderSummary({ pluginStatus: STATUS_CLEAN, behind: [], today: '2026-07-01' });
  assert.ok(!md.includes(STICKY_MARKER));
  assert.ok(/still at their pin/i.test(md));
  assert.ok(/None — all direct\/dev deps current/i.test(md));
});

test('renderSummary lists behind deps in a table', () => {
  const md = renderSummary({
    pluginStatus: STATUS_CLEAN,
    behind: [{ name: 'build_runner', kind: 'dev', current: '2.15.0', latest: '2.16.0' }],
    today: '2026-07-01',
  });
  assert.ok(md.includes('build_runner'));
  assert.ok(md.includes('2.16.0'));
});

test('renderTransitionComment: null when no transitions; @mention + recipe otherwise', () => {
  assert.equal(renderTransitionComment([], STATUS_AHEAD), null);
  const md = renderTransitionComment(['audio_session'], STATUS_AHEAD);
  assert.ok(md.includes('@dudarenok-maker'));
  assert.ok(md.includes('audio_session'));
  assert.ok(md.includes('0.3.0'));
  assert.ok(/flutter build apk --release/.test(md));
});

test('renderTransitionComment: recipe covers BOTH outcomes, and says the pin no longer arms the notification', () => {
  // ops-17b (#2104): the old copy only told the operator what to do on success
  // (bump pin / close #790), which trained them to leave the pin alone on a
  // rejected release — permanently disarming the watchdog for that plugin.
  const md = renderTransitionComment(['audio_session'], STATUS_AHEAD);
  // success path intact: bump pin, drop escape-hatch flags + Trip-B assertion, close #790.
  assert.ok(/bump the pin/i.test(md));
  assert.ok(/escape-hatch flags/i.test(md));
  assert.ok(/app\.yml.* Trip-B/i.test(md) || /Trip-B.*app\.yml/i.test(md));
  assert.ok(/close #790/i.test(md));
  // rejected-release path is now covered too, and states the pin isn't what re-arms it.
  assert.ok(/still (there|applies)|warning is still|not gone/i.test(md));
  assert.ok(/no longer (what arms|arms)|not what arms/i.test(md));
  // The advice must be bound to the rejected-release condition ON THE SAME LINE,
  // not merely present somewhere in the body — otherwise a rewrite that attaches
  // "leave the pin alone" to the WRONG bullet (e.g. the success path) would still
  // pass every assertion above. `.` doesn't match `\n` by default, so this only
  // matches if both phrases are on one line with nothing else between them.
  assert.match(md, /warning is still there.*leave the pin alone/i);
});
