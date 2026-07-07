/* Integration tests for the voices router — the voice-family aggregation,
   the base-voice catalog endpoint, and the per-cast override write.

   Sets up a tempdir workspace with two books that share a character
   identity (same voiceId across series entries) so the override-write path
   has more than one cast.json to touch. Stubs global fetch so the base-
   voice catalog resolves deterministically. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK_ONE = 'Book One';
const BOOK_TWO = 'Book Two';
/* A SECOND series under the same author, sharing the v_brann voiceId, used
   to prove a series-scoped override only touches the anchor book's
   series (plan 108). */
const OTHER_SERIES = 'The Undertow';
const OTHER_BOOK = 'Other Book';

let workspaceRoot: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let invalidateBaseVoiceCache: () => void;
let applyTierToCastFiles: (
  voiceId: string,
  ttsModelKey: 'qwen3-tts-1.7b' | null,
  seriesFilter?: { author: string; series: string },
) => Promise<number>;

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  isStandalone = false,
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
      isStandalone,
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

function readCastFromDisk(workspace: string, author: string, series: string, title: string) {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

const realFetch = globalThis.fetch;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voices-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ voicesRouter, applyTierToCastFiles: atcf }, paths, baseVoices] = await Promise.all([
    import('./voices.js'),
    import('../workspace/paths.js'),
    import('../tts/base-voices.js'),
  ]);
  applyTierToCastFiles = atcf;
  invalidateBaseVoiceCache = baseVoices.invalidateBaseVoiceCache;
  bookOneId = paths.makeBookId(AUTHOR, SERIES, BOOK_ONE);
  bookTwoId = paths.makeBookId(AUTHOR, SERIES, BOOK_TWO);

  /* Two books in the same series, both with a Brann character sharing
     voiceId 'v_brann'. The aggregator should fold these into one voice
     family; the override-write should touch both cast.json files. */
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE, bookOneId, [
    {
      id: 'char-brann',
      name: 'Brann',
      role: 'protagonist',
      color: 'magenta',
      voiceId: 'v_brann',
      gender: 'male',
      ageRange: 'teen',
      attributes: ['Male', 'Teen'],
      lines: 50,
      scenes: 5,
    },
  ]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO, bookTwoId, [
    {
      id: 'char-brann',
      name: 'Brann',
      role: 'protagonist',
      color: 'magenta',
      voiceId: 'v_brann',
      gender: 'male',
      ageRange: 'teen',
      attributes: ['Male', 'Teen'],
      lines: 80,
      scenes: 7,
    },
  ]);
  /* Third book — DIFFERENT series, same author, same voiceId. A
     series-scoped write anchored on BOOK_ONE must NOT touch this one. */
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    OTHER_SERIES,
    OTHER_BOOK,
    paths.makeBookId(AUTHOR, OTHER_SERIES, OTHER_BOOK),
    [
      {
        id: 'char-brann',
        name: 'Brann',
        role: 'protagonist',
        color: 'magenta',
        voiceId: 'v_brann',
        gender: 'male',
        ageRange: 'teen',
        attributes: ['Male', 'Teen'],
        lines: 10,
        scenes: 1,
      },
    ],
  );

  app = express();
  app.use(express.json());
  app.use('/api/voices', voicesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  invalidateBaseVoiceCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('GET /api/voices — aggregation', () => {
  it('emits bookSeries alongside bookId so the voice-family-grouped UI can nest by series', async () => {
    const res = await request(app).get('/api/voices');
    expect(res.status).toBe(200);
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann).toBeDefined();
    expect(v_brann.bookSeries).toBe(SERIES);
    /* usedIn === 3 — both same-series books plus the cross-series book
       share the same voiceId (the aggregator folds workspace-wide). */
    expect(v_brann.usedIn).toBe(3);
  });

  it('surfaces the character aliases + notLinkedTo on the derived voice (duplicate-detector reload fix)', async () => {
    /* The voices-view cross-book duplicate detector reads these straight
       off the library payload so it can suppress already-resolved pairs on
       the global #/voices tab WITHOUT hydrating any cast (plan 101 fix
       2026-05-26). Mutate the first-seen cast.json for v_brann, assert the
       payload carries both, then restore. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].aliases = ['Wonderboy'];
    cast.characters[0].notLinkedTo = [{ bookId: bookTwoId, characterId: 'char-brann' }];
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann.aliases).toEqual(['Wonderboy']);
    expect(v_brann.notLinkedTo).toEqual([{ bookId: bookTwoId, characterId: 'char-brann' }]);

    /* Restore. */
    delete cast.characters[0].aliases;
    delete cast.characters[0].notLinkedTo;
    writeFileSync(castPath, JSON.stringify(cast));
  });

  it('omits aliases/notLinkedTo when the character has none', async () => {
    const res = await request(app).get('/api/voices');
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann.aliases).toBeUndefined();
    expect(v_brann.notLinkedTo).toBeUndefined();
  });

  it('exposes overrideTtsVoices map when cast.json carries one', async () => {
    /* Quick targeted write — bypass the PUT endpoint to isolate the read side. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoices = { coqui: { name: 'Asya Anara' } };
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann.overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    /* Legacy field projects the active engine's slot for backwards-
       compatible clients. */
    expect(v_brann.overrideTtsVoice).toEqual({ engine: 'coqui', name: 'Asya Anara' });
    /* When override engine matches the (default) Coqui engine, ttsVoice
       must resolve to the override name. */
    expect(v_brann.ttsVoice.name).toBe('Asya Anara');

    /* Reset for the next test. */
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));
  });

  it('migrates legacy singular overrideTtsVoice into the new map on read', async () => {
    /* Regression for the read-time normaliser. cast.json files written
       by older clients carry the singular field; the aggregator must
       transparently treat that as if the map slot were populated. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoice = { engine: 'coqui', name: 'Damien Black' };
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann.overrideTtsVoices).toEqual({ coqui: { name: 'Damien Black' } });
    expect(v_brann.ttsVoice.name).toBe('Damien Black');

    /* Cleanup. */
    delete cast.characters[0].overrideTtsVoice;
    writeFileSync(castPath, JSON.stringify(cast));
  });

  it('keeps a Kokoro override available when the response engine is Coqui', async () => {
    /* Per-engine pluralization: a cast carrying both a Coqui and a
       Kokoro slot must expose both on the response, so the UI tabs
       render correctly. ttsVoice resolves to the engine in the query. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoices = {
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    };
    writeFileSync(castPath, JSON.stringify(cast));

    const coquiRes = await request(app).get('/api/voices?engine=coqui');
    const fromCoqui = coquiRes.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(fromCoqui.ttsVoice.name).toBe('Asya Anara');
    expect(fromCoqui.overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });

    const kokoroRes = await request(app).get('/api/voices?engine=kokoro');
    const fromKokoro = kokoroRes.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(fromKokoro.ttsVoice.name).toBe('am_onyx');
    expect(fromKokoro.overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });

    /* Cleanup. */
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));
  });

  it('surfaces voiceUuid on the derived Voice when the character carries one (srv-43)', async () => {
    /* Fail-before/pass-after regression guard: the aggregator MUST copy
       c.voiceUuid onto the derived Voice so the API contract stays honest.
       Mutate the first-seen cast.json for v_brann, assert the payload
       carries the uuid, then restore. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].voiceUuid = 'U1';
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann.voiceUuid).toBe('U1');

    /* Restore. */
    delete cast.characters[0].voiceUuid;
    writeFileSync(castPath, JSON.stringify(cast));
  });
});

