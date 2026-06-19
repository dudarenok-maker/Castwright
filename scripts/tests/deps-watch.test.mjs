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
