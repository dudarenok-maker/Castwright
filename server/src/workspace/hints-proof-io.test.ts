/* readEditsForHintsCheck / sentencesOf (#3837, plan 290): the edits read both
 * hints-pairing seams share. It never throws: every outcome is a kind, so the
 * pre-leaf seam can fall back to main's rule and the leaf seam can rethrow
 * exactly what readJson throws today. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEditsForHintsCheck, sentencesOf } from './hints-proof-io.js';
import { manuscriptEditsJsonPath } from './paths.js';

let bookDir: string;

beforeEach(async () => {
  bookDir = await mkdtemp(join(tmpdir(), 'hints-proof-io-'));
  await mkdir(join(bookDir, '.audiobook'), { recursive: true });
});

afterEach(async () => {
  await rm(bookDir, { recursive: true, force: true });
});

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('readEditsForHintsCheck', () => {
  it('answers absent when the edits file does not exist', async () => {
    expect(await readEditsForHintsCheck(bookDir)).toEqual({ kind: 'absent' });
  });

  it('answers ok with the parsed value and the sha256 of the bytes read', async () => {
    const bytes = Buffer.from(JSON.stringify({ sentences: [{ chapterId: 1, text: 'Hi.' }] }), 'utf8');
    await writeFile(manuscriptEditsJsonPath(bookDir), bytes);
    const r = await readEditsForHintsCheck(bookDir);
    expect(r).toEqual({
      kind: 'ok',
      value: { sentences: [{ chapterId: 1, text: 'Hi.' }] },
      sha256: sha(bytes),
    });
  });

  it('answers ok for a file with a UTF-8 BOM, as readJson accepts it (M22)', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ sentences: [] }), 'utf8'),
    ]);
    await writeFile(manuscriptEditsJsonPath(bookDir), bytes);
    const r = await readEditsForHintsCheck(bookDir);
    expect(r).toEqual({ kind: 'ok', value: { sentences: [] }, sha256: sha(bytes) });
  });

  it('answers corrupt carrying the SyntaxError', async () => {
    await writeFile(manuscriptEditsJsonPath(bookDir), '{ "sentences": [', 'utf8');
    const r = await readEditsForHintsCheck(bookDir);
    expect(r.kind).toBe('corrupt');
    if (r.kind !== 'corrupt') throw new Error('unreachable');
    expect(r.error).toBeInstanceOf(SyntaxError);
  });

  it('answers unreadable for any other read error (a directory at the path: EISDIR)', async () => {
    await mkdir(manuscriptEditsJsonPath(bookDir));
    const r = await readEditsForHintsCheck(bookDir);
    expect(r.kind).toBe('unreadable');
    if (r.kind !== 'unreadable') throw new Error('unreachable');
    expect((r.error as NodeJS.ErrnoException).code).toBe('EISDIR');
  });
});

describe('sentencesOf', () => {
  it('returns the sentences array', () => {
    const sentences = [{ chapterId: 2, text: 'A line.', vocalization: true }];
    expect(sentencesOf({ sentences })).toEqual(sentences);
  });

  it('returns [] for anything without a sentences array', () => {
    expect(sentencesOf(null)).toEqual([]);
    expect(sentencesOf(undefined)).toEqual([]);
    expect(sentencesOf(42)).toEqual([]);
    expect(sentencesOf('x')).toEqual([]);
    expect(sentencesOf([])).toEqual([]);
    expect(sentencesOf({})).toEqual([]);
    expect(sentencesOf({ sentences: 'nope' })).toEqual([]);
    expect(sentencesOf({ sentences: { 0: { chapterId: 1 } } })).toEqual([]);
  });

  it('drops array entries that are not objects', () => {
    expect(sentencesOf({ sentences: [null, 3, 'x', { chapterId: 1, text: 'Kept.' }] })).toEqual([
      { chapterId: 1, text: 'Kept.' },
    ]);
  });
});
