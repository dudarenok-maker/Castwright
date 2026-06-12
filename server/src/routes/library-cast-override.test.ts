/* Integration tests for the library-cast override router.

   Sets up a tempdir workspace with two books that both contain a
   character named "Oduvan". The source book (richer profile — full
   description, attributes, gender, ageRange) is the "current" book the
   user is on; the target book (leaner profile — only name + voiceId) is
   the library record whose profile we want to overwrite. Asserts the
   merge preserves the target's audio identity (id, voiceId, name) while
   pulling source's richer profile into it. Same lazy-import pattern as
   cast-merge.test.ts / voice-match.test.ts so WORKSPACE_DIR is set before
   paths.js binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const NOVELLA = 'Novella';
const FULL_NOVEL = 'Full Novel';

let workspaceRoot: string;
let app: Express;
let novellaBookId: string;
let novelBookId: string;

/* The lean library record: a novella met Oduvan only briefly, so the
   analyzer only nailed down his name + gender. The voiceId is the
   crucial bit — the novella's chapter audio is bound to it and must
   survive the override. */
const leanOduvan = {
  id: 'oduvan',
  name: 'Oduvan',
  role: 'minor character',
  color: 'eliza',
  voiceId: 'v_oduvan_novella',
  gender: 'male',
  lines: 4,
  scenes: 1,
  /* Evidence is per-book — these quotes are from the novella's
     manuscript and must NOT be overwritten by the richer book's quotes,
     which wouldn't resolve against this manuscript. */
  evidence: [{ quote: 'Easy now.', note: 'novella moment' }],
};

/* The rich source: a full novel saw Oduvan across many chapters and
   built a fuller portrait. Slightly different canonical name ("Oduvan
   Heks") — the override should fold the lean target's "Oduvan" form
   into target.aliases so future matches across the series recognise
   either form. */
