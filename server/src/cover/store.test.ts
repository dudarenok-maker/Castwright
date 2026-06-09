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