describe('GET /api/voices?engine=qwen — generated flag', () => {
  /* A self-contained Qwen book: three designed-Qwen characters (one with
     rendered audio, one designed-but-unrendered, one with no designed
     voice at all) plus a Coqui-only character. The aggregator should stamp
     `generated:true` ONLY on the voice whose designed voiceId appears in a
     rendered segments snapshot. Lives in its own series so it can't disturb
     the v_brann aggregation/override tests above. */
  const Q_AUTHOR = 'Qwen Author';
  const Q_SERIES = 'Qwen Series';
  const Q_TITLE = 'Qwen Book';
  let sampleCacheDir: string;

  beforeAll(() => {
    const bookDir = join(workspaceRoot, 'books', Q_AUTHOR, Q_SERIES, Q_TITLE);
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'qbook',
        manuscriptId: 'm_qbook',
        title: Q_TITLE,
        author: Q_AUTHOR,
        series: Q_SERIES,
        seriesPosition: null,
        isStandalone: false,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [
          { id: 1, slug: '01-one', title: 'One' },
          { id: 2, slug: '02-two', title: 'Two' },
        ],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'c-oduvan',
            name: 'Oduvan',
            voiceId: 'v_oduvan',
            ttsEngine: 'qwen',
            overrideTtsVoices: { qwen: { name: 'qwen-v_oduvan' } },
            attributes: [],
            lines: 10,
            scenes: 1,
          },
          {
            id: 'c-marlow',
            name: 'Marlow',
            voiceId: 'v_marlow',
            ttsEngine: 'qwen',
            overrideTtsVoices: { qwen: { name: 'qwen-v_marlow' } },
            attributes: [],
            lines: 10,
            scenes: 1,
          },
          {
            id: 'c-bo',
            name: 'Fenn',
            voiceId: 'v_fenn',
            ttsEngine: 'qwen',
            attributes: [],
            lines: 5,
            scenes: 1,
          },
          {
            id: 'c-marcus',
            name: 'Marcus',
            voiceId: 'v_marcus',
            overrideTtsVoices: { coqui: { name: 'Asya Anara' } },
            attributes: [],
            lines: 5,
            scenes: 1,
          },
        ],
      }),
    );
    /* Only chapter 1 rendered, and only Oduvan's bespoke voice appears in
       its snapshot. Marlow is designed but never rendered. */
    writeFileSync(
      join(bookDir, 'audio', '01-one.segments.json'),
      JSON.stringify({
        bookId: 'qbook',
        chapterId: 1,
        chapterTitle: 'One',
        synthesizedAt: new Date().toISOString(),
        segments: [],
        characterSnapshots: {
          'c-oduvan': { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-v_oduvan' },
        },
      }),
    );

    /* Point the voice-sample cache at a temp dir and drop a Marlow audition
       (`<scope>-qwen3-tts-0.6b-<hash>.mp3`, scope = voiceId v_marlow) so the
       aggregator stamps `sampled` on Marlow — designed + auditioned but never
       rendered. No file for Bo/Marcus → they stay un-sampled. */
    sampleCacheDir = join(workspaceRoot, 'sample-cache');
    mkdirSync(sampleCacheDir, { recursive: true });
    process.env.VOICE_SAMPLE_AUDIO_DIR = sampleCacheDir;
    writeFileSync(join(sampleCacheDir, 'v_marlow-qwen3-tts-0.6b-deadbeef.mp3'), 'fake-mp3');
  });

  afterAll(() => {
    delete process.env.VOICE_SAMPLE_AUDIO_DIR;
  });

  it('marks a designed Qwen voice generated when it appears in a rendered snapshot', async () => {
    const res = await request(app).get('/api/voices?engine=qwen');
    expect(res.status).toBe(200);
    const oduvan = res.body.voices.find((v: { id: string }) => v.id === 'v_oduvan');
    expect(oduvan.ttsVoice.name).toBe('qwen-v_oduvan');
    expect(oduvan.generated).toBe(true);
  });

  it('leaves a designed-but-unrendered Qwen voice without the generated flag', async () => {
    const res = await request(app).get('/api/voices?engine=qwen');
    const marlow = res.body.voices.find((v: { id: string }) => v.id === 'v_marlow');
    expect(marlow.ttsVoice.name).toBe('qwen-v_marlow');
    expect(marlow.generated).toBeFalsy();
  });

  it('never stamps generated on a voice with no designed Qwen voiceId', async () => {
    const res = await request(app).get('/api/voices?engine=qwen');
    const bo = res.body.voices.find((v: { id: string }) => v.id === 'v_fenn');
    expect(bo.ttsVoice.name).toBe(''); // no qwen override → undesigned
    expect(bo.generated).toBeFalsy();
  });

  it('does not scan segments (no generated flag) when the engine is not Qwen', async () => {
    /* Preset path must stay untouched — the segments scan only runs for the
       Qwen engine query, so even the rendered Oduvan voice carries no flag. */
    const res = await request(app).get('/api/voices?engine=coqui');
    const oduvan = res.body.voices.find((v: { id: string }) => v.id === 'v_oduvan');
    expect(oduvan.generated).toBeUndefined();
  });

  it('marks a designed Qwen voice sampled when a cached audition exists (not yet generated)', async () => {
    const res = await request(app).get('/api/voices?engine=qwen');
    const marlow = res.body.voices.find((v: { id: string }) => v.id === 'v_marlow');
    expect(marlow.sampled).toBe(true);
    expect(marlow.generated).toBeFalsy(); // sampled is the tier below generated
  });

  it('leaves a designed Qwen voice with no cached audition un-sampled', async () => {
    /* Bo is undesigned and Marcus is Coqui — but more directly: no
       `v_fenn`/`v_marcus` sample file was dropped, so neither is sampled. */
    const res = await request(app).get('/api/voices?engine=qwen');
    const bo = res.body.voices.find((v: { id: string }) => v.id === 'v_fenn');
    expect(bo.sampled).toBeFalsy();
  });

  it('does not stamp sampled when the engine is not Qwen', async () => {
    /* The sample-cache scan only runs for the Qwen engine query — the preset
       path stays byte-for-byte unchanged even though a v_marlow audition file
       exists on disk. */
    const res = await request(app).get('/api/voices?engine=coqui');
    const marlow = res.body.voices.find((v: { id: string }) => v.id === 'v_marlow');
    expect(marlow.sampled).toBeUndefined();
  });

  it('srv-43 Wave 2: emits human display name (qwen-<voiceId>) and keeps generated flag keyed on storage key (qwen-<uuid>)', async () => {
    /* Fail-before/pass-after for the display-name / generated-flag split.
       A character carries BOTH a voiceId ('wren') AND a voiceUuid ('ABC123'),
       so the storage key is qwen-ABC123 while the human display is qwen-wren.
       The segment snapshot uses the STORAGE key — the aggregator must emit the
       human name on ttsVoice.name AND still resolve generated:true by looking
       up the storage key in renderedQwenNames. */
    const bookDir = join(workspaceRoot, 'books', Q_AUTHOR, Q_SERIES, Q_TITLE);

    /* Add a uuid-bearing character to the Qwen book's cast. */
    const castPath = join(bookDir, '.audiobook', 'cast.json');
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters.push({
      id: 'c-wren',
      name: 'Wren',
      voiceId: 'wren',
      voiceUuid: 'ABC123',
      ttsEngine: 'qwen',
      /* The override name is the STORAGE key (qwen-<uuid>), as written by
         srv-43's qwen-voice route after a design session. */
      overrideTtsVoices: { qwen: { name: 'qwen-ABC123' } },
      attributes: [],
      lines: 3,
      scenes: 1,
    });
    writeFileSync(castPath, JSON.stringify(cast));

    /* Add a rendered segment snapshot using the STORAGE key (qwen-ABC123). */
    const segPath = join(bookDir, 'audio', '02-two.segments.json');
    writeFileSync(
      segPath,
      JSON.stringify({
        bookId: 'qbook',
        chapterId: 2,
        chapterTitle: 'Two',
        synthesizedAt: new Date().toISOString(),
        segments: [],
        characterSnapshots: {
          'c-wren': { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ABC123' },
        },
      }),
    );

    const res = await request(app).get('/api/voices?engine=qwen');
    expect(res.status).toBe(200);
    const wren = res.body.voices.find((v: { id: string }) => v.id === 'wren');
    expect(wren).toBeDefined();
    /* Display name must be the HUMAN form (qwen-<voiceId>), not the storage key. */
    expect(wren.ttsVoice.name).toBe('qwen-wren');
    /* Generated flag must be true even though ttsVoice.name !== the snapshot key. */
    expect(wren.generated).toBe(true);

    /* Cleanup: remove the added character and the chapter-2 snapshot. */
    cast.characters.pop();
    writeFileSync(castPath, JSON.stringify(cast));
    const { rmSync: rmFile } = await import('node:fs');
    rmFile(segPath);
  });
});

