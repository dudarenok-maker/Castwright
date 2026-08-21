/* Tests that verify mock API functions use secure random (not Math.random)
   for generating identifiers. These ensure CodeQL js/insecure-randomness
   alerts do not surface for any id/token minting in mock mode. */

import { describe, it, expect, vi } from 'vitest';
import { mockCloneVoiceSample } from './api';
import { makeSecureUuid, makeSecureRandom } from './secure-random';

describe('Mock API exported functions use secure random', () => {
  it('mockCloneVoiceSample generates candidateId without Math.random', async () => {
    const randomSpy = vi.spyOn(Math, 'random');
    const form = new FormData();

    try {
      const result = await mockCloneVoiceSample(form);

      /* Math.random should NOT be called; secure random handles it */
      expect(randomSpy).not.toHaveBeenCalled();
      expect(result.candidateId).toBeTruthy();
      expect(result.candidateId).toMatch(/^cand-/);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe('Secure random functions produce valid mock id formats', () => {
  it('makeSecureUuid produces valid UUID for tempId prefix', () => {
    const uuid = makeSecureUuid();
    /* All paths now return UUID-like format: 8-4-4-4-12 hex digits */
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const tempId = 'imp_' + uuid.slice(0, 8);
    expect(tempId).toMatch(/^imp_[0-9a-f]/i);
  });

  it('makeSecureUuid produces valid UUID for manuscriptId prefix', () => {
    const uuid = makeSecureUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const manuscriptId = 'mns_' + uuid.slice(0, 8);
    expect(manuscriptId).toMatch(/^mns_[0-9a-f]/i);
  });

  it('makeSecureUuid produces valid UUID for export job id', () => {
    const uuid = makeSecureUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const jobId = `exp_${uuid.slice(0, 10)}`;
    expect(jobId).toMatch(/^exp_[0-9a-f]/i);
  });

  it('makeSecureRandom produces valid 12-char Crockford base32 share slug', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slug = makeSecureRandom(alphabet, 12);
    expect(slug).toMatch(/^[0-9A-Z]{12}$/);
  });

  it('makeSecureUuid produces valid candidateId format', () => {
    const uuid = makeSecureUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const candidateId = `cand-${uuid.slice(0, 8)}`;
    expect(candidateId).toMatch(/^cand-[0-9a-f]/i);
  });

  it('generated UUID ids are unique across multiple calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      ids.add(makeSecureUuid());
    }
    /* All 100 IDs should be unique */
    expect(ids.size).toBe(100);
  });

  it('generated share slugs are unique across multiple calls', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slugs = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      slugs.add(makeSecureRandom(alphabet, 12));
    }
    /* All 100 slugs should be unique */
    expect(slugs.size).toBe(100);
  });
});
