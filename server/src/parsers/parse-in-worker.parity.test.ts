import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildEmptyHrefEpub,
  buildEpub,
  buildSingleChapterEpub,
  PARITY_CHAPTER_XHTML,
  PARITY_NAV_LABEL,
} from '../test-utils/empty-href-epub.js';
import { parseEpub } from './epub.js';
import { parseManuscript } from './index.js';
import { parseMobi } from './mobi.js';

const fixturesDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const EXPECTED_FAILURES = new Set(['sample-epub-drm.epub', 'sample-epub-image-only.epub']);
const epubFixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.epub'))
  .sort();

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}

async function expectParity(
  worker: Promise<unknown>,
  inProcess: Promise<unknown>,
  expectFailure = false,
): Promise<void> {
  const [w, i] = await Promise.all([settle(worker), settle(inProcess)]);
  if (expectFailure) {
    expect(w.ok).toBe(false);
    expect(i.ok).toBe(false);
    if (!w.ok && !i.ok) {
      expect(w.error.constructor).toBe(i.error.constructor);
      expect(w.error.message).toBe(i.error.message);
    }
    return;
  }
  expect(w.ok).toBe(true);
  expect(i.ok).toBe(true);
  if (w.ok && i.ok) {
    expect(JSON.stringify(w.value)).toBe(JSON.stringify(i.value));
    expect(w.value).toStrictEqual(i.value);
  }
}

describe('parseManuscript via worker: parity with in-process parsing', () => {
  it('finds the EPUB fixtures', () => {
    expect(epubFixtures.length).toBeGreaterThan(0);
  });

  it.each(epubFixtures)('fixture %s', async (name) => {
    const buffer = readFileSync(join(fixturesDir, name));
    await expectParity(
      parseManuscript({ buffer, fileName: name }),
      parseEpub(buffer, { fileName: name }),
      EXPECTED_FAILURES.has(name),
    );
  });

  it('empty-href EPUB', async () => {
    const buffer = await buildEmptyHrefEpub();
    await expectParity(
      parseManuscript({ buffer, fileName: 'empty-href.epub' }),
      parseEpub(buffer, { fileName: 'empty-href.epub' }),
    );
  });

  it('single-chapter EPUB', async () => {
    const buffer = await buildSingleChapterEpub(PARITY_CHAPTER_XHTML, PARITY_NAV_LABEL);
    await expectParity(
      parseManuscript({ buffer, fileName: 'single.epub' }),
      parseEpub(buffer, { fileName: 'single.epub' }),
    );
  });

  it('stored (uncompressed) two-chapter EPUB', async () => {
    const buffer = await buildEpub(
      [
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>First chapter text.</p></body></html>',
        '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Second chapter text.</p></body></html>',
      ],
      { compress: false },
    );
    await expectParity(
      parseManuscript({ buffer, fileName: 'stored.epub' }),
      parseEpub(buffer, { fileName: 'stored.epub' }),
    );
  });

  it('EPUB re-parsed from a sourcePath on disk', async () => {
    const buffer = readFileSync(join(fixturesDir, 'sample.epub'));
    const dir = mkdtempSync(join(tmpdir(), 'parity-'));
    const sourcePath = join(dir, 'sample.epub');
    writeFileSync(sourcePath, buffer);
    await expectParity(
      parseManuscript({ buffer, fileName: 'sample.epub', sourcePath }),
      parseEpub(buffer, { fileName: 'sample.epub', sourcePath }),
    );
  });

  for (const name of ['sample.mobi', 'sample.azw3']) {
    const path = join(fixturesDir, name);
    describe.skipIf(!existsSync(path))(`real ${name}`, () => {
      it('matches in-process parseMobi', async () => {
        const buffer = readFileSync(path);
        await expectParity(
          parseManuscript({ buffer, fileName: name }),
          parseMobi(buffer, { fileName: name }),
        );
      });
    });
  }
});
