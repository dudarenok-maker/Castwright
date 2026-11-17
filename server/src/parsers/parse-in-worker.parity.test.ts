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
import { buildMinimalMobi } from '../test-utils/minimal-mobi.js';

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

describe.each([1, 2])('parseManuscript via worker: parity with in-process parsing at extractorVersion %i', (extractorVersion) => {
  it('finds the EPUB fixtures', () => {
    expect(epubFixtures.length).toBeGreaterThan(0);
  });

  it.each(epubFixtures)('fixture %s', async (name) => {
    const buffer = readFileSync(join(fixturesDir, name));
    await expectParity(
      parseManuscript({ buffer, fileName: name, extractorVersion }),
      parseEpub(buffer, { fileName: name, extractorVersion }),
      EXPECTED_FAILURES.has(name),
    );
  });

  it('empty-href EPUB', async () => {
    const buffer = await buildEmptyHrefEpub();
    await expectParity(
      parseManuscript({ buffer, fileName: 'empty-href.epub', extractorVersion }),
      parseEpub(buffer, { fileName: 'empty-href.epub', extractorVersion }),
    );
  });

  it('single-chapter EPUB', async () => {
    const buffer = await buildSingleChapterEpub(PARITY_CHAPTER_XHTML, PARITY_NAV_LABEL);
    await expectParity(
      parseManuscript({ buffer, fileName: 'single.epub', extractorVersion }),
      parseEpub(buffer, { fileName: 'single.epub', extractorVersion }),
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
      parseManuscript({ buffer, fileName: 'stored.epub', extractorVersion }),
      parseEpub(buffer, { fileName: 'stored.epub', extractorVersion }),
    );
  });

  it('EPUB re-parsed from a sourcePath on disk', async () => {
    const buffer = readFileSync(join(fixturesDir, 'sample.epub'));
    const dir = mkdtempSync(join(tmpdir(), 'parity-'));
    const sourcePath = join(dir, 'sample.epub');
    writeFileSync(sourcePath, buffer);
    await expectParity(
      parseManuscript({ buffer, fileName: 'sample.epub', sourcePath, extractorVersion }),
      parseEpub(buffer, { fileName: 'sample.epub', sourcePath, extractorVersion }),
    );
  });

  for (const name of ['sample.mobi', 'sample.azw3']) {
    const path = join(fixturesDir, name);
    describe.skipIf(!existsSync(path))(`real ${name}`, () => {
      it('matches in-process parseMobi', async () => {
        const buffer = readFileSync(path);
        await expectParity(
          parseManuscript({ buffer, fileName: name, extractorVersion }),
          parseMobi(buffer, { fileName: name, extractorVersion }),
        );
      });
    });
  }

  /* #4217: a `</div>` closer breaks a paragraph at v2 and not at v1. The worker
     must reproduce whichever the caller pinned, so these two assert the
     version-dependent text itself, not only worker == in-process. */
  it('EPUB with a </div> closer: worker output matches in-process and follows the pinned version', async () => {
    const buffer = await buildEpub([
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><div>Alpha.</div><div>Beta.</div></body></html>',
    ]);
    await expectParity(
      parseManuscript({ buffer, fileName: 'closer.epub', extractorVersion }),
      parseEpub(buffer, { fileName: 'closer.epub', extractorVersion }),
    );
    const out = await parseManuscript({ buffer, fileName: 'closer.epub', extractorVersion });
    expect(out.sourceText).toBe(extractorVersion === 2 ? 'Alpha.\n\nBeta.' : 'Alpha.Beta.');
  });

  it('MOBI with a </div> closer: worker output matches in-process and follows the pinned version', async () => {
    const buffer = buildMinimalMobi('<html><body><div>Alpha.</div><div>Beta.</div></body></html>');
    await expectParity(
      parseManuscript({ buffer, fileName: 'closer.mobi', extractorVersion }),
      parseMobi(buffer, { fileName: 'closer.mobi', extractorVersion }),
    );
    const out = await parseManuscript({ buffer, fileName: 'closer.mobi', extractorVersion });
    expect(out.sourceText).toBe(extractorVersion === 2 ? 'Alpha.\n\nBeta.' : 'Alpha.Beta.');
  });
});
