#!/usr/bin/env -S npx tsx
/* Audit every analyzed book for MISSING SPEAKERS in two ways. Read-only: it
   reports, it never writes.

   (a) UNCAST — characters the prose tags with a dialogue beat
       (`"…," Lessom repeated.`) but who never made it into cast.json, so
       stage-2 dumped their lines on the narrator (the 2026-06-05 The Drowning Bell
       ch19 "Lessom" bug). `validateRosterCoverage` vs cast.json names+aliases.
   (b) HALF-STATE (#529) — a speaker who IS in cast.json but has 0 attributed
       lines in a chapter that tags them (an interrupted re-analysis: stage-1
       added the name, stage-2 never re-attributed). `validateAttributionCoverage`
       reads manuscript-edits.json and counts each rostered speaker's lines.

   For each book it RE-PARSES the source EPUB (the same `parseEpub` the analyzer
   used). Folded minor speakers live on as aliases of the unknown-male/female
   buckets (whose ids carry lines), so they correctly DON'T flag under either
   check. A book is "clean" only when BOTH checks pass on every chapter.

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
  validateAttributionCoverage,
  type MissingSpeaker,
  type HalfStateSpeaker,
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
  characters?: Array<{ id?: string; name?: string; aliases?: string[] }>;
}
interface EditsJson {
  sentences?: Array<{ chapterId: number; characterId: string }>;
}

interface Finding {
  book: string;
  chapterId: number;
  title: string;
  /** Tagged speakers ABSENT from the roster. */
  missingSpeakers: MissingSpeaker[];
  /** Rostered speakers with 0 attributed lines here — the #529 half-state. */
  halfStateSpeakers: HalfStateSpeaker[];
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
    const roster: Array<{ id: string; name: string; aliases?: string[] }> = [];
    for (const c of cast.characters ?? []) {
      if (c.name) rosterNames.push(c.name);
      for (const a of c.aliases ?? []) rosterNames.push(a);
      if (c.id && c.name) roster.push({ id: c.id, name: c.name, aliases: c.aliases });
    }

    /* manuscript-edits.json holds the per-sentence attribution. The half-state
       check (#529) needs it to count a rostered speaker's lines per chapter. */
    const editsPath = join(bookDir, '.audiobook', 'manuscript-edits.json');
    const edits = existsSync(editsPath)
      ? (JSON.parse(readFileSync(editsPath, 'utf8')) as EditsJson)
      : null;
    const sentencesByChapter = new Map<number, { characterId: string }[]>();
    for (const s of edits?.sentences ?? []) {
      const arr = sentencesByChapter.get(s.chapterId) ?? [];
      arr.push({ characterId: s.characterId });
      sentencesByChapter.set(s.chapterId, arr);
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
      // (a) tagged speaker absent from the roster.
      const verdict = validateRosterCoverage(ch.body, rosterNames);
      // (b) rostered speaker prose-tagged but with 0 attributed lines (half-state).
      const attribution = validateAttributionCoverage(
        ch.body,
        roster,
        sentencesByChapter.get(ch.id) ?? [],
      );
      if (!verdict.ok || !attribution.ok) {
        const rec: Finding = {
          book: label,
          chapterId: ch.id,
          title: ch.title,
          missingSpeakers: verdict.missingSpeakers,
          halfStateSpeakers: attribution.halfStateSpeakers,
        };
        bookFindings.push(rec);
        findings.push(rec);
      }
    }

    if (bookFindings.length) {
      log(`📕 ${label}  (${parsed.chapters.length} source ch)`);
      for (const f of bookFindings) {
        const parts: string[] = [];
        if (f.missingSpeakers.length)
          parts.push(`uncast: ${f.missingSpeakers.map((s) => `${s.name}×${s.tagCount}`).join(', ')}`);
        if (f.halfStateSpeakers.length)
          parts.push(
            `0-line half-state: ${f.halfStateSpeakers
              .map((s) => `${s.name}×${s.tagCount} (narrator ${s.narratorLines})`)
              .join(', ')}`,
          );
        log(`     ❌ ch ${f.chapterId} "${f.title}": ${parts.join('; ')}`);
      }
      log();
    } else {
      log(`✅ ${label} — every tagged speaker is in the cast and has attributed lines`);
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
    return;
  }

  log('─'.repeat(60));
  log(
    `Books audited: ${booksAudited}. Chapters flagged (uncast or 0-line half-state): ${findings.length}.`,
  );
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
