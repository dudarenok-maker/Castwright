import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planTransition } from '../transition-local-to-castwright.mjs';

describe('planTransition', () => {
  it('plans a move when the old dir exists and the new one does not', () => {
    const exists = (p) => p.endsWith('audiobook-workspace') || p.endsWith('.audiobook-generator');
    const plan = planTransition({
      home: '/home/u',
      repoRoot: '/repo',
      exists,
    });
    assert.deepEqual(plan, [
      { from: join('/repo', '../audiobook-workspace'), to: join('/repo', '../castwright-workspace') },
      { from: join('/home/u', '.audiobook-generator'), to: join('/home/u', '.castwright') },
    ]);
  });

  it('skips a move when the old dir is missing', () => {
    const plan = planTransition({ home: '/home/u', repoRoot: '/repo', exists: () => false });
    assert.deepEqual(plan, []);
  });

  it('skips a move when the new dir already exists (no clobber)', () => {
    const exists = (p) => p.includes('audiobook') || p.endsWith('castwright-workspace') || p.endsWith('.castwright');
    const plan = planTransition({ home: '/home/u', repoRoot: '/repo', exists });
    assert.deepEqual(plan, []);
  });
});
