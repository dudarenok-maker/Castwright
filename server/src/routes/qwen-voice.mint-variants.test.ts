/* #4037 — the series mint (ensureCharacterVoiceUuid with a seriesFilter) copies a
   legacy voice key's emotion variants along with its base family, and renames the
   stamped rows' variant slots to the new key. On real cast.json files; the mint is
   called directly. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* T4 — makes a copy to `qwen-<anything>__angry.pt` fail with EBUSY. */
const failing = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: ((src: string, dest: string, ...rest: unknown[]) => {
      if (failing.on && /qwen-[^\\/]+__angry\.pt$/.test(String(dest))) {
        return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
      }
      return (actual.copyFile as (...a: unknown[]) => Promise<void>)(src, dest, ...rest);
    }) as typeof actual.copyFile,
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const TITLES = ['Book One', 'Book Two'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let ensure: typeof import('./qwen-voice.js').ensureCharacterVoiceUuid;

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const rowOf = (t: Title): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t), 'utf8')).characters.find((c: { id: string }) => c.id === 'wren');
const file = (name: string) => join(qwenDir(), name);
const plant = (name: string, body: string) => writeFileSync(file(name), Buffer.from(body));

function writeBook(t: Title, rows: Array<Record<string, unknown>>) {
  const dir = bookDir(t);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: `b_${t}`,
      manuscriptId: `m_${t}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: TITLES.indexOf(t) + 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
}

const legacy = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  gender: 'female',
  ageRange: 'adult',
};
const withVariants = (variants: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...legacy,
  ...extra,
  overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants } },
});

function seed(oneRow: Record<string, unknown>) {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  writeBook('Book One', [oneRow]);
  writeBook('Book Two', [{ ...legacy }]);
}
const plantBase = () => {
  plant('qwen-v_wren.pt', 'BASE-PT');
  plant('qwen-v_wren.json', 'BASE-JSON');
  plant('qwen-v_wren__1.7b.pt', 'BASE-17B');
  plant('qwen-v_wren__master.wav', 'BASE-WAV');
};
const plantAngry = () => {
  plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
  plant('qwen-v_wren__angry.json', 'ANGRY-JSON');
};
const mint = () => ensure(bookDir('Book Two'), 'wren', { author: AUTHOR, series: SERIES });
const legacyFiles = [
  'qwen-v_wren.pt',
  'qwen-v_wren.json',
  'qwen-v_wren__1.7b.pt',
  'qwen-v_wren__master.wav',
  'qwen-v_wren__angry.pt',
  'qwen-v_wren__angry.json',
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-mint-variants-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  ({ ensureCharacterVoiceUuid: ensure } = await import('./qwen-voice.js'));
});
beforeEach(() => {
  failing.on = false;
});
afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('series mint copies emotion variants (#4037)', () => {
  it('T1: copies the angry family, renames the stamped slot, keeps the legacy files', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(uuid).toBeTruthy();
    expect(readFileSync(file(`qwen-${uuid}__angry.pt`), 'utf8')).toBe('ANGRY-PT');
    expect(readFileSync(file(`qwen-${uuid}__angry.json`), 'utf8')).toBe('ANGRY-JSON');
    expect(rowOf('Book One').voiceUuid).toBe(uuid);
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    expect(readFileSync(file(`qwen-${uuid}.pt`), 'utf8')).toBe('BASE-PT');
    for (const f of legacyFiles) expect(existsSync(file(f))).toBe(true);
    expect(readFileSync(file('qwen-v_wren__angry.pt'), 'utf8')).toBe('ANGRY-PT');
  });

  it('T2: a foreign variant name is kept', async () => {
    seed(
      withVariants({
        angry: { name: 'qwen-v_wren__angry' },
        sad: { name: 'qwen-u_other__sad' },
      }),
    );
    plantBase();
    plantAngry();
    await mint();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.sad.name).toBe('qwen-u_other__sad');
  });

  it('T3: nothing to copy (no base .pt) copies no variant and stamps only the designing row', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plant('qwen-v_wren__angry.pt', 'ANGRY-PT');
    await mint();
    expect(readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-') && f !== 'qwen-v_wren__angry.pt')).toEqual([]);
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
  });

  it('T4: a failing variant copy removes every earlier copy and stamps nothing', async () => {
    seed(withVariants({ angry: { name: 'qwen-v_wren__angry' } }));
    plantBase();
    plantAngry();
    failing.on = true;
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(readdirSync(qwenDir()).sort()).toEqual([...legacyFiles].sort());
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Two').voiceUuid).toBeUndefined();
  });

  it('T5: a row with its own uuid keeps both uuid and variant names', async () => {
    seed(
      withVariants({ angry: { name: 'qwen-u_own__angry' } }, { voiceUuid: 'u_own' }),
    );
    plantBase();
    plantAngry();
    const uuid = await mint();
    expect(uuid).toBeTruthy();
    expect(rowOf('Book One').voiceUuid).toBe('u_own');
    expect(rowOf('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-u_own__angry');
  });
});
