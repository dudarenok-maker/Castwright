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
      'lodash', // package name - resolved separately
      { source: 1106913, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', title: 'Prototype Pollution' },
      'debug', // another package name - would be resolved separately
      { source: 1106913, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', title: 'Prototype Pollution' }, // duplicate
    ],
  };
  // collectAdvisoryIds now returns Map<id, Set<sourcePackages>>
  const result = collectAdvisoryIds(entry, {}, 'react-router');
  assert.deepEqual([...result.keys()].sort(), ['GHSA-p6mc-m468-83gw']);
  // The advisory came from the direct package (react-router)
  assert.deepEqual([...result.get('GHSA-p6mc-m468-83gw')], ['react-router']);
});

test('collectAdvisoryIds: empty/missing via yields empty map', () => {
  assert.equal(collectAdvisoryIds({}).size, 0);
  assert.equal(collectAdvisoryIds(null).size, 0);
});

test('collectAdvisoryIds: resolves transitive-only advisories by package name', () => {
  // Bug A fix: when via[] is strings-only (purely transitive), resolve the
  // package names in the vulnerabilities map to find their advisory ids.
  // Example: async has via: ["lodash"], and lodash entry has the actual advisory.
  const vulns = {
    'async@2.6.0': {
      severity: 'high',
      via: ['lodash'], // Only a package name - no direct advisory object
    },
    'lodash@4.17.20': {
      severity: 'high',
      via: [{ source: 1106913, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', severity: 'high', title: 'Prototype Pollution' }],
    },
  };
  // Should resolve async's "lodash" reference and find the GHSA from lodash's entry
  const result = collectAdvisoryIds(vulns['async@2.6.0'], vulns, 'async');
  assert.deepEqual([...result.keys()].sort(), ['GHSA-p6mc-m468-83gw']);
  // The advisory came from lodash (the transitive source)
  assert.deepEqual([...result.get('GHSA-p6mc-m468-83gw')], ['lodash']);
});

test('collectAdvisoryIds: filters advisory objects by their own severity (Bug C)', () => {
  // Bug C fix: only include advisory ids whose own severity is at/above gate threshold.
  // Example: a high-severity entry has via[] with both high and moderate advisories.
  const vulns = {
    'some-package@1.0': {
      severity: 'high',
      via: [
        { source: 111111, url: 'https://github.com/advisories/GHSA-hhhh-1111-aaaa', severity: 'high', title: 'Critical Flaw' },
        { source: 222222, url: 'https://github.com/advisories/GHSA-mmmm-2222-bbbb', severity: 'moderate', title: 'Minor Issue' },
        { source: 333333, url: 'https://github.com/advisories/GHSA-cccc-3333-dddd', severity: 'critical', title: 'Critical' },
        { source: 444444, url: 'https://github.com/advisories/GHSA-llll-4444-eeee', severity: 'low', title: 'Low Priority' },
      ],
    },
  };
  // Should only collect the high and critical severity advisories, skip moderate and low
  const result = collectAdvisoryIds(vulns['some-package@1.0'], vulns, 'some-package');
  assert.deepEqual([...result.keys()].sort(), ['GHSA-cccc-3333-dddd', 'GHSA-hhhh-1111-aaaa']);
  // All came from the direct package
  for (const sources of result.values()) {
    assert.deepEqual([...sources], ['some-package']);
  }
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

test('gateFailures: transitive-only advisory is waivable when underlying GHSA is waived', () => {
  // Bug A fix: async@2 has via: ["lodash"] (strings-only, purely transitive).
  // When we waive the underlying GHSA from lodash's advisory, async should pass.
  const vulns = {
    'async@2.6.0': {
      severity: 'high',
      via: ['lodash'],
    },
    'lodash@4.17.20': {
      severity: 'high',
      via: [{ source: 1106913, url: 'https://github.com/advisories/GHSA-p6mc-m468-83gw', severity: 'high', title: 'Prototype Pollution' }],
    },
  };
  // Waive the underlying GHSA for the package that actually pulled in the vulnerability
  const waivers = [{ ghsaId: 'GHSA-p6mc-m468-83gw', package: 'lodash', reason: 'dismissed', expiry: '2099-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, []);
  // Both async and lodash should now be waived
  assert.deepEqual(missing, []);
});

test('gateFailures: entry with multi-severity advisories only requires qualifying ones to be waived', () => {
  // Bug C fix: high-severity entry with both high and moderate advisories in via[].
  // Waiving just the high-severity advisory should be sufficient.
  const vulns = {
    'some-package@1.0': {
      severity: 'high',
      via: [
        { source: 111111, url: 'https://github.com/advisories/GHSA-hhhh-1111-aaaa', severity: 'high', title: 'Critical Flaw' },
        { source: 222222, url: 'https://github.com/advisories/GHSA-mmmm-2222-bbbb', severity: 'moderate', title: 'Minor Issue' },
      ],
    },
  };
  // Only waive the high-severity advisory, not the moderate one
  const waivers = [{ ghsaId: 'GHSA-hhhh-1111-aaaa', package: 'some-package', reason: 'dismissed', expiry: '2099-01-01' }];
  const { missing, expired } = gateFailures(vulns, waivers);
  assert.deepEqual(expired, []);
  // The moderate advisory should be filtered out (not collected), so missing should be empty
  assert.deepEqual(missing, []);
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

test('parseAuditOutput: extract vulnerabilities map from valid reports', () => {
  assert.deepEqual(parseAuditOutput(JSON.stringify({ vulnerabilities: { a: 1 } })), { a: 1 });
  assert.deepEqual(parseAuditOutput(JSON.stringify({ vulnerabilities: {} })), {});
});

test('parseAuditOutput: fail-closed on empty stdout', () => {
  // Empty stdout indicates npm failed or produced no output - fail closed
  assert.throws(
    () => parseAuditOutput(''),
    /produced no output/,
  );
  assert.throws(
    () => parseAuditOutput('   '),
    /produced no output/,
  );
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