describe('GET /api/voices — languageCode on designed Qwen voices', () => {
  /* A designed Qwen voice whose sidecar manifest carries `language: "Russian"`
     must surface `languageCode: "ru"` on the derived voice. A preset voice
     (no qwen override, no manifest) must omit `languageCode` entirely.
     Uses the v_oduvan character from the Qwen series above (already in the
     workspace) — no new books required. */

  let qwenVoicesPath: string;

  beforeAll(async () => {
    const [{ qwenVoiceSidecarPath: sidecarPath }, { dirname }] = await Promise.all([
      import('../workspace/paths.js'),
      import('node:path'),
    ]);
    /* Oduvan's storage key (no uuid) → qwen-v_oduvan. */
    qwenVoicesPath = sidecarPath('qwen-v_oduvan');
    mkdirSync(dirname(qwenVoicesPath), { recursive: true });
    /* Write a manifest with Russian as the baked language. */
    writeFileSync(qwenVoicesPath, JSON.stringify({ voiceId: 'qwen-v_oduvan', instruct: 'persona', language: 'Russian' }));
  });

  afterAll(() => {
    rmSync(qwenVoicesPath, { force: true });
  });

  it('surfaces languageCode ru on a Russian-designed Qwen voice', async () => {
    const res = await request(app).get('/api/voices?engine=qwen');
    expect(res.status).toBe(200);
    const oduvan = res.body.voices.find((v: { id: string }) => v.id === 'v_oduvan');
    expect(oduvan).toBeDefined();
    expect(oduvan.languageCode).toBe('ru');
  });

  it('omits languageCode on a preset (non-Qwen-designed) voice', async () => {
    const res = await request(app).get('/api/voices');
    const v_brann = res.body.voices.find((v: { id: string }) => v.id === 'v_brann');
    expect(v_brann).toBeDefined();
    expect(v_brann.languageCode).toBeUndefined();
  });
});

