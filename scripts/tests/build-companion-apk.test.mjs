import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextBuildNumber,
  parseSignerSha256,
  sha1Hex,
  EXPECTED_UPLOAD_CERT_SHA256,
} from '../build-companion-apk.mjs';

test('nextBuildNumber: whole minutes since epoch for a fixed instant', () => {
  // 2026-06-18T18:00:00Z = 1781200800000 ms → /60000 = 29686680
  assert.equal(nextBuildNumber(1781200800000), 29686680);
});

test('nextBuildNumber: floors sub-minute remainder', () => {
  assert.equal(nextBuildNumber(59_999), 0);
  assert.equal(nextBuildNumber(60_000), 1);
  assert.equal(nextBuildNumber(119_999), 1);
});

test('nextBuildNumber: monotonic — a later instant never yields a lower code', () => {
  const earlier = nextBuildNumber(1781200800000);
  const later = nextBuildNumber(1781200800000 + 5 * 60_000);
  assert.ok(later > earlier);
});

test('nextBuildNumber: stays under the Play 2.1e9 ceiling and above hand-set 10.8M', () => {
  const now = nextBuildNumber(1781200800000);
  assert.ok(now > 10_800_000, 'must exceed the last hand-set versionCode');
  assert.ok(now < 2_100_000_000, 'must stay under Google Play versionCode limit');
});

test('parseSignerSha256: extracts the cert from real apksigner output', () => {
  const out = [
    'Signer #1 certificate DN: CN=Mikhail Dudarenok, O=Castwright',
    `Signer #1 certificate SHA-256 digest: ${EXPECTED_UPLOAD_CERT_SHA256}`,
    'Signer #1 certificate SHA-1 digest: 09e839c121e312cc6d2eb7c99a74e9b79731daba',
  ].join('\n');
  assert.equal(parseSignerSha256(out), EXPECTED_UPLOAD_CERT_SHA256);
});

test('parseSignerSha256: lowercases and returns null when absent', () => {
  const upper = `Signer #1 certificate SHA-256 digest: ${EXPECTED_UPLOAD_CERT_SHA256.toUpperCase()}`;
  assert.equal(parseSignerSha256(upper), EXPECTED_UPLOAD_CERT_SHA256);
  assert.equal(parseSignerSha256('no digest here'), null);
});

test('sha1Hex: known vector', () => {
  // SHA-1("abc") = a9993e364706816aba3e25717850c26c9cd0d89d
  assert.equal(sha1Hex(Buffer.from('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
});
