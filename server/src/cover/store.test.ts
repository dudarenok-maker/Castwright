import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let bookDir: string;

const fetchMock = vi.fn();
function imageResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
}
const SAMPLE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-store-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookDir = join(workspaceRoot, 'books', 'A', 'S', 'T');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({ bookId: 'bk1', title: 'T', author: 'A', updatedAt: '2020-01-01' }),
  );
});
afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe('backgroundFetchCover', () => {
  it('downloads the first-available candidate and patches state.json with candidateId + source', async () => {
    vi.doMock('./search.js', () => ({
      firstAvailableCover: vi.fn().mockResolvedValue({
        id: 'apple:42',
        source: 'apple',
        coverUrl: 'https://x/apple/42.jpg',
      }),
    }));
    fetchMock.mockResolvedValue(imageResponse(SAMPLE_JPEG));
    const { backgroundFetchCover } = await import('./store.js');

    await backgroundFetchCover(bookDir, 'T', 'A', 'bk1');

    expect(existsSync(join(bookDir, '.audiobook', 'cover.jpg'))).toBe(true);
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.candidateId).toBe('apple:42');
    expect(state.coverImage.source).toBe('apple');
    expect(state.coverImage.originalUrl).toBe('https://x/apple/42.jpg');
    expect(typeof state.coverImage.fetchedAt).toBe('string');
  });

  it('no-ops (no throw) when every source is empty', async () => {
    vi.doMock('./search.js', () => ({
      firstAvailableCover: vi.fn().mockResolvedValue(null),
    }));
    const { backgroundFetchCover } = await import('./store.js');
    await expect(backgroundFetchCover(bookDir, 'T', 'A', 'bk1')).resolves.toBeUndefined();
  });
});

describe('downloadCover containment', () => {
  it('rejects a destPath outside the workspace before any fetch', async () => {
    const { downloadCover } = await import('./store.js');
    await expect(
      downloadCover('https://x/evil.jpg', join(workspaceRoot, '..', '..', 'evil.jpg')),
    ).rejects.toThrow();
  });
});

describe('cover state.json helpers wait on the state lock (#3625)', () => {
  const statePath = () => join(bookDir, '.audiobook', 'state.json');
  const readState = () => JSON.parse(readFileSync(statePath(), 'utf8'));

  async function holdLock(): Promise<{ release: () => void; held: Promise<void> }> {
    const { withStateLock } = await import('../workspace/state-lock.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = withStateLock(bookDir, async () => {
      acquired();
      await gate;
    });
    await got;
    return { release, held };
  }

  it('patchStateCover does not write while the lock is held, then lands', async () => {
    const { patchStateCover } = await import('./store.js');
    const before = readFileSync(statePath(), 'utf8');
    const { release, held } = await holdLock();
    const p = patchStateCover(bookDir, {
      id: 'apple:1',
      source: 'apple',
      coverUrl: 'https://x/1.jpg',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(statePath(), 'utf8')).toBe(before);
    release();
    await Promise.all([held, p]);
    expect(readState().coverImage.candidateId).toBe('apple:1');
  });

  it('clearStateCover does not write while the lock is held, then lands', async () => {
    const { patchStateCover, clearStateCover } = await import('./store.js');
    await patchStateCover(bookDir, { id: 'apple:2', source: 'apple', coverUrl: 'https://x/2.jpg' });
    expect(readState().coverImage).toBeDefined();
    const { release, held } = await holdLock();
    const p = clearStateCover(bookDir);
    await new Promise((r) => setTimeout(r, 200));
    expect(readState().coverImage).toBeDefined();
    release();
    await Promise.all([held, p]);
    expect(readState().coverImage).toBeUndefined();
  });
});
