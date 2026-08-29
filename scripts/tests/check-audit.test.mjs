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

test('collectAdvisoryIds: extracts GHSA from url, skips package names, dedupes', () => {
  // Real npm audit --json shape: via[] contains package names (strings) and
  // advisory objects with source (number) and url (GHSA link).
  const entry = {
    via: [
      'lodash', // package name - skip this
      { source: 1106913, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', title: 'Prototype Pollution' },
      'debug', // another package name - skip
      { source: 1106913, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', title: 'Prototype Pollution' }, // duplicate
    ],
  };
  assert.deepEqual([...collectAdvisoryIds(entry)].sort(), ['GHSA-p6mc-m468-83gw']);
});

test('collectAdvisoryIds: empty/missing via yields empty set', () => {
  assert.deepEqual([...collectAdvisoryIds({})], []);
  assert.deepEqual([...collectAdvisoryIds(null)], []);
});

test('isExpired: expiry strictly before today (UTC) is expired', () => {
  const today = new Date('2026-08-29T12:00:00Z');
  assert.equal(isExpired({ expiry: '2026-08-28' }, today), true);
  assert.equal(isExpired({ expiry: '2026-08-29' }, today), true); // same day = expired
  assert.equal(isExpired({ expiry: '2026-08-30' }, today), false);
});

test('isExpired: missing or malformed expiry is treated as expired (fail-closed)', () => {
  const today = new Date('2026-08-29T12:00:00Z');
  // Missing expiry field
  assert.equal(isExpired({}, today), true);
  assert.equal(isExpired(null, today), true);
  assert.equal(isExpired(undefined, today), true);
  // Non-string expiry
  assert.equal(isExpired({ expiry: 123 }, today), true);
  assert.equal(isExpired({ expiry: null }, today), true);
  assert.equal(isExpired({ expiry: ['2026-08-30'] }, today), true);
  // Malformed date string
  assert.equal(isExpired({ expiry: 'not-a-date' }, today), true);
  assert.equal(isExpired({ expiry: '2026/08/29' }, today), true);
  assert.equal(isExpired({ expiry: '08-29-2026' }, today), true);
  // Invalid calendar date (auto-rollover detection)
  assert.equal(isExpired({ expiry: '2026-13-01' }, today), true); // month 13
  assert.equal(isExpired({ expiry: '2026-08-45' }, today), true); // day 45
  assert.equal(isExpired({ expiry: '2026-02-30' }, today), true); // Feb 30 doesn't exist
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
    'react-router@8': {
      severity: 'high',
      via: ['webpack', { source: 999111, url: 'https://github.com/advisories/GHSA-7jn1-qqq4-99gw', title: 'ReDoS' }],
    },
    'server-dep': {
      severity: 'critical',
      via: [{ source: 888222, url: 'https://github.com/advisories/GHSA-cccc-2222-88gw', title: 'Injection' }],
    },
  };
  const { missing, expired } = gateFailures(vulns, []);
  assert.deepEqual(expired, []);
  assert.deepEqual(missing, [
    { package: 'react-router@8', advisories: ['GHSA-7jn1-qqq4-99gw'] },
    { package: 'server-dep', advisories: ['GHSA-cccc-2222-88gw'] },
  ]);
});

test('gateFailures: active waiver covers its GHSA and package', () => {
  const vulns = {
    'react-router@8': {
      severity: 'high',
      via: ['npm', { source: 999111, url: 'https://github.com/advisories/GHSA-7jn1-qqq4-99gw', title: 'ReDoS' }],
    },
  };
  const waivers = [{ ghsaId: 'GHSA-7jn1-qqq4-99gw', package: 'react-router', reason: 'dismissed', expiry: '2099-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, []);
  assert.deepEqual(missing, []);
});

test('gateFailures: waiver with matching GHSA but wrong package does not cover the advisory', () => {
  const vulns = {
    'react-router@8': {
      severity: 'high',
      via: [{ source: 999111, url: 'https://github.com/advisories/GHSA-7jn1-qqq4-99gw', title: 'ReDoS' }],
    },
  };
  // Waiver is for a different package, even though the GHSA matches
  const waivers = [{ ghsaId: 'GHSA-7jn1-qqq4-99gw', package: 'lodash', reason: 'false positive', expiry: '2099-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, []);
  // The advisory should NOT be waived because the package doesn't match
  assert.deepEqual(missing, [{ package: 'react-router@8', advisories: ['GHSA-7jn1-qqq4-99gw'] }]);
});

test('gateFailures: expired waiver no longer covers its GHSA and is reported', () => {
  const vulns = {
    'react-router@8': {
      severity: 'high',
      via: [{ source: 999111, url: 'https://github.com/advisories/GHSA-7jn1-qqq4-99gw', title: 'ReDoS' }],
    },
  };
  // isExpired uses real Date.now(), so drive the waiver into the past directly.
  const waivers = [{ ghsaId: 'GHSA-7jn1-qqq4-99gw', package: 'react-router', reason: 'stale', expiry: '2020-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, ['GHSA-7jn1-qqq4-99gw']);
  assert.deepEqual(missing, [{ package: 'react-router@8', advisories: ['GHSA-7jn1-qqq4-99gw'] }]);
});

test('gateFailures: high severity with no attributable advisory fails closed', () => {
  const vulns = { 'mystery@1': { severity: 'critical', via: [] } };
  const { missing } = gateFailures(vulns, []);
  assert.deepEqual(missing, [{ package: 'mystery@1', advisories: [] }]);
});

test('loadWaivers: parses a valid array and rejects a non-array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-audit-waivers-'));
  try {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify([
      { ghsaId: 'GHSA-x', package: 'lodash', reason: 'dismissed', expiry: '2099-01-01' }
    ]));
    assert.deepEqual(loadWaivers(good), [
      { ghsaId: 'GHSA-x', package: 'lodash', reason: 'dismissed', expiry: '2099-01-01' }
    ]);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"not":"an array"}');
    assert.throws(() => loadWaivers(bad), /must be an array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWaivers: rejects entries with missing required fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-audit-waivers-'));
  try {
    // Missing ghsaId
    let f = join(dir, 'missing-ghsa.json');
    writeFileSync(f, JSON.stringify([{ package: 'lodash', reason: 'ok', expiry: '2099-01-01' }]));
    assert.throws(() => loadWaivers(f), /missing or invalid ghsaId/);

    // Missing package
    f = join(dir, 'missing-package.json');
    writeFileSync(f, JSON.stringify([{ ghsaId: 'GHSA-x', reason: 'ok', expiry: '2099-01-01' }]));
    assert.throws(() => loadWaivers(f), /missing or invalid package/);

    // Missing reason
    f = join(dir, 'missing-reason.json');
    writeFileSync(f, JSON.stringify([{ ghsaId: 'GHSA-x', package: 'lodash', expiry: '2099-01-01' }]));
    assert.throws(() => loadWaivers(f), /missing or invalid reason/);

    // Missing expiry
    f = join(dir, 'missing-expiry.json');
    writeFileSync(f, JSON.stringify([{ ghsaId: 'GHSA-x', package: 'lodash', reason: 'ok' }]));
    assert.throws(() => loadWaivers(f), /missing or invalid expiry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWaivers: rejects entries with malformed or invalid expiry dates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-audit-waivers-'));
  try {
    const base = { ghsaId: 'GHSA-x', package: 'lodash', reason: 'ok' };

    // Malformed date format
    let f = join(dir, 'bad-format.json');
    writeFileSync(f, JSON.stringify([{ ...base, expiry: '2099/01/01' }]));
    assert.throws(() => loadWaivers(f), /does not match YYYY-MM-DD format/);

    // Invalid calendar date (month 13)
    f = join(dir, 'bad-month.json');
    writeFileSync(f, JSON.stringify([{ ...base, expiry: '2099-13-01' }]));
    assert.throws(() => loadWaivers(f), /not a valid calendar date/);

    // Invalid calendar date (day 45)
    f = join(dir, 'bad-day.json');
    writeFileSync(f, JSON.stringify([{ ...base, expiry: '2099-08-45' }]));
    assert.throws(() => loadWaivers(f), /not a valid calendar date/);
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
  assert.deepEqual(parseAuditOutput(JSON.stringify({ vulnerabilities: {} })), {});
});

test('parseAuditOutput: fail-closed when vulnerabilities key is missing', () => {
  // Missing vulnerabilities key indicates an error response (e.g., npm audit failed).
  assert.throws(
    () => parseAuditOutput(JSON.stringify({ a: 1 })),
    /missing the vulnerabilities key/,
  );
});

test('parseAuditOutput: fail-closed when npm audit returns an error response', () => {
  // ENOLOCK (no package-lock.json) response.
  assert.throws(
    () => parseAuditOutput(JSON.stringify({ error: { code: 'ENOLOCK', message: 'No package-lock.json' } })),
    /npm audit returned an error/,
  );
  // String error message.
  assert.throws(
    () => parseAuditOutput(JSON.stringify({ error: 'Registry unreachable' })),
    /npm audit returned an error/,
  );
});