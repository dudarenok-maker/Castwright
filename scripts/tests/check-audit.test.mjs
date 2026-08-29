// Pure-logic coverage for scripts/check-audit.mjs (#2434): the severity gate,
// advisory-id extraction, waiver expiry, and the unwaived/expired failure
// classification. Kept to the exported pure functions so no real `npm audit`
// subprocess or registry network call runs on the pre-commit/pre-push/CI hot
// path - the verify child owns the mutation proof that the gate can fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isGateSeverity,
  collectAdvisoryIds,
  isExpired,
  gateFailures,
  loadWaivers,
  parseAuditOutput,
} from '../check-audit.mjs';

test('isGateSeverity: only high and critical count', () => {
  assert.equal(isGateSeverity('high'), true);
  assert.equal(isGateSeverity('critical'), true);
  assert.equal(isGateSeverity('moderate'), false);
  assert.equal(isGateSeverity('low'), false);
  assert.equal(isGateSeverity('info'), false);
});

test('collectAdvisoryIds: reads strings and object .source, dedupes', () => {
  const entry = {
    via: ['GHSA-aaa-111', { source: 'GHSA-bbb-222', title: 'x' }, 'GHSA-aaa-111'],
  };
  assert.deepEqual([...collectAdvisoryIds(entry)].sort(), ['GHSA-aaa-111', 'GHSA-bbb-222']);
});

test('collectAdvisoryIds: empty/missing via yields empty set', () => {
  assert.deepEqual([...collectAdvisoryIds({})], []);
  assert.deepEqual([...collectAdvisoryIds(null)], []);
});

test('isExpired: expiry strictly before today (UTC) is expired', () => {
  const today = new Date('2026-08-29T12:00:00Z');
  assert.equal(isExpired({ expiry: '2026-08-28' }, today), true);
  assert.equal(isExpired({ expiry: '2026-08-29' }, today), false); // same day = not yet
  assert.equal(isExpired({ expiry: '2026-08-30' }, today), false);
  assert.equal(isExpired({ expiry: 'not-a-date' }, today), false);
  assert.equal(isExpired({}, today), false);
});

test('gateFailures: clean report passes with no waivers', () => {
  const { missing, expired } = gateFailures({}, []);
  assert.deepEqual(missing, []);
  assert.deepEqual(expired, []);
});

test('gateFailures: ignores below-high noise', () => {
  const vulns = {
    'lodash@4': { severity: 'moderate', via: ['GHSA-nnn-333'] },
    'low-dep': { severity: 'low', via: ['GHSA-ooo-444'] },
  };
  const { missing } = gateFailures(vulns, []);
  assert.deepEqual(missing, []);
});

test('gateFailures: flags unwaived high advisory', () => {
  const vulns = {
    'react-router@8': { severity: 'high', via: ['GHSA-hhh-111'] },
    'server-dep': { severity: 'critical', via: [{ source: 'GHSA-ccc-222', title: 'x' }] },
  };
  const { missing, expired } = gateFailures(vulns, []);
  assert.deepEqual(expired, []);
  assert.deepEqual(missing, [
    { package: 'react-router@8', advisories: ['GHSA-hhh-111'] },
    { package: 'server-dep', advisories: ['GHSA-ccc-222'] },
  ]);
});

test('gateFailures: active waiver covers its GHSA', () => {
  const vulns = { 'react-router@8': { severity: 'high', via: ['GHSA-hhh-111'] } };
  const waivers = [{ ghsaId: 'GHSA-hhh-111', package: 'react-router', reason: 'dismissed', expiry: '2099-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, []);
  assert.deepEqual(missing, []);
});

test('gateFailures: expired waiver no longer covers its GHSA and is reported', () => {
  const vulns = { 'react-router@8': { severity: 'high', via: ['GHSA-hhh-111'] } };
  // isExpired uses real Date.now(), so drive the waiver into the past directly.
  const waivers = [{ ghsaId: 'GHSA-hhh-111', package: 'react-router', reason: 'stale', expiry: '2020-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, ['GHSA-hhh-111']);
  assert.deepEqual(missing, [{ package: 'react-router@8', advisories: ['GHSA-hhh-111'] }]);
});

test('gateFailures: high severity with no attributable advisory fails closed', () => {
  const vulns = { 'mystery@1': { severity: 'critical', via: [] } };
  const { missing } = gateFailures(vulns, []);
  assert.deepEqual(missing, [{ package: 'mystery@1', advisories: [] }]);
});

test('loadWaivers: parses an array and rejects a non-array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-audit-waivers-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify([{ ghsaId: 'GHSA-x', expiry: '2099-01-01' }]));
    assert.deepEqual(loadWaivers(good), [{ ghsaId: 'GHSA-x', expiry: '2099-01-01' }]);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"not":"an array"}');
    assert.throws(() => loadWaivers(bad), /must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWaivers: missing file is an empty list', () => {
  assert.deepEqual(loadWaivers(join(tmpdir(), 'definitely-missing-waivers-2778.json')), []);
});

test('parseAuditOutput: extract vulnerabilities map, tolerate empty', () => {
  assert.deepEqual(parseAuditOutput(''), {});
  assert.deepEqual(parseAuditOutput(JSON.stringify({ vulnerabilities: { a: 1 } })), { a: 1 });
  assert.deepEqual(parseAuditOutput(JSON.stringify({ a: 1 })), { a: 1 });
});