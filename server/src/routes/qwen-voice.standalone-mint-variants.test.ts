/* #4037 (book-scoped sibling) — the standalone (non-series) mint re-keys a legacy
   voice (`qwen-v_wren`) to a fresh `qwen-<uuid>`. It must carry the base family and
   the emotion variants with it, or the stamped row names a `qwen-<uuid>.pt` /
   `qwen-<uuid>__angry` that does not exist. A failed copy stamps nothing and leaves
   no copy behind. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Fails any copy whose destination contains this text (an EBUSY from a scanner). */
const failCopyTo = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const copyFile = async (src: unknown, dest: unknown, mode?: number) => {
    if (failCopyTo.text && String(dest).includes(failCopyTo.text)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, copyfile '${String(dest)}'`), {
        code: 'EBUSY',
        syscall: 'copyfile',
        path: String(dest),
      });
    }
    return actual.copyFile(src as string, dest as string, mode);
  };
  return { ...actual, default: { ...actual, copyFile }, copyFile };
});

let workspaceRoot: string;
const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = () => join(workspaceRoot, 'books', 'standalone');
const castPath = () => join(bookDir(), '.audiobook', 'cast.json');
const readRow = (): Record<string, any> => JSON.parse(readFileSync(castPath(), 'utf8')).characters[0];

const legacyRow = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  overrideTtsVoices: {
    qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } },
  },
};

function seed() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(qwenDir(), { recursive: true, force: true });
  mkdirSync(join(bookDir(), '.audiobook'), { recursive: true });
  writeFileSync(castPath(), JSON.stringify({ characters: [{ ...legacyRow }] }));
  mkdirSync(qwenDir(), { recursive: true });
  for (const f of [
    'qwen-v_wren.pt',
    'qwen-v_wren.json',
    'qwen-v_wren__1.7b.pt',
    'qwen-v_wren__master.wav',
    'qwen-v_wren__angry.pt',
    'qwen-v_wren__angry.json',
    'qwen-v_wren__angry__1.7b.pt',
    'qwen-v_wren__angry__master.wav',
  ]) {
    writeFileSync(join(qwenDir(), f), `bytes of ${f}`);
  }
}

const mint = async () => {
  const { ensureCharacterVoiceUuid } = await import('./qwen-voice.js');
  return ensureCharacterVoiceUuid(bookDir(), 'wren');
};

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-standalone-mint-variants-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

beforeEach(() => {
  failCopyTo.text = null;
  seed();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('#4037 — the book-scoped mint copies a legacy voice’s base family and emotion variants', () => {
  it('copies base + variant files to the new key and the stamped row names them', async () => {
    const uuid = await mint();
    expect(uuid).toBeTruthy();
    expect(readRow().voiceUuid).toBe(uuid);

    for (const f of ['.pt', '.json', '__1.7b.pt', '__master.wav']) {
      expect(readFileSync(join(qwenDir(), `qwen-${uuid}${f}`), 'utf8')).toBe(`bytes of qwen-v_wren${f}`);
      expect(readFileSync(join(qwenDir(), `qwen-${uuid}__angry${f}`), 'utf8')).toBe(`bytes of qwen-v_wren__angry${f}`);
    }
    expect(existsSync(join(qwenDir(), 'qwen-v_wren.pt'))).toBe(true);
    expect(readRow().overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
  });

  it('a failed variant copy stamps nothing and leaves no copy behind', async () => {
    failCopyTo.text = '__angry__1.7b.pt';
    await expect(mint()).rejects.toThrow(/EBUSY/);
    expect(readRow().voiceUuid).toBeUndefined();
    expect(readRow().overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-v_wren__angry');
    expect(readdirSync(qwenDir()).filter((f) => !f.startsWith('qwen-v_wren'))).toEqual([]);
  });

  it('with nothing designed under the legacy key, the row is stamped and nothing is copied', async () => {
    rmSync(qwenDir(), { recursive: true, force: true });
    mkdirSync(qwenDir(), { recursive: true });
    const uuid = await mint();
    expect(readRow().voiceUuid).toBe(uuid);
    expect(readdirSync(qwenDir())).toEqual([]);
  });
});
