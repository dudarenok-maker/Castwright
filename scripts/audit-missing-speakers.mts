#!/usr/bin/env -S npx tsx
/* Audit every analyzed book for MISSING SPEAKERS — characters the prose tags
   with a dialogue beat (`"…," Lessom repeated.`) but who never made it into
   the cast, so stage-2 attribution dumped their lines on the narrator (the
   2026-06-05 The Drowning Bell ch19 "Lessom" bug). Read-only: it reports, it never
   writes.

   For each book it RE-PARSES the source EPUB (the same `parseEpub` the analyzer
   used) and runs `validateRosterCoverage` on each chapter's prose against the
   book's actual cast (cast.json names + aliases — folded minor speakers live on
   as aliases of the unknown-male/female buckets, so they correctly DON'T flag).

   Usage (from repo root):
     npx tsx scripts/audit-missing-speakers.mts
     npx tsx scripts/audit-missing-speakers.mts --book The Drowning Bell
     npx tsx scripts/audit-missing-speakers.mts --book The Drowning Bell --json

   Flags:
     --book <substr>   only audit books whose "Author — Title" label matches (ci)
     --json            emit a JSON array of findings (drives the re-run list)

   Env overrides:
     WORKSPACE_DIR             workspace root containing books/ (default: ../audiobook-workspace, then $WORKSPACE_DIR)
     ROSTER_GUARD_IGNORE_NAMES comma-separated names to ignore (place/org names)
     ROSTER_MIN_HITS_NO_QUOTE / ROSTER_QUOTE_PROXIMITY  tuning (see roster-coverage.ts)

   Only EPUB-sourced books are audited (the scan needs the parsed source prose);
   txt/pdf books are listed as skipped. */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEpub } from '../server/src/parsers/epub.js';
import {
  validateRosterCoverage,
  type MissingSpeaker,
} from '../server/src/analyzer/roster-coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const WORKSPACE_DIR = resolve(
  process.env.WORKSPACE_DIR || join(repoRoot, '..', 'audiobook-workspace'),
);

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const bookFilter = (() => {
  const i = argv.indexOf('--book');
  return i >= 0 && argv[i + 1] ? argv[i + 1].toLowerCase() : null;
})();

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
  title?: string;
  author?: string;
  chapters?: Array<{ id: number; title?: string; excluded?: boolean }>;
}
interface CastJson {
  characters?: Array<{ name?: string; aliases?: string[] }>;
}

interface Finding {
  book: string;
  chapterId: number;
  title: string;
  missingSpeakers: MissingSpeaker[];
}

function log(...args: unknown[]): void {
  if (!asJson) console.log(...args);
}

async function main(): Promise<void> {
  log('=== Missing-speaker audit (read-only) ===');
  log('workspace:', WORKSPACE_DIR, '\n');

  if (!existsSync(WORKSPACE_DIR)) {
    console.error(`Workspace not found: ${WORKSPACE_DIR}. Set WORKSPACE_DIR.`);
    process.exit(2);
  }

  const stateFiles = findStateFiles(join(WORKSPACE_DIR, 'books'));
  let booksAudited = 0;
  const findings: Finding[] = [];

  for (const sf of stateFiles) {
    const bookDir = dirname(dirname(sf)); // .../<book>/.audiobook/state.json -> <book>
    let state: StateJson;
    try {
      state = JSON.parse(readFileSync(sf, 'utf8')) as StateJson;
    } catch {
      continue;
    }
    const label = `${state.author ? state.author + ' — ' : ''}${state.title || bookDir}`;
    if (bookFilter && !label.toLowerCase().includes(bookFilter)) continue;

    const castPath = join(bookDir, '.audiobook', 'cast.json');
    if (!existsSync(castPath)) {
      log(`⏭  ${label} — no cast.json; skipped`);
      continue;
    }
    const epub = join(bookDir, 'manuscript.epub');
    if (!existsSync(epub)) {
      log(`⏭  ${label} — source is not EPUB (audit needs parsed prose); skipped`);
      continue;
    }

    let cast: CastJson;
    try {
      cast = JSON.parse(readFileSync(castPath, 'utf8')) as CastJson;
    } catch {
      log(`⚠  ${label} — unreadable cast.json; skipped`);
      continue;
    }
    const rosterNames: string[] = [];
    for (const c of cast.characters ?? []) {
      if (c.name) rosterNames.push(c.name);
      for (const a of c.aliases ?? []) rosterNames.push(a);
    }

    let parsed;
    try {
      parsed = await parseEpub(Buffer.alloc(0), { sourcePath: epub, fileName: 'manuscript.epub' });
    } catch (err) {
      log(`⚠  ${label} — EPUB parse failed (${(err as Error).message}); skipped`);
      continue;
    }
    booksAudited++;

    const excludedIds = new Set(
      (state.chapters ?? []).filter((c) => c.excluded).map((c) => c.id),
    );
    const bookFindings: Finding[] = [];
    for (const ch of parsed.chapters) {
      if (excludedIds.has(ch.id)) continue;
      const verdict = validateRosterCoverage(ch.body, rosterNames);
      if (!verdict.ok) {
        const rec: Finding = {
          book: label,
          chapterId: ch.id,
          title: ch.title,
          missingSpeakers: verdict.missingSpeakers,
        };
        bookFindings.push(rec);
        findings.push(rec);
      }
    }

    if (bookFindings.length) {
      log(`📕 ${label}  (${parsed.chapters.length} source ch)`);
      for (const f of bookFindings) {
        const who = f.missingSpeakers
          .map((s) => `${s.name}×${s.tagCount}`)
          .join(', ');
        log(`     ❌ ch ${f.chapterId} "${f.title}": ${who}`);
      }
      log();
    } else {
      log(`✅ ${label} — every tagged speaker is in the cast`);
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
    return;
  }

  log('─'.repeat(60));
  log(`Books audited: ${booksAudited}. Chapters with missing speakers: ${findings.length}.`);
  if (findings.length) {
    const chapterIdsByBook = new Map<string, Set<number>>();
    for (const f of findings) {
      if (!chapterIdsByBook.has(f.book)) chapterIdsByBook.set(f.book, new Set());
      chapterIdsByBook.get(f.book)!.add(f.chapterId);
    }
    log('\nRe-run stage1+stage2 for these chapters (POST /api/manuscripts/<id>/analysis/chapters):');
    for (const [book, ids] of chapterIdsByBook) {
      log(`  • ${book} — chapterIds: [${[...ids].sort((a, b) => a - b).join(', ')}]`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