describe('GET /api/voices — cross-book identity collision on a shared, no-voiceId id', () => {
  /* Real-world bug: the analyzer assigns the SAME literal id ('narrator',
     'unknown-male', 'unknown-female') to every book's narrator / auto-folded
     background-bucket character, and — unlike a deliberately reused voice —
     these never get an explicit `voiceId` (only a per-book `voiceUuid`).
     aggregateVoices used to key its workspace-wide fold on `c.voiceId ?? c.id`,
     so two totally unrelated standalone books both landed in the SAME
     acc-map slot purely by id coincidence, and one book's `generated` /
     `languageCode` / `voiceUuid` bled into the other's.

     Two standalone books, unrelated authors, both with a 'narrator' Qwen
     character and NO voiceId:
       - Alpha (English): rendered chapter 1 — narrator IS generated.
       - Beta (Russian): designed but never rendered — narrator is NOT
         generated.
     Querying with each book as currentBookId must return THAT book's own
     narrator (own languageCode, own voiceUuid, own generated status,
     usedIn:1) — never the other book's. */
  const ALPHA_AUTHOR = 'Alpha Author';
  const ALPHA_TITLE = 'Alpha Book';
  const BETA_AUTHOR = 'Beta Author';
  const BETA_TITLE = 'Beta Book';
  let alphaBookId: string;
  let betaBookId: string;

  let alphaManifestPath: string;
  let betaManifestPath: string;

  beforeAll(async () => {
    const [{ makeBookId, qwenVoiceSidecarPath }, { dirname }] = await Promise.all([
      import('../workspace/paths.js'),
      import('node:path'),
    ]);
    alphaBookId = makeBookId(ALPHA_AUTHOR, 'Standalones', ALPHA_TITLE);
    betaBookId = makeBookId(BETA_AUTHOR, 'Standalones', BETA_TITLE);

    const alphaDir = writeBookOnDisk(
      workspaceRoot,
      ALPHA_AUTHOR,
      'Standalones',
      ALPHA_TITLE,
      alphaBookId,
      [
        {
          id: 'narrator',
          name: 'Narrator',
          voiceUuid: 'ALPHAUUID1',
          ttsEngine: 'qwen',
          overrideTtsVoices: { qwen: { name: 'qwen-ALPHAUUID1' } },
          attributes: [],
          lines: 100,
          scenes: 1,
        },
      ],
      true,
    );
    /* Give Alpha a chapter and a rendered segments snapshot so its narrator
       is genuinely `generated`. writeBookOnDisk seeds state.json with an
       empty chapters array — rewrite it with one chapter. */
    const alphaStatePath = join(alphaDir, '.audiobook', 'state.json');
    const alphaState = JSON.parse(readFileSync(alphaStatePath, 'utf8'));
    alphaState.chapters = [{ id: 1, slug: '01-one', title: 'One' }];
    writeFileSync(alphaStatePath, JSON.stringify(alphaState));
    mkdirSync(join(alphaDir, 'audio'), { recursive: true });
    writeFileSync(
      join(alphaDir, 'audio', '01-one.segments.json'),
      JSON.stringify({
        bookId: alphaBookId,
        chapterId: 1,
        chapterTitle: 'One',
        synthesizedAt: new Date().toISOString(),
        segments: [],
        characterSnapshots: {
          narrator: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-ALPHAUUID1' },
        },
      }),
    );
    alphaManifestPath = qwenVoiceSidecarPath('qwen-ALPHAUUID1');
    mkdirSync(dirname(alphaManifestPath), { recursive: true });
    writeFileSync(alphaManifestPath, JSON.stringify({ language: 'English' }));

    writeBookOnDisk(
      workspaceRoot,
      BETA_AUTHOR,
      'Standalones',
      BETA_TITLE,
      betaBookId,
      [
        {
          id: 'narrator',
          name: 'Рассказчик',
          voiceUuid: 'BETAUUID1',
          ttsEngine: 'qwen',
          overrideTtsVoices: { qwen: { name: 'qwen-BETAUUID1' } },
          attributes: [],
          lines: 200,
          scenes: 1,
        },
      ],
      true,
    );
    betaManifestPath = qwenVoiceSidecarPath('qwen-BETAUUID1');
    mkdirSync(dirname(betaManifestPath), { recursive: true });
    writeFileSync(betaManifestPath, JSON.stringify({ language: 'Russian' }));
  });

  afterAll(() => {
    rmSync(alphaManifestPath, { force: true });
    rmSync(betaManifestPath, { force: true });
  });

  it("Alpha's own render status/language never bleeds onto Beta", async () => {
    const res = await request(app).get(`/api/voices?engine=qwen&currentBookId=${betaBookId}`);
    expect(res.status).toBe(200);
    const narrator = res.body.voices.find(
      (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === betaBookId,
    );
    expect(narrator).toBeDefined();
    expect(narrator.voiceUuid).toBe('BETAUUID1');
    expect(narrator.languageCode).toBe('ru');
    expect(narrator.generated).toBeFalsy();
    expect(narrator.usedIn).toBe(1);
  });

  it("Beta's own (unrendered) status never suppresses Alpha's real generated flag", async () => {
    const res = await request(app).get(`/api/voices?engine=qwen&currentBookId=${alphaBookId}`);
    expect(res.status).toBe(200);
    const narrator = res.body.voices.find(
      (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === alphaBookId,
    );
    expect(narrator).toBeDefined();
    expect(narrator.voiceUuid).toBe('ALPHAUUID1');
    expect(narrator.languageCode).toBe('en');
    expect(narrator.generated).toBe(true);
    expect(narrator.usedIn).toBe(1);
  });

  it('emits distinct familyKey values for two unrelated books sharing a bare id', async () => {
    const res = await request(app).get(`/api/voices?engine=qwen&currentBookId=${betaBookId}`);
    const alpha = res.body.voices.find(
      (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === alphaBookId,
    );
    const beta = res.body.voices.find(
      (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === betaBookId,
    );
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha.familyKey).toBeTruthy();
    expect(beta.familyKey).toBeTruthy();
    expect(alpha.familyKey).not.toBe(beta.familyKey);
  });

  it("pinning Alpha's narrator (by familyKey) never pins Beta's unrelated same-id narrator", async () => {
    const before = await request(app).get(`/api/voices?engine=qwen&currentBookId=${betaBookId}`);
    const alpha = before.body.voices.find(
      (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === alphaBookId,
    );
    try {
      const pinRes = await request(app)
        .put(`/api/voices/${encodeURIComponent(alpha.familyKey)}/pin`)
        .send({ pinned: true });
      expect(pinRes.status).toBe(204);

      const after = await request(app).get(`/api/voices?engine=qwen&currentBookId=${betaBookId}`);
      const alphaAfter = after.body.voices.find(
        (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === alphaBookId,
      );
      const betaAfter = after.body.voices.find(
        (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === betaBookId,
      );
      expect(alphaAfter.pinned).toBe(true);
      expect(betaAfter.pinned).toBeFalsy();
    } finally {
      await request(app)
        .put(`/api/voices/${encodeURIComponent(alpha.familyKey)}/pin`)
        .send({ pinned: false });
    }
  });

  it("a legacy bare-id pin (set before the familyKey migration) still surfaces as pinned, not silently lost", async () => {
    /* voices.json's `pinned` array is workspace-global and never rewritten
       on upgrade. A pin set before this fix stored the bare id ('narrator')
       — the only scheme that existed then. Simulate that by writing it
       directly (bypassing the PUT route, which now only ever writes
       familyKey values), then confirm the read side's legacy fallback
       still honours it instead of the pin silently vanishing. */
    const [{ voicesMetaPath }, { writeJsonAtomic }] = await Promise.all([
      import('../workspace/paths.js'),
      import('../workspace/state-io.js'),
    ]);
    try {
      await writeJsonAtomic(voicesMetaPath(), {
        pinned: ['narrator'],
        updatedAt: new Date().toISOString(),
      });
      const res = await request(app).get(`/api/voices?engine=qwen&currentBookId=${alphaBookId}`);
      const alpha = res.body.voices.find(
        (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === alphaBookId,
      );
      expect(alpha.pinned).toBe(true);
    } finally {
      await writeJsonAtomic(voicesMetaPath(), { pinned: [], updatedAt: new Date().toISOString() });
    }
  });

  it("bug #1411: Alpha's cached sample audition never marks Beta's un-sampled narrator as Sampled", async () => {
    /* Both narrators are voiceId-less, so the sample-cache scope falls back
       to `char-<id>` — bare, unscoped by book (unlike familyKey above, which
       IS book-scoped since #1410). A stray `char-narrator-*.mp3` dropped by
       Alpha's real audition matches Beta's `hasCachedQwenSample` prefix
       check too, purely because the workspace-global sample cache has no
       book boundary. */
    const sampleCacheDir = join(workspaceRoot, 'sample-cache-cross-book-1411');
    mkdirSync(sampleCacheDir, { recursive: true });
    process.env.VOICE_SAMPLE_AUDIO_DIR = sampleCacheDir;
    try {
      writeFileSync(join(sampleCacheDir, 'char-narrator-qwen3-tts-0.6b-deadbeef.mp3'), 'fake-mp3');
      const res = await request(app).get(`/api/voices?engine=qwen&currentBookId=${betaBookId}`);
      const beta = res.body.voices.find(
        (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === betaBookId,
      );
      expect(beta).toBeDefined();
      expect(beta.sampled).toBeFalsy();
    } finally {
      rmSync(sampleCacheDir, { recursive: true, force: true });
      delete process.env.VOICE_SAMPLE_AUDIO_DIR;
    }
  });

  it('bug #1411: Alpha IS sampled from its own book-scoped cache file', async () => {
    const sampleCacheDir = join(workspaceRoot, 'sample-cache-cross-book-1411-own');
    mkdirSync(sampleCacheDir, { recursive: true });
    process.env.VOICE_SAMPLE_AUDIO_DIR = sampleCacheDir;
    try {
      writeFileSync(
        join(sampleCacheDir, `char-${alphaBookId}__narrator-qwen3-tts-0.6b-deadbeef.mp3`),
        'fake-mp3',
      );
      const res = await request(app).get(`/api/voices?engine=qwen&currentBookId=${alphaBookId}`);
      const alpha = res.body.voices.find(
        (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === alphaBookId,
      );
      const betaRes = await request(app).get(
        `/api/voices?engine=qwen&currentBookId=${betaBookId}`,
      );
      const beta = betaRes.body.voices.find(
        (v: { id: string; bookId: string }) => v.id === 'narrator' && v.bookId === betaBookId,
      );
      expect(alpha.sampled).toBe(true);
      expect(beta.sampled).toBeFalsy();
    } finally {
      rmSync(sampleCacheDir, { recursive: true, force: true });
      delete process.env.VOICE_SAMPLE_AUDIO_DIR;
    }
  });
});

describe('GET /api/voices?currentBookId — inCurrentSeries scoping', () => {
  /* A self-contained author with: a two-book series (Trilogy), a same-author
     spinoff in a DIFFERENT series, and a standalone. Distinct voiceIds per
     book so each voice's source/inCurrentSeries can be asserted cleanly,
     independent of the v_brann aggregation above. The "Series" tab in the
     cast view filters on `inCurrentSeries`, so a standalone's tab must come
     up empty and a series book's tab must show only its own series' siblings
     — not every other book in the workspace. */
  const C_AUTHOR = 'Coast Author';
  const C_SERIES = 'Trilogy';
  const C_SPINOFF_SERIES = 'Spinoff Series';
  let bookAId: string;
  let bookBId: string;
  let spinoffId: string;
  let standaloneId: string;

  beforeAll(async () => {
    const paths = await import('../workspace/paths.js');
    bookAId = paths.makeBookId(C_AUTHOR, C_SERIES, 'Book A');
    bookBId = paths.makeBookId(C_AUTHOR, C_SERIES, 'Book B');
    spinoffId = paths.makeBookId(C_AUTHOR, C_SPINOFF_SERIES, 'Spinoff');
    standaloneId = paths.makeBookId(C_AUTHOR, 'Standalones', 'Lone Tale');
    const mkChar = (id: string, name: string, voiceId: string) => ({
      id,
      name,
      role: 'role',
      color: 'magenta',
      voiceId,
      gender: 'female',
      ageRange: 'adult',
      attributes: ['Female'],
      lines: 10,
      scenes: 1,
    });
    writeBookOnDisk(workspaceRoot, C_AUTHOR, C_SERIES, 'Book A', bookAId, [
      mkChar('char-alpha', 'Alpha', 'v_alpha'),
    ]);
    writeBookOnDisk(workspaceRoot, C_AUTHOR, C_SERIES, 'Book B', bookBId, [
      mkChar('char-beta', 'Beta', 'v_beta'),
    ]);
    writeBookOnDisk(workspaceRoot, C_AUTHOR, C_SPINOFF_SERIES, 'Spinoff', spinoffId, [
      mkChar('char-gamma', 'Gamma', 'v_gamma'),
    ]);
    writeBookOnDisk(
      workspaceRoot,
      C_AUTHOR,
      'Standalones',
      'Lone Tale',
      standaloneId,
      [mkChar('char-lone', 'Lone', 'v_lone')],
      true /* isStandalone */,
    );
  });

  const find = (voices: Array<{ id: string }>, id: string) =>
    voices.find((v) => v.id === id) as
      | { id: string; source: string; inCurrentSeries?: boolean }
      | undefined;

  it('flags a sibling-series voice inCurrentSeries when a series book is open', async () => {
    const res = await request(app).get(`/api/voices?currentBookId=${bookAId}`);
    expect(res.status).toBe(200);
    const beta = find(res.body.voices, 'v_beta');
    expect(beta).toBeDefined();
    /* Beta lives only in the sibling Book B — not the open book — so it's a
       library voice, but it IS in the open book's series. */
    expect(beta!.source).toBe('library');
    expect(beta!.inCurrentSeries).toBe(true);
    /* The open book's own voice is 'current'. */
    expect(find(res.body.voices, 'v_alpha')!.source).toBe('current');
  });

  it('does NOT flag a same-author different-series voice as inCurrentSeries', async () => {
    const res = await request(app).get(`/api/voices?currentBookId=${bookAId}`);
    const gamma = find(res.body.voices, 'v_gamma');
    expect(gamma!.source).toBe('library');
    /* Same author, different series → must stay out of the Series tab. */
    expect(gamma!.inCurrentSeries).toBeFalsy();
  });

  it('flags no voice inCurrentSeries when the open book is a standalone', async () => {
    const res = await request(app).get(`/api/voices?currentBookId=${standaloneId}`);
    expect(res.status).toBe(200);
    /* Sibling-series voices exist in the workspace, but the open standalone
       has no series, so the cast view's Series tab must come up empty. */
    expect(find(res.body.voices, 'v_beta')!.inCurrentSeries).toBeFalsy();
    expect(find(res.body.voices, 'v_alpha')!.inCurrentSeries).toBeFalsy();
    /* The standalone's own voice is still 'current'. */
    expect(find(res.body.voices, 'v_lone')!.source).toBe('current');
  });

  it('flags no voice inCurrentSeries when no book is open', async () => {
    const res = await request(app).get('/api/voices');
    expect(find(res.body.voices, 'v_beta')!.inCurrentSeries).toBeFalsy();
  });
});

describe('PUT /api/voices/:voiceId/override', () => {
  it('writes the override into overrideTtsVoices[engine] across every cast.json sharing the voiceId', async () => {
    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    expect(res.status).toBe(204);

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    expect(two.characters[0].overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    /* Legacy singular field must be removed on write so the cast.json
       has a single source of truth. */
    expect(one.characters[0].overrideTtsVoice).toBeUndefined();
    expect(two.characters[0].overrideTtsVoice).toBeUndefined();
  });

  it('pins ttsEngine to the override engine across the series (plan 108 — fixes wrong model in other books)', async () => {
    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_brann' } });
    expect(res.status).toBe(204);

    /* Setting a Qwen voice override switches the character TO Qwen everywhere
       the voiceId appears — otherwise the voice slot propagates but the active
       engine stays wrong in books the approve's redux mirror never touched. */
    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].ttsEngine).toBe('qwen');
    expect(two.characters[0].ttsEngine).toBe('qwen');

    /* Cleanup — this describe accumulates state across tests; drop the slot we
       added so the following slot-merge test starts from a known shape. */
    await request(app).put('/api/voices/v_brann/override').send({ override: null });
  });

  it('preserves other engine slots when updating one engine', async () => {
    /* The per-engine map's whole point: setting the Coqui slot must not
       wipe a previously-set Kokoro slot. */
    await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'kokoro', name: 'am_onyx' } });
    await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    expect(one.characters[0].overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });

    /* Cleanup. */
    await request(app).put('/api/voices/v_brann/override').send({ override: null });
  });

  it('migrates legacy overrideTtsVoice on the first write that touches the cast', async () => {
    /* User flow: cast.json was written by an older client (legacy field),
       user opens the profile drawer and pins a Coqui voice → the write
       path normalises the legacy field into the map and removes it. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoice = { engine: 'kokoro', name: 'am_michael' };
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));

    await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });

    const after = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    /* Both engines now in the map, legacy field gone. */
    expect(after.characters[0].overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_michael' },
    });
    expect(after.characters[0].overrideTtsVoice).toBeUndefined();

    /* Cleanup. */
    await request(app).put('/api/voices/v_brann/override').send({ override: null });
  });

  it('clears every engine slot when override is null', async () => {
    await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'kokoro', name: 'am_onyx' } });
    const clear = await request(app).put('/api/voices/v_brann/override').send({ override: null });
    expect(clear.status).toBe(204);

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoices).toBeUndefined();
    expect(two.characters[0].overrideTtsVoices).toBeUndefined();
    expect(one.characters[0].overrideTtsVoice).toBeUndefined();
    expect(two.characters[0].overrideTtsVoice).toBeUndefined();
  });

  it('preserves voiceUuid on both linked characters after an override-save (srv-43 regression guard)', async () => {
    /* The spread inside applyOverrideToCastFiles ({ ...normalised }) must carry
       voiceUuid forward; this test pins that invariant so a future allowlist
       rewrite cannot silently drop it. Both characters share voiceId v_brann and
       already carry voiceUuid 'U1' on disk. */
    const castPathOne = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_ONE, '.audiobook', 'cast.json');
    const castPathTwo = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_TWO, '.audiobook', 'cast.json');
    const castOne = JSON.parse(readFileSync(castPathOne, 'utf8')) as { characters: Array<Record<string, unknown>> };
    const castTwo = JSON.parse(readFileSync(castPathTwo, 'utf8')) as { characters: Array<Record<string, unknown>> };
    castOne.characters[0].voiceUuid = 'U1';
    castTwo.characters[0].voiceUuid = 'U1';
    writeFileSync(castPathOne, JSON.stringify(castOne));
    writeFileSync(castPathTwo, JSON.stringify(castTwo));

    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-wren' } });
    expect(res.status).toBe(204);

    const afterOne = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const afterTwo = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(afterOne.characters[0].voiceUuid).toBe('U1');
    expect(afterTwo.characters[0].voiceUuid).toBe('U1');

    /* Cleanup. */
    delete castOne.characters[0].voiceUuid;
    delete castTwo.characters[0].voiceUuid;
    writeFileSync(castPathOne, JSON.stringify(castOne));
    writeFileSync(castPathTwo, JSON.stringify(castTwo));
    await request(app).put('/api/voices/v_brann/override').send({ override: null });
  });

  it('400 when override body is malformed', async () => {
    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'nope', name: 'Asya Anara' } });
    expect(res.status).toBe(400);
  });

  it('404 when no character carries the voiceId', async () => {
    const res = await request(app)
      .put('/api/voices/v_does_not_exist/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/voices/:voiceId/override — series scope (plan 108)', () => {
  afterEach(async () => {
    /* Clear all three casts between cases so the cross-series assertions
       start clean. */
    await request(app).put('/api/voices/v_brann/override').send({ override: null });
    const otherPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      OTHER_SERIES,
      OTHER_BOOK,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(otherPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(otherPath, JSON.stringify(cast));
  });

  it("writes ONLY to the anchor book's series, leaving other series untouched", async () => {
    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({
        override: { engine: 'qwen', name: 'qwen-v_brann' },
        scope: 'series',
        bookId: bookOneId,
      });
    expect(res.status).toBe(204);

    /* Both same-series books got the Qwen designed voiceId. */
    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-v_brann' } });
    expect(two.characters[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-v_brann' } });

    /* The cross-series book did NOT change. */
    const other = readCastFromDisk(workspaceRoot, AUTHOR, OTHER_SERIES, OTHER_BOOK);
    expect(other.characters[0].overrideTtsVoices).toBeUndefined();
  });

  it('defaults to a workspace-wide write when no scope is passed', async () => {
    await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_brann' } });
    /* All three books — including the cross-series one — get the override. */
    const other = readCastFromDisk(workspaceRoot, AUTHOR, OTHER_SERIES, OTHER_BOOK);
    expect(other.characters[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-v_brann' } });
  });

  it("400s when scope is 'series' but bookId is missing", async () => {
    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_brann' }, scope: 'series' });
    expect(res.status).toBe(400);
  });

  it('404s when the series-anchor bookId is unknown', async () => {
    const res = await request(app)
      .put('/api/voices/v_brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_brann' }, scope: 'series', bookId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/voices/base', () => {
  function mockSpeakersResponse(speakers: string[]) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (target.endsWith('/speakers')) {
        return new Response(JSON.stringify({ coqui: speakers }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('merges sidecar /speakers (Coqui) with the static Gemini catalog', async () => {
    mockSpeakersResponse(['Asya Anara', 'Damien Black']);
    const res = await request(app).get('/api/voices/base');
    expect(res.status).toBe(200);
    const names = res.body.voices as Array<{ engine: string; name: string }>;
    const coqui = names.filter((v) => v.engine === 'coqui').map((v) => v.name);
    const gemini = names.filter((v) => v.engine === 'gemini').map((v) => v.name);
    expect(coqui).toContain('Asya Anara');
    expect(coqui).toContain('Damien Black');
    expect(gemini).toContain('Charon');
    expect(gemini.length).toBeGreaterThanOrEqual(30);
  });
});

describe('applyTierToCastFiles', () => {
  afterEach(async () => {
    /* Clear ttsModelKey from all books between cases so assertions start clean. */
    await applyTierToCastFiles('v_brann', null);
  });

  it('pins ttsModelKey across sibling books in the series', async () => {
    const n = await applyTierToCastFiles('v_brann', 'qwen3-tts-1.7b', {
      author: AUTHOR,
      series: SERIES,
    });
    expect(n).toBe(2);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(two.characters[0].ttsModelKey).toBe('qwen3-tts-1.7b');
  });

  it('clears ttsModelKey when passed null', async () => {
    await applyTierToCastFiles('v_brann', 'qwen3-tts-1.7b', { author: AUTHOR, series: SERIES });
    const n = await applyTierToCastFiles('v_brann', null, { author: AUTHOR, series: SERIES });
    expect(n).toBe(2);
    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    expect(one.characters[0].ttsModelKey).toBeUndefined();
  });

  it('does not touch other-series books when seriesFilter is provided', async () => {
    await applyTierToCastFiles('v_brann', 'qwen3-tts-1.7b', { author: AUTHOR, series: SERIES });
    const other = readCastFromDisk(workspaceRoot, AUTHOR, OTHER_SERIES, OTHER_BOOK);
    expect(other.characters[0].ttsModelKey).toBeUndefined();
  });
});