const richOduvan = {
  id: 'oduvan',
  name: 'Oduvan Heks',
  role: 'Physician',
  color: 'damien',
  voiceId: 'v_oduvan_novel',
  gender: 'male',
  ageRange: 'adult',
  attributes: ['eccentric', 'reassuring', 'humorous'],
  aliases: ['Doc'],
  description: 'The elvin physician at Saltmoor — eccentric, kind, calm under pressure.',
  tone: { warmth: 75, pace: 55, authority: 60 },
  evidence: [{ quote: "I'll have you patched up in no time.", note: 'novel moment' }],
  lines: 208,
  scenes: 7,
};

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-library-override-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ libraryCastOverrideRouter }, { makeBookId }] = await Promise.all([
    import('./library-cast-override.js'),
    import('../workspace/paths.js'),
  ]);
  novellaBookId = makeBookId(AUTHOR, SERIES, NOVELLA);
  novelBookId = makeBookId(AUTHOR, SERIES, FULL_NOVEL);

  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, NOVELLA, novellaBookId, [leanOduvan]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, FULL_NOVEL, novelBookId, [richOduvan]);

  app = express();
  app.use(express.json());
  app.use('/api', libraryCastOverrideRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function readCast(title: string) {
  const path = join(workspaceRoot, 'books', AUTHOR, SERIES, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

function callOverride(body: object) {
  return request(app)
    .post('/api/library-cast/override')
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('library-cast override router', () => {
  it('rejects when any of the four ids are missing', async () => {
    const res = await callOverride({ sourceBookId: novelBookId, sourceCharacterId: 'oduvan' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when source === target', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novelBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book id is unknown', async () => {
    const res = await callOverride({
      sourceBookId: 'nope',
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the source character id is unknown', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'missing',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source character/i);
  });

  it('returns 404 when the target character id is unknown', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it("writes the merged profile to BOTH books while preserving each side's audio identity", async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(200);

    const targetOnDisk = readCast(NOVELLA).characters[0];
    const sourceOnDisk = readCast(FULL_NOVEL).characters[0];

    /* Audio identity preserved per-side — id, voiceId, name, color stay
       with their own book. The novella keeps v_oduvan_novella so its
       chapter audio still plays; the full novel keeps v_oduvan_novel. */
    expect(targetOnDisk.id).toBe('oduvan');
    expect(targetOnDisk.voiceId).toBe('v_oduvan_novella');
    expect(targetOnDisk.name).toBe('Oduvan');
    expect(sourceOnDisk.id).toBe('oduvan');
    expect(sourceOnDisk.voiceId).toBe('v_oduvan_novel');
    expect(sourceOnDisk.name).toBe('Oduvan Heks');

    /* Per-book metrics + per-book evidence don't cross over. */
    expect(targetOnDisk.lines).toBe(4);
    expect(targetOnDisk.scenes).toBe(1);
    expect(targetOnDisk.evidence).toEqual([{ quote: 'Easy now.', note: 'novella moment' }]);
    expect(sourceOnDisk.lines).toBe(208);
    expect(sourceOnDisk.scenes).toBe(7);
    expect(sourceOnDisk.evidence).toEqual([
      { quote: "I'll have you patched up in no time.", note: 'novel moment' },
    ]);

    /* Profile fields — both sides end up identical on the merged
       fields. Longest description wins (source's); attributes unioned;
       tone fields merged; role/gender/ageRange from whichever side has
       a value (source wins on conflict). */
    for (const merged of [targetOnDisk, sourceOnDisk]) {
      expect(merged.description).toBe(richOduvan.description);
      expect(merged.role).toBe('Physician');
      expect(merged.ageRange).toBe('adult');
      expect(merged.gender).toBe('male');
      expect(merged.attributes).toEqual(['eccentric', 'reassuring', 'humorous']);
      expect(merged.tone).toEqual({ warmth: 75, pace: 55, authority: 60 });
    }

    /* Aliases — each side drops its OWN name. The novella's aliases
       include "Oduvan Heks" (source's name) and "Doc" (source's alias).
       The full novel's aliases include "Oduvan" (target's name).
       Neither side self-aliases. */
    const targetAliases = (targetOnDisk.aliases as string[] | undefined) ?? [];
    expect(targetAliases).toContain('Oduvan Heks');
    expect(targetAliases).toContain('Doc');
    expect(targetAliases).not.toContain('Oduvan');

    const sourceAliases = (sourceOnDisk.aliases as string[] | undefined) ?? [];
    expect(sourceAliases).toContain('Oduvan');
    expect(sourceAliases).toContain('Doc');
    expect(sourceAliases).not.toContain('Oduvan Heks');
  });

  it('returns both merged records in the response body', async () => {
    const res = await callOverride({
      sourceBookId: novelBookId,
      sourceCharacterId: 'oduvan',
      targetBookId: novellaBookId,
      targetCharacterId: 'oduvan',
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({
      id: 'oduvan',
      voiceId: 'v_oduvan_novel',
      name: 'Oduvan Heks',
      description: richOduvan.description,
      role: 'Physician',
    });
    expect(res.body.target).toMatchObject({
      id: 'oduvan',
      voiceId: 'v_oduvan_novella',
      name: 'Oduvan',
      description: richOduvan.description,
      role: 'Physician',
    });
  });

  it('keeps the longer description on the source when target has a longer one', async () => {
    /* Edge case: the LIBRARY record's description is longer than the
       current book's. "Longest wins" must keep the longer one on both
       sides — we don't blindly favour the source. Build a fresh book
       pair to exercise this without polluting prior tests. */
    const RICHER_TARGET_TITLE = 'Richer-Target Novella';
    const LEANER_SOURCE_TITLE = 'Leaner-Source Novel';
    const { makeBookId } = await import('../workspace/paths.js');
    const richerTargetId = makeBookId(AUTHOR, SERIES, RICHER_TARGET_TITLE);
    const leanerSourceId = makeBookId(AUTHOR, SERIES, LEANER_SOURCE_TITLE);

    const richerTarget = {
      id: 'Aldous',
      name: 'Aldous',
      role: 'councillor',
      color: 'eliza',
      voiceId: 'v_Aldous_target',
      gender: 'male',
      ageRange: 'adult',
      description:
        'A red-haired councillor with a warm laugh, known for treating Wren like a daughter and for breaking ranks with the Council when conscience demanded it.',
      attributes: ['warm', 'principled'],
      lines: 90,
      scenes: 3,
    };
    const leanerSource = {
      id: 'Aldous',
      name: 'Aldous',
      role: '',
      color: 'eliza',
      voiceId: 'v_Aldous_source',
      gender: 'male',
      description: 'A councillor.',
      lines: 12,
      scenes: 1,
    };
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, RICHER_TARGET_TITLE, richerTargetId, [
      richerTarget,
    ]);
    writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, LEANER_SOURCE_TITLE, leanerSourceId, [
      leanerSource,
    ]);

    const res = await callOverride({
      sourceBookId: leanerSourceId,
      sourceCharacterId: 'Aldous',
      targetBookId: richerTargetId,
      targetCharacterId: 'Aldous',
    });
    expect(res.status).toBe(200);
    /* Target's longer description survived on BOTH sides — the source's
       leaner record now carries the richer description too. */
    expect(res.body.source.description).toBe(richerTarget.description);
    expect(res.body.target.description).toBe(richerTarget.description);
    /* Target's role survived because source didn't have one. */
    expect(res.body.source.role).toBe('councillor');
    /* Identity-only fields source lacked are filled from target. */
    expect(res.body.source.ageRange).toBe('adult');
    /* Attributes unioned (source had none) so both sides get target's. */
    expect(res.body.source.attributes).toEqual(['warm', 'principled']);
  });
});
