/* Source pin (#3427): every write/rm of `<book>/manuscript-edits.json` in
   routes/analysis.ts must stay on the per-path ordered queue. A plain
   `writeJsonAtomic` / bare `rm` at one of these sites passes every behavioural
   test (on success each roll has finished before the terminal write), yet
   re-opens the stale-snapshot-lands-last race this change closed.

   Deliberately syntactic: it classifies each `manuscriptEditsJsonPath(` site by
   the text around it. A site that reaches the path through an intermediate
   variable other than `editsPath` is reported rather than guessed at, so the
   author must extend this pin. The interim rolls live in workspace/edits-roll.ts
   (pinned by edits-roll.test.ts) and never spell this call in analysis.ts. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, 'analysis.ts'), 'utf8');

const SITE_RE = /manuscriptEditsJsonPath\(/g;

/** Returns a description of each site that is not on the ordered queue. */
function unorderedEditsSites(src: string): string[] {
  const bad: string[] = [];
  let sites = 0;
  for (const m of src.matchAll(SITE_RE)) {
    sites += 1;
    const at = m.index ?? 0;
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const before = src.slice(lineStart, at);
    const after = src.slice(at, at + 250);
    const ordered = /\bwriteJsonAtomicOrdered\($/.test(before);
    const queuedRm =
      /\bconst editsPath = $/.test(before) &&
      /\n\s*await enqueuePathOp\(editsPath, \(\) => rm\(editsPath,/.test(after);
    if (!ordered && !queuedRm) {
      bad.push(`offset ${at}: ${src.slice(lineStart, at + 60).trim()}`);
    }
  }
  if (sites === 0) bad.push('no manuscriptEditsJsonPath( sites found — the pin is vacuous');
  return bad;
}

describe('analysis.ts manuscript-edits.json writers stay ordered (#3427)', () => {
  it('every manuscriptEditsJsonPath( site is a writeJsonAtomicOrdered write or an enqueuePathOp rm', () => {
    expect(unorderedEditsSites(SRC)).toEqual([]);
  });

  it('there are the three known sites (two terminal writes + the fresh-run rm)', () => {
    expect([...SRC.matchAll(SITE_RE)].length).toBe(3);
  });

  it('the classifier rejects a plain write and a bare rm (probe)', () => {
    const plain = 'await writeJsonAtomic(manuscriptEditsJsonPath(dir), x);';
    const bareRm = 'const editsPath = manuscriptEditsJsonPath(dir);\nawait rm(editsPath, { force: true });';
    expect(unorderedEditsSites(plain)).toHaveLength(1);
    expect(unorderedEditsSites(bareRm)).toHaveLength(1);
  });
});
