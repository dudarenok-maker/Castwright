#!/usr/bin/env -S npx tsx
/* Audit every analyzed book for stage-2 attribution coverage defects —
   chapters the per-chapter attribution model TRUNCATED or LOOPED (the
   2026-06-05 The Drowning Bell ch12/ch18 forensics). Read-only: it reports, it never
   writes.

   For each book it RE-PARSES the source EPUB (the same `parseEpub` the analyzer
   used) and compares each chapter's prose against the cached attributed
   sentences via `validateStage2Coverage`. Comparing against the real parser
   output — not the header-padded handoff prompts — is what makes this reliable.

   Usage (from repo root):
     npx tsx scripts/audit-stage2-coverage.mts
     WORKSPACE_DIR=C:/AudiobookWorkspace CACHE_DIR=server/handoff/cache \
       npx tsx scripts/audit-stage2-coverage.mts

   Env overrides:
     WORKSPACE_DIR  workspace root containing books/ (default: ../audiobook-workspace, then $WORKSPACE_DIR)
     CACHE_DIR      analysis cache dir (default: server/handoff/cache)

   Only EPUB-sourced books are audited (the coverage check needs the parsed
   source prose); txt/pdf books are listed as skipped. */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEpub } from '../server/src/parsers/epub.js';
import {
  validateStage2Coverage,
  type Stage2CoverageVerdict,
} from '../server/src/analyzer/stage2-coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const WORKSPACE_DIR = resolve(
  process.env.WORKSPACE_DIR || join(repoRoot, '..', 'audiobook-workspace'),
);
const CACHE_DIR = resolve(process.env.CACHE_DIR || join(repoRoot, 'server', 'handoff', 'cache'));

