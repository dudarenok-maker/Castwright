import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEpub } from './epub.js';
import { parseInWorkerWithThread } from './parse-in-worker.js';

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('parseInWorker', () => {
  it.each(['sample.epub', 'sample-opf-prefixed.epub'])(
    'parses %s off the main thread, identical to in-process',
    async (name) => {
      const buffer = fixture(name);
      const expected = await parseEpub(buffer, { fileName: name });
      const { parsed, threadId } = await parseInWorkerWithThread({
        format: 'epub',
        buffer,
        fileName: name,
      });
      expect(parsed).toStrictEqual(expected);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(expected));
      expect(threadId).not.toBe(0);
    },
    30_000,
  );
});
