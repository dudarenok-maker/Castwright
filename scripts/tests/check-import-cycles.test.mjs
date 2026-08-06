// Tests for the madge cycle-allowlist guard (#2053). Run via `npm run
// test:hooks` (node --test, no extra deps).
//
// Deliberately does NOT spawn real madge here: `check:cycles` is its own
// STEPS[] entry precisely because a real --circular pass over server/src is
// not free (see verify-cache.mjs's comment on that step and
// docs/superpowers... the repo-owner decision on #2053) — folding a real
// madge invocation into test:hooks would re-tax every local/CI run this step
// was deliberately kept out of. These tests cover the pure comparison logic
// instead; `npm run check:cycles` itself (run manually, or as its own CI leg)
// is what exercises the real madge invocation end to end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cycleSignature, findUnallowedCycles, loadAllowlist } from '../check-import-cycles.mjs';

test('cycleSignature is order-invariant over a cycle\'s members', () => {
  assert.equal(
    cycleSignature(['a.ts', 'b.ts', 'c.ts']),
    cycleSignature(['c.ts', 'a.ts', 'b.ts']),
  );
});

test('cycleSignature distinguishes cycles with different members', () => {
  assert.notEqual(
    cycleSignature(['a.ts', 'b.ts']),
    cycleSignature(['a.ts', 'c.ts']),
  );
});

test('findUnallowedCycles returns empty when every current cycle is allowlisted', () => {
  const current = [
    ['a.ts', 'b.ts'],
    ['c.ts', 'd.ts', 'e.ts'],
  ];
  const allowlist = [
    ['b.ts', 'a.ts'], // same set, different order — must still match
    ['c.ts', 'd.ts', 'e.ts'],
  ];
  assert.deepEqual(findUnallowedCycles(current, allowlist), []);
});

// The core acceptance criterion from #2053: a SWAPPED cycle (one removed,
// a different one introduced) must be caught even though the allowlist and
// the current list are the same LENGTH — a count check would miss this.
test('findUnallowedCycles catches a swapped cycle even at equal length', () => {
  const allowlist = [['a.ts', 'b.ts']];
  const current = [['x.ts', 'y.ts']]; // different cycle, same count
  const unallowed = findUnallowedCycles(current, allowlist);
  assert.deepEqual(unallowed, [['x.ts', 'y.ts']]);
});

test('findUnallowedCycles catches a genuinely new cycle added on top of the existing ones', () => {
  const allowlist = [['a.ts', 'b.ts']];
  const current = [['a.ts', 'b.ts'], ['p.ts', 'q.ts']];
  const unallowed = findUnallowedCycles(current, allowlist);
  assert.deepEqual(unallowed, [['p.ts', 'q.ts']]);
});

test('findUnallowedCycles is silent when a cycle is fixed (removed from current, still in allowlist)', () => {
  const allowlist = [['a.ts', 'b.ts'], ['c.ts', 'd.ts']];
  const current = [['a.ts', 'b.ts']]; // 'c.ts <-> d.ts' was fixed
  assert.deepEqual(findUnallowedCycles(current, allowlist), []);
});

test('loadAllowlist reads a JSON array of cycles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycles-allowlist-'));
  const path = join(dir, 'allowlist.json');
  writeFileSync(path, JSON.stringify([['a.ts', 'b.ts']]), 'utf8');
  try {
    assert.deepEqual(loadAllowlist(path), [['a.ts', 'b.ts']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAllowlist throws when the file is not a JSON array', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycles-allowlist-'));
  const path = join(dir, 'allowlist.json');
  writeFileSync(path, JSON.stringify({ not: 'an array' }), 'utf8');
  try {
    assert.throws(() => loadAllowlist(path), /must be a JSON array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression pin: the real committed allowlist must itself be a well-formed
// JSON array of string arrays — a malformed commit here would only surface
// at `check:cycles` runtime otherwise (cloud/full-verify only).
test('the real committed server/madge-cycles-allowlist.json parses as an array of cycles', () => {
  const allowlist = loadAllowlist();
  assert.ok(allowlist.length > 0, 'expected at least one allowlisted cycle');
  for (const cycle of allowlist) {
    assert.ok(Array.isArray(cycle), 'each entry must be an array of file paths');
    assert.ok(cycle.length >= 2, 'a cycle needs at least 2 members');
    for (const member of cycle) {
      assert.equal(typeof member, 'string');
    }
  }
});
