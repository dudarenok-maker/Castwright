/* fs-38 Wave 3a, Task 7 — consent-at-write structure guard on cloned
   voice-library writes. writeEntry() must throw ConsentRequiredError when
   provenance==='cloned' and consent is absent or structurally incomplete;
   revokedAt is orthogonal to this guard (a revoke write, which carries a
   structurally-complete consent block with revokedAt set, must PASS —
   revocation is enforced elsewhere, at assign-time, not here). Designed
   (and imported) entries are never gated. */

import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vl-'));
  process.env.WORKSPACE_DIR = dir;
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const base = { voiceUuid: 'u1', name: 'Mum', tags: [], pinned: false, engines: {}, createdAt: 'x', updatedAt: 'x' };
const consent = {
  personName: 'Mum',
  relationship: 'family-with-permission' as const,
  permittedUse: 'personal' as const,
  attestedAt: 'x',
  attestedBy: 'me',
};

it('rejects a cloned entry with no consent', async () => {
  const { writeEntry } = await import('./voice-library.js');
  await expect(writeEntry({ ...base, provenance: 'cloned' })).rejects.toThrow(/consent/i);
});
it('accepts a cloned entry with structurally-valid consent', async () => {
  const { writeEntry, readEntry } = await import('./voice-library.js');
  await writeEntry({ ...base, provenance: 'cloned', consent });
  expect((await readEntry('u1'))?.consent?.personName).toBe('Mum');
});
it('accepts a revoke write (revokedAt set) — orthogonal to the guard', async () => {
  const { writeEntry, readEntry } = await import('./voice-library.js');
  await writeEntry({ ...base, provenance: 'cloned', consent });
  await writeEntry({ ...base, provenance: 'cloned', consent: { ...consent, revokedAt: 'now' } });
  expect((await readEntry('u1'))?.consent?.revokedAt).toBe('now');
});
it('does not gate designed entries', async () => {
  const { writeEntry } = await import('./voice-library.js');
  await expect(writeEntry({ ...base, provenance: 'designed' })).resolves.toBeUndefined();
});
