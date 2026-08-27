/* #1932 (side-18) — static guard against cross-reference rot.
   A comment alone rots: nothing stops the next person touching Coqui
   residency from deleting one side of the cross-reference between the two
   independent eviction mechanisms (Node's `evictCoquiForQwenPhase` and the
   sidecar's `_idle_evict_steps` `coqui` step) without noticing the other
   side, or the policy doc, still exists. This guard fails loudly if that
   happens: it is a literal marker-presence check, not a source-text
   scanner — it does not parse anything, it greps four files for one token
   and one heading.

   Line numbers are asserted NOWHERE here on purpose: they rot (this repo's
   register row IDs already did, tree-wide), so this guard keys on the
   `COQUI-RESIDENCY-POLICY` token and the doc heading text only. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = 'COQUI-RESIDENCY-POLICY';
const REPO_ROOT = join(process.cwd(), '..');

const SYNTHESISE_CHAPTER_PATH = join(process.cwd(), 'src', 'tts', 'synthesise-chapter.ts');
const SIDECAR_MAIN_PATH = join(process.cwd(), 'tts-sidecar', 'main.py');
const POLICY_DOC_PATH = join(REPO_ROOT, 'docs', 'features', '264-vram-aware-gpu-placement.md');

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('Coqui residency policy cross-references (side-18, #1932)', () => {
  it('keeps the cross-reference in synthesise-chapter.ts (mechanism A)', () => {
    const source = readFileSync(SYNTHESISE_CHAPTER_PATH, 'utf8');
    expect(
      source.includes(TOKEN),
      `the ${TOKEN} cross-reference at synthesise-chapter.ts is gone; the two Coqui ` +
        'eviction mechanisms are documented in docs/features/264-vram-aware-gpu-placement.md ' +
        '— restore the pointer or update the policy',
    ).toBe(true);
  });

  it('keeps both cross-references in main.py (mechanism B)', () => {
    const source = readFileSync(SIDECAR_MAIN_PATH, 'utf8');
    expect(
      occurrences(source, TOKEN),
      `expected 2 occurrences of ${TOKEN} in main.py (maybe_free_idle's docstring and the ` +
        "coqui EvictStep); the two Coqui eviction mechanisms are documented in " +
        'docs/features/264-vram-aware-gpu-placement.md — restore the missing pointer(s) or ' +
        'update the policy',
    ).toBe(2);
  });

  it('keeps the policy section in docs/features/264-vram-aware-gpu-placement.md', () => {
    const doc = readFileSync(POLICY_DOC_PATH, 'utf8');
    expect(
      doc.includes(TOKEN),
      `the ${TOKEN} marker is gone from docs/features/264-vram-aware-gpu-placement.md — the ` +
        'Coqui residency policy section (side-18) has been removed or altered; restore it or ' +
        'update the code-site cross-references that point at it',
    ).toBe(true);
    expect(
      doc.includes('## Coqui residency policy (side-18)'),
      'the "## Coqui residency policy (side-18)" heading is gone from ' +
        'docs/features/264-vram-aware-gpu-placement.md — the two Coqui eviction mechanisms ' +
        '(synthesise-chapter.ts and main.py) cross-reference this section by name',
    ).toBe(true);
  });
});
