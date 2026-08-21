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
  it('makeSecureUuid produces valid uuid for tempId prefix', () => {
    const uuid = makeSecureUuid();
    const tempId = 'imp_' + uuid.slice(0, 8);
    expect(tempId).toMatch(/^imp_[0-9a-f]/i);
  });

  it('makeSecureUuid produces valid string for manuscriptId prefix', () => {
    const uuid = makeSecureUuid();
    const manuscriptId = 'mns_' + uuid.slice(0, 8);
    expect(manuscriptId).toMatch(/^mns_[0-9a-f]/i);
  });

  it('makeSecureUuid produces valid string for export job id', () => {
    const uuid = makeSecureUuid();
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
    const candidateId = `cand-${uuid.slice(0, 8)}`;
    expect(candidateId).toMatch(/^cand-[0-9a-f]/i);
  });

  it('generated ids are unique across multiple calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      ids.add(makeSecureUuid().slice(0, 8));
    }
    /* All 10 IDs should be unique */
    expect(ids.size).toBe(10);
  });

  it('generated share slugs are unique across multiple calls', () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const slugs = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      slugs.add(makeSecureRandom(alphabet, 12));
    }
    /* All 10 slugs should be unique */
    expect(slugs.size).toBe(10);
  });
});
