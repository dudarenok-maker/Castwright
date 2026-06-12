/* Integration tests for the voice-match router.

   Sets up a tempdir workspace with two prior confirmed books and exercises
   the scoring matrix from POST /api/books/:bookId/voice-match. Mirrors
   cast-merge.test.ts's lazy-import pattern: WORKSPACE_DIR must be set
   BEFORE workspace/paths.js loads so BOOKS_ROOT captures the tempdir. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let makeBookIdFn: (a: string, s: string, t: string) => string;
/* The "current book" we're analysing. It must be a REAL on-disk book in the
   Keeper series so the (author, series)-scoped matcher resolves its
   series-mates (Book One / Book Two) as eligible candidates. Assigned in
   beforeAll once makeBookId is imported. */
let CURRENT_BOOK_ID: string;

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';

interface PriorCast {
  bookId: string;
  characters: Array<{
    id: string;
    name?: string;
    role?: string;
    voiceId?: string;
    aliases?: string[];
    attributes?: string[];
    gender?: 'male' | 'female' | 'neutral';
    ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  }>;
}

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  cast: PriorCast['characters'],
  castConfirmed: boolean,
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
      castConfirmed,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: cast }));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voice-match-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ voiceMatchRouter }, { makeBookId }] = await Promise.all([
    import('./voice-match.js'),
    import('../workspace/paths.js'),
  ]);
  makeBookIdFn = makeBookId;

  /* Book 1 — confirmed; contains Marlow with an alias and a Wren. */
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    'Book One',
    makeBookId(AUTHOR, SERIES, 'Book One'),
    [
      {
        id: 'marlow',
        name: 'Marlow',
        voiceId: 'v_marlow',
        aliases: ['Sir Singe'],
        attributes: ['playful', 'sarcastic'],
        gender: 'male',
        ageRange: 'teen',
      },
      {
        id: 'wren',
        name: 'Wren Sparrow',
        voiceId: 'v_wren',
        attributes: ['curious', 'brave'],
        gender: 'female',
        ageRange: 'teen',
      },
      /* Same-series narrator — the legitimate reuse target for a later
         Keeper book's narrator. */
      { id: 'narrator', name: 'Narrator', voiceId: 'v_narr_the Hollow Tide', gender: 'neutral' },
    ],
    true,
  );

  /* Book 2 — confirmed; contains a second Marlow with stronger attribute
     overlap, plus a Corvin (no overlap with anything in book-3 requests). */
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    'Book Two',
    makeBookId(AUTHOR, SERIES, 'Book Two'),
    [
      {
        id: 'marlow',
        name: 'Marlow Halden',
        voiceId: 'v_marlow_alt',
        attributes: ['playful', 'rebellious', 'empath'],
        gender: 'male',
        ageRange: 'teen',
      },
      {
        id: 'corvin',
        name: 'Corvin Reeve',
        voiceId: 'v_corvin',
        attributes: ['gruff'],
        gender: 'male',
        ageRange: 'adult',
      },
    ],
    true,
  );

  /* Book 3 — unconfirmed; voices here must NEVER appear in candidates. */
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    'Book Three Unconfirmed',
    makeBookId(AUTHOR, SERIES, 'Book Three Unconfirmed'),
    [{ id: 'brann', name: 'Brann', voiceId: 'v_brann_wip', gender: 'male', ageRange: 'teen' }],
    false,
  );

  /* A DIFFERENT author + series, confirmed, with its own narrator. Every
     book's narrator shares the deterministic id/name "narrator", so a
     library-wide exact-name match would let this unrelated-series narrator
     surface as a candidate for a Keeper book's narrator. It must not. */
  writeBookOnDisk(
    workspaceRoot,
    'Derek Landy',
    'Skulduggery Pleasant',
    'Scepter of the Ancients',
    makeBookId('Derek Landy', 'Skulduggery Pleasant', 'Scepter of the Ancients'),
    [{ id: 'narrator', name: 'Narrator', voiceId: 'v_narr_skul', gender: 'neutral' }],
    true,
  );

  /* The current book being analysed — a real Keeper-series book on disk so the
     (author, series) matcher resolves Book One / Book Two as its series-mates.
     Its own cast is empty (and it's excluded as a self-candidate anyway). */
  CURRENT_BOOK_ID = makeBookId(AUTHOR, SERIES, 'Current Book');
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, 'Current Book', CURRENT_BOOK_ID, [], false);

  app = express();
  app.use(express.json());
  app.use('/api/books', voiceMatchRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callMatch(bookId: string, body: object) {
  return request(app)
    .post(`/api/books/${encodeURIComponent(bookId)}/voice-match`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('voice-match router', () => {
  it('returns empty matches when the library has nothing useful', async () => {
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        {
          id: 'newperson',
          name: 'Some Random Stranger',
          attributes: [],
          gender: 'female',
          ageRange: 'adult',
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.bookId).toBe(CURRENT_BOOK_ID);
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0].characterId).toBe('newperson');
    expect(res.body.matches[0].candidates).toEqual([]);
  });

  it('exact-name hit: Marlow vs library Marlow → name_exact factor, score ≥ 0.9', async () => {
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        {
          id: 'marlow',
          name: 'Marlow',
          attributes: ['playful', 'sarcastic'],
          gender: 'male',
          ageRange: 'teen',
        },
      ],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    expect(m.characterId).toBe('marlow');
    expect(m.candidates.length).toBeGreaterThan(0);
    const top = m.candidates[0];
    expect(top.score).toBeGreaterThanOrEqual(0.9);
    expect(top.factors[0].id).toBe('name_exact');
    /* Top candidate is Book One's Marlow (exact name match wins over token-overlap). */
    expect(top.voiceId).toBe('v_marlow');
    expect(top.fromBookTitle).toBe('Book One');
    /* fromBookId + fromCharacterId carry the library record handle so the
       override endpoint can address it without re-walking the tree. */
    expect(top.fromBookId).toBe(makeBookIdFn(AUTHOR, SERIES, 'Book One'));
    expect(top.fromCharacterId).toBe('marlow');
  });

  it('token-overlap hit: "Marlow Halden" vs library "Marlow" → name_tokens, no name_exact', async () => {
    /* Wipe Book Two's "Marlow Halden" entry to isolate the token-overlap case;
       we want the only library Marlow to be the single-token "Marlow" from Book One. */
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        { id: 'marlow', name: 'Marlow Halden', attributes: [], gender: 'male', ageRange: 'teen' },
      ],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    /* Both "Marlow" (Book One) and "Marlow Halden" (Book Two, exact) appear.
       Pick the candidate that came from Book One — its factor should be name_tokens. */
    const fromBookOne = m.candidates.find(
      (c: { fromBookTitle: string }) => c.fromBookTitle === 'Book One',
    );
    expect(fromBookOne).toBeDefined();
    const ids = fromBookOne!.factors.map((f: { id: string }) => f.id);
    expect(ids).toContain('name_tokens');
    expect(ids).not.toContain('name_exact');
  });

  it('alias hit on the library side: "Sir Singe" → name_exact via library aliases', async () => {
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        {
          id: 'lordSinge',
          name: 'Sir Singe',
          attributes: [],
          gender: 'male',
          ageRange: 'teen',
        },
      ],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    expect(m.candidates.length).toBeGreaterThan(0);
    const top = m.candidates[0];
    expect(top.voiceId).toBe('v_marlow');
    expect(top.factors[0].id).toBe('name_exact');
    expect(top.score).toBeGreaterThanOrEqual(0.9);
  });

  it('floor enforcement: matching gender + age alone does NOT produce a candidate', async () => {
    /* Request Castor — never appears anywhere in the library. Same gender
       and ageRange as the library Wrens / Marlows, but no name overlap.
       Floor (nameScore < 0.34) must drop every library voice. */
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        { id: 'Castor', name: 'Castor', attributes: ['stern'], gender: 'male', ageRange: 'adult' },
      ],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    expect(m.candidates).toEqual([]);
  });

  it('current-book exclusion: a book never matches against its own confirmed cast', async () => {
    /* Call as if we're inside Book One — Book One's Marlow must NOT appear
       in candidates. Book Two's Marlow (exact name match) may. */
    const bookOneId = makeBookIdFn(AUTHOR, SERIES, 'Book One');
    const res = await callMatch(bookOneId, {
      characters: [
        { id: 'marlow', name: 'Marlow', attributes: ['playful'], gender: 'male', ageRange: 'teen' },
      ],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    const voiceIds = m.candidates.map((c: { voiceId: string }) => c.voiceId);
    expect(voiceIds).not.toContain('v_marlow'); // own book excluded
    expect(voiceIds).toContain('v_marlow_alt'); // other book still in
  });

  it('unconfirmed books are excluded from the library', async () => {
    /* Book Three (Brann) is castConfirmed: false. Even an exact-name request
       for Brann must return empty candidates. */
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [{ id: 'brann', name: 'Brann', attributes: [], gender: 'male', ageRange: 'teen' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.matches[0].candidates).toEqual([]);
  });

  it('libraryVoiceIds allow-list restricts candidates to the listed voices', async () => {
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        { id: 'marlow', name: 'Marlow', attributes: [], gender: 'male', ageRange: 'teen' },
      ],
      libraryVoiceIds: ['v_marlow_alt'],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    /* Only v_marlow_alt was allowed; v_marlow (Book One's exact match) is filtered out. */
    const voiceIds = m.candidates.map((c: { voiceId: string }) => c.voiceId);
    expect(voiceIds).toEqual(['v_marlow_alt']);
  });

  it('multiple candidates: exact-name + token-overlap both surface, ranked', async () => {
    /* Request "Marlow Halden" — both Book One ("Marlow", token-overlap) and
       Book Two ("Marlow Halden", exact-name) are library entries. Exact must
       rank above token-overlap. */
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        {
          id: 'marlow',
          name: 'Marlow Halden',
          attributes: ['playful'],
          gender: 'male',
          ageRange: 'teen',
        },
      ],
    });
    expect(res.status).toBe(200);
    const m = res.body.matches[0];
    expect(m.candidates.length).toBeGreaterThanOrEqual(2);
    expect(m.candidates[0].voiceId).toBe('v_marlow_alt'); // Book Two — exact
    expect(m.candidates[0].score).toBeGreaterThan(m.candidates[1].score);
    /* The runner-up is Book One's Marlow (token-overlap). */
    expect(m.candidates[1].voiceId).toBe('v_marlow');
  });

  it('processes every input character, even when some have no candidates', async () => {
    const res = await callMatch(CURRENT_BOOK_ID, {
      characters: [
        { id: 'marlow', name: 'Marlow', attributes: [], gender: 'male', ageRange: 'teen' },
        {
          id: 'nobody',
          name: 'Some Random Stranger',
          attributes: [],
          gender: 'female',
          ageRange: 'adult',
        },
        { id: 'wren', name: 'Wren', attributes: [], gender: 'female', ageRange: 'teen' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.matches.map((m: { characterId: string }) => m.characterId)).toEqual([
      'marlow',
      'nobody',
      'wren',
    ]);
    expect(res.body.matches[0].candidates.length).toBeGreaterThan(0); // marlow matched
    expect(res.body.matches[1].candidates).toEqual([]); // nobody empty
    expect(res.body.matches[2].candidates.length).toBeGreaterThan(0); // wren matched
  });

  it('generic role (narrator) only matches within the same series', async () => {
    /* Call as Book Two (The Hollow Tide). The library holds two
       narrators: Book One's (same series, v_narr_the Hollow Tide) and Scepter of the
       Ancients' (Skulduggery Pleasant, v_narr_skul). Both are an exact
       name match, but a narrator is only legitimately reused within its
       own series — the cross-series one must be excluded. */
    const bookTwoId = makeBookIdFn(AUTHOR, SERIES, 'Book Two');
    const res = await callMatch(bookTwoId, {
      characters: [{ id: 'narrator', name: 'Narrator', attributes: [], gender: 'neutral' }],
    });
    expect(res.status).toBe(200);
    const voiceIds = res.body.matches[0].candidates.map((c: { voiceId: string }) => c.voiceId);
    expect(voiceIds).toContain('v_narr_the Hollow Tide'); // same-series narrator surfaces
    expect(voiceIds).not.toContain('v_narr_skul'); // cross-series narrator excluded
  });

  it('a real named character does NOT match across a different author/series', async () => {
    /* Auto-match is scoped to the current book's same-author + same-series
       mates — for EVERY character, not just generic role-names. A
       Skulduggery-series "Marlow" must NOT grab the Keeper-series Marlow's
       designed voice: an unrelated author's same-named character is a
       coincidence, not a recurring character. (Cross-series reuse stays
       possible as an explicit Voice-library assignment, just never as a
       silent auto-match.) Mirrors the real-world "Pell Hollis" (a Castwright
       standalone) wrongly grabbing "Pell" from Della Renwick's Saltgrave. */
    const scepterId = makeBookIdFn('Derek Landy', 'Skulduggery Pleasant', 'Scepter of the Ancients');
    const res = await callMatch(scepterId, {
      characters: [{ id: 'marlow', name: 'Marlow', attributes: [], gender: 'male', ageRange: 'teen' }],
    });
    expect(res.status).toBe(200);
    const voiceIds = res.body.matches[0].candidates.map((c: { voiceId: string }) => c.voiceId);
    expect(voiceIds).not.toContain('v_marlow'); // cross-author/series named char excluded
  });

  it('a real named character STILL matches a same-series sibling book', async () => {
    /* The scope tightening must not break legitimate within-series reuse:
       calling as Book Three (The Hollow Tide), "Marlow" still
       matches the Keeper-series Marlow designed in Book One / Book Two. */
    const bookThreeId = makeBookIdFn(AUTHOR, SERIES, 'Book Three Unconfirmed');
    const res = await callMatch(bookThreeId, {
      characters: [{ id: 'marlow', name: 'Marlow', attributes: [], gender: 'male', ageRange: 'teen' }],
    });
    expect(res.status).toBe(200);
    const voiceIds = res.body.matches[0].candidates.map((c: { voiceId: string }) => c.voiceId);
    expect(voiceIds.some((v: string) => v === 'v_marlow' || v === 'v_marlow_alt')).toBe(true);
  });
});
