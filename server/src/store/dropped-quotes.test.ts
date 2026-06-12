/* Unit tests for the dropped-quotes ledger module. Pairs with
   docs/features/archive/04-analysing-view-progress.md — the panel under the
   cast preview reads from the file these helpers produce. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_QUOTE_CHARS,
  truncateQuote,
  appendBatch,
  loadDroppedQuotes,
  saveDroppedQuotes,
  type DroppedQuotesBatch,
  type DroppedQuotesFile,
} from './dropped-quotes.js';
import { droppedQuotesJsonPath } from '../workspace/paths.js';

describe('truncateQuote', () => {
  it('returns the original text and truncated:false when within the cap', () => {
    const r = truncateQuote('hello world');
    expect(r.text).toBe('hello world');
    expect(r.truncated).toBe(false);
  });

  it('returns the original text and truncated:false at exactly the cap', () => {
    const exact = 'x'.repeat(MAX_QUOTE_CHARS);
    const r = truncateQuote(exact);
    expect(r.text.length).toBe(MAX_QUOTE_CHARS);
    expect(r.truncated).toBe(false);
  });

  it('caps the text and flags truncated:true when over the cap', () => {
    const over = 'y'.repeat(MAX_QUOTE_CHARS + 100);
    const r = truncateQuote(over);
    expect(r.text.length).toBe(MAX_QUOTE_CHARS);
    expect(r.truncated).toBe(true);
  });
});

describe('appendBatch', () => {
  it('appends to an empty envelope', () => {
    const file: DroppedQuotesFile = { manuscriptId: 'm1', batches: [] };
    const batch: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T10:00:00.000Z',
      route: 'analysis-stream',
      totalDropped: 1,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'wren',
          characterName: 'Wren',
          quote: 'fabricated',
          truncated: false,
          reason: 'not_in_source',
        },
      ],
    };
    const next = appendBatch(file, batch);
    expect(next.batches).toHaveLength(1);
    expect(next.batches[0]).toBe(batch);
    /* Immutable — original envelope is unmodified. */
    expect(file.batches).toHaveLength(0);
  });

  it('appends after existing batches preserving order', () => {
    const first: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T10:00:00.000Z',
      route: 'analysis-stream',
      totalDropped: 1,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'a',
          characterName: 'A',
          quote: 'q1',
          truncated: false,
          reason: 'not_in_source',
        },
      ],
    };
    const second: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T10:05:00.000Z',
      route: 'analysis-chapters',
      totalDropped: 2,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'b',
          characterName: 'B',
          quote: 'q2',
          truncated: false,
          reason: 'empty_after_normalisation',
        },
      ],
    };
    const after = appendBatch(appendBatch({ manuscriptId: 'm1', batches: [] }, first), second);
    expect(after.batches.map((b) => b.recordedAt)).toEqual([
      '2026-05-15T10:00:00.000Z',
      '2026-05-15T10:05:00.000Z',
    ]);
  });
});

describe('loadDroppedQuotes / saveDroppedQuotes', () => {
  let workDir: string;
  let bookDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'dropped-quotes-test-'));
    bookDir = join(workDir, 'book');
    await mkdir(bookDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('loadDroppedQuotes returns an empty envelope when the file does not exist', async () => {
    const file = await loadDroppedQuotes(bookDir, 'm1');
    expect(file).toEqual({ manuscriptId: 'm1', batches: [] });
  });

  it('save then load round-trips the envelope unchanged', async () => {
    const batch: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T11:00:00.000Z',
      route: 'analysis-stream',
      totalDropped: 1,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'marlow',
          characterName: 'Marlow',
          quote: 'stitched dialogue',
          truncated: false,
          reason: 'not_in_source',
          note: 'model said: chap 3 dialogue',
        },
      ],
    };
    const original: DroppedQuotesFile = { manuscriptId: 'm1', batches: [batch] };
    await saveDroppedQuotes(bookDir, original);
    const loaded = await loadDroppedQuotes(bookDir, 'm1');
    expect(loaded).toEqual(original);
  });

  it('append semantics: second save adds rather than replaces', async () => {
    /* Simulate a real run: first batch lands, user retries, second
       batch must extend the file — not replace it. This pins the
       append-only invariant. */
    const file0 = await loadDroppedQuotes(bookDir, 'm1');
    const batch1: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T12:00:00.000Z',
      route: 'analysis-stream',
      totalDropped: 1,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'a',
          characterName: 'A',
          quote: 'q1',
          truncated: false,
          reason: 'not_in_source',
        },
      ],
    };
    await saveDroppedQuotes(bookDir, appendBatch(file0, batch1));

    const file1 = await loadDroppedQuotes(bookDir, 'm1');
    const batch2: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T12:05:00.000Z',
      route: 'analysis-chapters',
      totalDropped: 1,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'b',
          characterName: 'B',
          quote: 'q2',
          truncated: false,
          reason: 'empty_after_normalisation',
        },
      ],
    };
    await saveDroppedQuotes(bookDir, appendBatch(file1, batch2));

    const final = await loadDroppedQuotes(bookDir, 'm1');
    expect(final.batches).toHaveLength(2);
    expect(final.batches[0].route).toBe('analysis-stream');
    expect(final.batches[1].route).toBe('analysis-chapters');
  });

  it('preserves truncated flag and large quote bodies across the round-trip', async () => {
    const big = 'z'.repeat(MAX_QUOTE_CHARS);
    const batch: DroppedQuotesBatch = {
      recordedAt: '2026-05-15T13:00:00.000Z',
      route: 'analysis-stream',
      totalDropped: 1,
      affectedCharacters: 1,
      entries: [
        {
          characterId: 'verbose',
          characterName: 'Verbose',
          quote: big,
          truncated: true,
          reason: 'not_in_source',
        },
      ],
    };
    await saveDroppedQuotes(bookDir, { manuscriptId: 'm1', batches: [batch] });
    const loaded = await loadDroppedQuotes(bookDir, 'm1');
    expect(loaded.batches[0].entries[0].quote.length).toBe(MAX_QUOTE_CHARS);
    expect(loaded.batches[0].entries[0].truncated).toBe(true);
  });

  it('writes the file at the conventional .audiobook/dropped-quotes.json path', async () => {
    await saveDroppedQuotes(bookDir, { manuscriptId: 'm1', batches: [] });
    const expected = droppedQuotesJsonPath(bookDir);
    const raw = await readFile(expected, 'utf8');
    expect(JSON.parse(raw)).toEqual({ manuscriptId: 'm1', batches: [] });
  });

  it('tolerates a corrupted file shape by treating it as no batches', async () => {
    /* If a previous version of the schema wrote a different shape,
       readers should fall back to "no batches" rather than throw. The
       loader returns the existing object only when batches is an
       array — anything else (legacy shape, partial write) reverts to
       the empty envelope. */
    await mkdir(join(bookDir, '.audiobook'), { recursive: true });
    await writeFile(droppedQuotesJsonPath(bookDir), '{"manuscriptId":"m1"}', 'utf8');
    const loaded = await loadDroppedQuotes(bookDir, 'm1');
    expect(loaded.batches).toEqual([]);
  });
});
