/* Unit tests for the cast-merge-suggestions sibling-file store. */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

describe('cast-merge-suggestions store', () => {
  let workspaceRoot: string;
  let bookDir: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-merge-suggestions-test-'));
    process.env.WORKSPACE_DIR = workspaceRoot;
    bookDir = join(workspaceRoot, 'books', 'A', 'Standalones', 'Book');
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  });

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
  });

  it('load on missing file returns { suggestions: [] }', async () => {
    const { loadSuggestions } = await import('./cast-merge-suggestions.js');
    const result = await loadSuggestions(bookDir);
    expect(result).toEqual({ suggestions: [] });
  });

  it('write→load round-trip preserves all fields', async () => {
    const { writeSuggestions, loadSuggestions } = await import('./cast-merge-suggestions.js');
    const suggestions = [
      { sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' },
      { sourceId: 'ваня', targetId: 'иван', reason: 'Diminutive of «Иван»' },
    ];
    await writeSuggestions(bookDir, suggestions);
    const result = await loadSuggestions(bookDir);
    expect(result).toEqual({ suggestions });
  });

  it('writeSuggestions overwrites the whole file on second write', async () => {
    const { writeSuggestions, loadSuggestions } = await import('./cast-merge-suggestions.js');
    await writeSuggestions(bookDir, [
      { sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' },
    ]);
    await writeSuggestions(bookDir, [
      { sourceId: 'ваня', targetId: 'иван', reason: 'Diminutive of «Иван»' },
    ]);
    const result = await loadSuggestions(bookDir);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].sourceId).toBe('ваня');
  });

  it('clearSuggestions removes the file; subsequent load returns empty', async () => {
    const { writeSuggestions, loadSuggestions, clearSuggestions } = await import(
      './cast-merge-suggestions.js'
    );
    await writeSuggestions(bookDir, [
      { sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' },
    ]);
    const { castMergeSuggestionsJsonPath } = await import('../workspace/paths.js');
    expect(existsSync(castMergeSuggestionsJsonPath(bookDir))).toBe(true);
    await clearSuggestions(bookDir);
    expect(existsSync(castMergeSuggestionsJsonPath(bookDir))).toBe(false);
    const result = await loadSuggestions(bookDir);
    expect(result).toEqual({ suggestions: [] });
  });

  it('clearSuggestions is a no-op when file is absent', async () => {
    const { clearSuggestions } = await import('./cast-merge-suggestions.js');
    await expect(clearSuggestions(bookDir)).resolves.toBeUndefined();
  });

  it('dismissSuggestion drops only the matching sourceId+targetId pair', async () => {
    const { writeSuggestions, loadSuggestions, dismissSuggestion } = await import(
      './cast-merge-suggestions.js'
    );
    const suggestions = [
      { sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' },
      { sourceId: 'ваня', targetId: 'иван', reason: 'Diminutive of «Иван»' },
      { sourceId: 'саша', targetId: 'александр', reason: 'Diminutive of «Александр»' },
    ];
    await writeSuggestions(bookDir, suggestions);
    await dismissSuggestion(bookDir, 'ваня', 'иван');
    const result = await loadSuggestions(bookDir);
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.find((s) => s.sourceId === 'ваня')).toBeUndefined();
    expect(result.suggestions.find((s) => s.sourceId === 'оля')).toBeDefined();
    expect(result.suggestions.find((s) => s.sourceId === 'саша')).toBeDefined();
  });

  it('dismissSuggestion is a no-op when sourceId+targetId is not found', async () => {
    const { writeSuggestions, loadSuggestions, dismissSuggestion } = await import(
      './cast-merge-suggestions.js'
    );
    const suggestions = [
      { sourceId: 'оля', targetId: 'ольга', reason: 'Diminutive of «Ольга»' },
    ];
    await writeSuggestions(bookDir, suggestions);
    await dismissSuggestion(bookDir, 'nonexistent', 'target');
    const result = await loadSuggestions(bookDir);
    expect(result.suggestions).toHaveLength(1);
  });
});