/** Recursively find every `.audiobook/state.json` under the workspace. */
function findStateFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        walk(p);
      } else if (e.name === 'state.json' && p.replace(/\\/g, '/').includes('/.audiobook/')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

interface StateJson {
  manuscriptId?: string;
  title?: string;
  author?: string;
  chapters?: Array<{ id: number; title?: string; excluded?: boolean }>;
}
interface CacheJson {
  chapters?: Record<string, Array<{ text: string }>>;
}

function pct(r: number): string {
  return `${(r * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  console.log('=== Stage-2 attribution coverage audit (read-only) ===');
  console.log('workspace:', WORKSPACE_DIR);
  console.log('cache dir:', CACHE_DIR, '\n');

  if (!existsSync(WORKSPACE_DIR)) {
    console.error(`Workspace not found: ${WORKSPACE_DIR}. Set WORKSPACE_DIR.`);
    process.exit(2);
  }

  const stateFiles = findStateFiles(join(WORKSPACE_DIR, 'books'));
  let booksAudited = 0;
  const damaged: Array<{
    book: string;
    chapterId: number;
    title: string;
    verdict: Stage2CoverageVerdict;
  }> = [];

  for (const sf of stateFiles) {
    const bookDir = dirname(dirname(sf)); // .../<book>/.audiobook/state.json -> <book>
    let state: StateJson;
    try {
      state = JSON.parse(readFileSync(sf, 'utf8')) as StateJson;
    } catch {
      continue;
    }
    const label = `${state.author ? state.author + ' — ' : ''}${state.title || bookDir}`;
    const mid = state.manuscriptId;
    if (!mid) continue;

    const cachePath = join(CACHE_DIR, `${mid}.json`);
    if (!existsSync(cachePath)) {
      console.log(`⏭  ${label} — no analysis cache (${mid}.json); skipped`);
      continue;
    }
    const epub = join(bookDir, 'manuscript.epub');
    if (!existsSync(epub)) {
      console.log(`⏭  ${label} — source is not EPUB (coverage audit needs parsed prose); skipped`);
      continue;
    }

    let cache: CacheJson;
    try {
      cache = JSON.parse(readFileSync(cachePath, 'utf8')) as CacheJson;
    } catch {
      console.log(`⚠  ${label} — unreadable cache; skipped`);
      continue;
    }
    const cacheChapters = cache.chapters ?? {};
    if (!Object.keys(cacheChapters).length) continue;

    let parsed;
    try {
      parsed = await parseEpub(Buffer.alloc(0), { sourcePath: epub, fileName: 'manuscript.epub' });
    } catch (err) {
      console.log(`⚠  ${label} — EPUB parse failed (${(err as Error).message}); skipped`);
      continue;
    }
    const parsedById = new Map(parsed.chapters.map((c) => [c.id, c]));
    const stateTitleById = new Map((state.chapters ?? []).map((c) => [c.id, c.title ?? '']));
    booksAudited++;

    // Distinctive title words (drop the ubiquitous "chapter" + pure stopwords)
    // so we can confirm the re-parsed chapter is the SAME one the cache analyzed.
    const titleWords = (s: string) =>
      new Set(
        (s || '')
          .toLowerCase()
          .replace(/[^a-z0-9 ]/g, ' ')
          .split(/\s+/)
          .filter((w) => w && w !== 'chapter'),
      );
    const alignedTitle = (a: string, b: string) => {
      const wa = titleWords(a);
      const wb = titleWords(b);
      if (wa.size === 0 || wb.size === 0) return true; // no signal → don't gate
      for (const w of wa) if (wb.has(w)) return true;
      return false;
    };

    const bookDamaged: typeof damaged = [];
    let misaligned = 0;
    for (const [cidStr, sentences] of Object.entries(cacheChapters)) {
      const cid = Number(cidStr);
      const ch = parsedById.get(cid);
      if (!ch) {
        misaligned++;
        continue;
      }
      if (!Array.isArray(sentences) || sentences.length === 0) continue;
      // Guard against re-parse id drift: only audit when the re-parsed chapter
      // title matches the cache's chapter title (else we'd compare the wrong
      // body to the wrong sentences — the guide-book false positives).
      const stateTitle = stateTitleById.get(cid) ?? ch.title;
      if (!alignedTitle(stateTitle, ch.title)) {
        misaligned++;
        continue;
      }
      const verdict = validateStage2Coverage(ch.body, sentences);
      // A real repeat-loop rarely more than doubles content; coverage >3× the
      // source means the re-parse paired the wrong chapter (id collision on a
      // guide book), not a model loop — treat as misalignment, not damage.
      if (verdict.coverageRatio > 3) {
        misaligned++;
        continue;
      }
      if (!verdict.ok) {
        const rec = { book: label, chapterId: cid, title: ch.title, verdict };
        bookDamaged.push(rec);
        damaged.push(rec);
      }
    }

    if (bookDamaged.length) {
      console.log(`📕 ${label}  (${booksAudited === 0 ? '' : ''}${parsed.chapters.length} source ch)`);
      bookDamaged
        .sort((a, b) => a.verdict.coverageRatio - b.verdict.coverageRatio)
        .forEach((d) => {
          const v = d.verdict;
          const tags = [
            !v.endingPresent ? 'TRUNCATED' : null,
            v.duplicatedBlock ? `DUP×${v.duplicatedBlock.length}` : null,
          ]
            .filter(Boolean)
            .join(' + ');
          console.log(
            `     ❌ ch ${d.chapterId} "${d.title}": coverage ${pct(v.coverageRatio)}${tags ? ' — ' + tags : ''}`,
          );
        });
      if (misaligned) console.log(`     (note: ${misaligned} chapter(s) skipped — re-parse title/id didn't align)`);
      console.log();
    } else {
      const skip = misaligned ? ` (${misaligned} skipped for title/id misalignment)` : '';
      console.log(`✅ ${label} — analyzed chapters cover the source${skip}\n`);
    }
  }

  console.log('─'.repeat(60));
  console.log(`Books audited: ${booksAudited}. Damaged chapters: ${damaged.length}.`);
  if (damaged.length) {
    console.log('\nRe-analyze these chapters (validated) and regenerate their audio:');
    for (const d of damaged) console.log(`  • ${d.book} — ch ${d.chapterId} "${d.title}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
