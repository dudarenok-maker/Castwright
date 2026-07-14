import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  WIKI_BASE,
  wikiUrl,
  CATEGORY_WIKI,
  ADMIN_WIKI,
  HELP_SECTION_WIKI,
  GEMINI_KEY_WIKI,
} from './wiki-links';

const here = dirname(fileURLToPath(import.meta.url));
const wikiDir = resolve(here, '../../docs/wiki');

describe('wiki-links', () => {
  it('wikiUrl builds a page-level GitHub wiki URL (no anchor)', () => {
    expect(wikiUrl('Troubleshooting')).toBe(`${WIKI_BASE}/Troubleshooting`);
    expect(wikiUrl('Troubleshooting')).not.toContain('#');
  });

  it('every referenced WikiPage exists as docs/wiki/<page>.md', () => {
    const pages = new Set<string>([
      ...Object.values(CATEGORY_WIKI),
      ...Object.values(ADMIN_WIKI),
      ...Object.values(HELP_SECTION_WIKI),
      GEMINI_KEY_WIKI,
    ]);
    for (const page of pages) {
      const path = resolve(wikiDir, `${page}.md`);
      expect(existsSync(path), `missing wiki page: ${page}.md`).toBe(true);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0);
    }
  });
});
