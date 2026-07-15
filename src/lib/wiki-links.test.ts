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
  WIZARD_STEP_WIKI,
  HELP_FOOTER_WIKI,
  stepLearnMorePage,
  SUPPORT_LINKS,
  REPO_BASE,
} from './wiki-links';
import { STEPS } from '../components/setup/steps';

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
      ...Object.values(WIZARD_STEP_WIKI),
      ...HELP_FOOTER_WIKI,
      GEMINI_KEY_WIKI,
    ]);
    for (const page of pages) {
      const path = resolve(wikiDir, `${page}.md`);
      expect(existsSync(path), `missing wiki page: ${page}.md`).toBe(true);
      expect(readFileSync(path, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('WIZARD_STEP_WIKI maps every wizard step to an existing wiki page', () => {
    for (const step of STEPS) {
      const page = WIZARD_STEP_WIKI[step.id];
      expect(page, `step ${step.id} has no wiki mapping`).toBeTruthy();
      const path = resolve(wikiDir, `${page}.md`);
      expect(existsSync(path), `missing wiki page: ${page}.md`).toBe(true);
    }
  });

  it('stepLearnMorePage suppresses steps whose page is already a footer link', () => {
    // environment + ffmpeg → Installing-Castwright, which is a footer link → null
    expect(stepLearnMorePage('environment')).toBeNull();
    expect(stepLearnMorePage('ffmpeg')).toBeNull();
    // unique pages are kept
    expect(stepLearnMorePage('analysis')).toBe('Analysis-and-the-Analyzer');
    expect(stepLearnMorePage('voice')).toBe('Voice-Engines');
    expect(stepLearnMorePage('finish')).toBe('Generating-Audio');
  });

  it('SUPPORT_LINKS point at the repo issues + discussions', () => {
    expect(SUPPORT_LINKS.issues).toBe(`${REPO_BASE}/issues`);
    expect(SUPPORT_LINKS.discussions).toBe(`${REPO_BASE}/discussions`);
  });
});
