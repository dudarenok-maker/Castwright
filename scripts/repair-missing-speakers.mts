#!/usr/bin/env -S npx tsx
/* Repair MISSING SPEAKERS across the library (the data half — steps 1–3 of the
   plan-182 runbook). It does NOT touch audio or voices; after it finishes you
   design voices for the recovered characters and regenerate the affected
   chapters from the UI (steps 4–5).

   By default it scans EVERY analyzed book. Pass --book / --manuscript to scope
   to one.

   What it does, per book with findings:
     1. AUDIT (read-only) — re-parses the EPUB and runs TWO checks per chapter:
        `validateRosterCoverage` (tagged speaker missing from cast.json) AND
        `validateAttributionCoverage` (#529 — a speaker who IS in cast.json but
        has 0 attributed lines in a chapter that tags them, i.e. the
        interrupted-re-analysis half-state). Both flag the chapter for re-run, so
        the half-state is now detected automatically (no `--force` needed). Prints
        the affected chapterIds + a "before" snapshot (per-chapter narrator counts).
     2. RE-RUN (only with --apply) — backs up cast.json, then POSTs those
        chapterIds to the running server's subset re-analysis route
        (`POST /api/manuscripts/:id/analysis/chapters`), which re-runs stage-1
        (now with the roster-coverage guard) + stage-2, streaming the SSE log.
     3. VERIFY — re-audits + prints an "after" snapshot (recovered characters now
        in cast.json with non-zero lines; narrator-line drop per chapter).

   ┌─ PREREQUISITES (read before --apply) ──────────────────────────────────────┐
   │ The running server MUST be on code that has BOTH:                           │
   │   • #520 / plan 182 — the roster-coverage guard (so the re-run recovers     │
   │     the missing speakers), AND                                              │
   │   • #521 / plan 183 — preserve-voices-on-re-analysis (re-analysis on older  │
   │     code STRIPS designed-voice links from cast.json).                       │
   │ This script backs up cast.json before each re-run as insurance, but do not  │
   │ --apply until both are merged + the app is restarted.                       │
   └────────────────────────────────────────────────────────────────────────────┘

   Usage (from repo root, server running):
     npx tsx scripts/repair-missing-speakers.mts                      # dry-run: audit ALL books
     npx tsx scripts/repair-missing-speakers.mts --book The Drowning Bell   # dry-run: one book
     npx tsx scripts/repair-missing-speakers.mts --apply              # re-run + verify ALL affected books
     npx tsx scripts/repair-missing-speakers.mts --book The Drowning Bell --apply

   Flags:
     --book <substr>     only books whose "Author — Title" label matches (ci).
     --manuscript <id>   only this manuscriptId.
     --chapters a,b,c    override the chapter list (implies a single book; use with --book).
     --apply             actually back up + POST the re-analysis; otherwise dry-run.

   Env:
     BASE           server base URL (default http://localhost:8080)
     WORKSPACE_DIR  workspace root containing books/ (default ../audiobook-workspace, then $WORKSPACE_DIR) */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEpub } from '../server/src/parsers/epub.js';
import {
  validateRosterCoverage,
  validateAttributionCoverage,
} from '../server/src/analyzer/roster-coverage.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const WORKSPACE_DIR = resolve(process.env.WORKSPACE_DIR || join(repoRoot, '..', 'audiobook-workspace'));
const BASE = (process.env.BASE || 'http://localhost:8080').replace(/\/$/, '');

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const apply = argv.includes('--apply');
/* --force: re-run the given --chapters even when BOTH audits are already clean.
   The half-state (rostered speaker, 0 attributed lines) is now detected by
   `validateAttributionCoverage`, so --force is no longer required for it — keep
   this only as a manual escape hatch for chapters neither check flags. Requires
   --chapters. */
const force = argv.includes('--force');
const bookFilter = flag('--book')?.toLowerCase() ?? null;
const manuscriptArg = flag('--manuscript');
const chaptersOverride = flag('--chapters')
  ?.split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n)) ?? null;

interface StateJson {
  manuscriptId?: string;
  title?: string;
  author?: string;
  chapters?: Array<{ id: number; title?: string; excluded?: boolean }>;
}
interface CastJson {
  characters?: Array<{ id?: string; name?: string; aliases?: string[]; lines?: number }>;
}
interface EditsJson {
  sentences?: Array<{ chapterId: number; characterId: string }>;
}
interface Book {
  bookDir: string;
  label: string;
  manuscriptId: string;
  state: StateJson;
}

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

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

function rosterNamesOf(cast: CastJson | null): string[] {
  const names: string[] = [];
  for (const c of cast?.characters ?? []) {
    if (c.name) names.push(c.name);
    for (const a of c.aliases ?? []) names.push(a);
  }
  return names;
}

function narratorCounts(edits: EditsJson | null, chapterIds: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const id of chapterIds) m.set(id, 0);
  for (const s of edits?.sentences ?? []) {
    if (m.has(s.chapterId) && s.characterId === 'narrator') m.set(s.chapterId, (m.get(s.chapterId) ?? 0) + 1);
  }
  return m;
}

function lineCountFor(edits: EditsJson | null, characterId: string): number {
  let n = 0;
  for (const s of edits?.sentences ?? []) if (s.characterId === characterId) n += 1;
  return n;
}

/** All books, filtered by --book / --manuscript. */
function resolveBooks(): Book[] {
  const books: Book[] = [];
  for (const sf of findStateFiles(join(WORKSPACE_DIR, 'books'))) {
    const state = readJson<StateJson>(sf);
    if (!state?.manuscriptId) continue;
    const bookDir = dirname(dirname(sf));
    const label = `${state.author ? state.author + ' — ' : ''}${state.title || bookDir}`;
    if (manuscriptArg && state.manuscriptId !== manuscriptArg) continue;
    if (!manuscriptArg && bookFilter && !label.toLowerCase().includes(bookFilter)) continue;
    books.push({ bookDir, label, manuscriptId: state.manuscriptId, state });
  }
  return books;
}

interface Finding {
  chapterId: number;
  title: string;
  /** Speakers prose-tagged but ABSENT from the roster (validateRosterCoverage). */
  speakers: { name: string; id: string; tagCount: number }[];
  /** Speakers IN the roster but with 0 attributed lines in this chapter — the
      interrupted-re-analysis half-state (#529, validateAttributionCoverage). */
  halfState: { name: string; id: string; tagCount: number; narratorLines: number }[];
}

/** Group manuscript-edits.json sentences by chapter for the attribution check. */
function sentencesByChapter(edits: EditsJson | null): Map<number, { characterId: string }[]> {
  const m = new Map<number, { characterId: string }[]>();
  for (const s of edits?.sentences ?? []) {
    const arr = m.get(s.chapterId) ?? [];
    arr.push({ characterId: s.characterId });
    m.set(s.chapterId, arr);
  }
  return m;
}

function rosterObjectsOf(cast: CastJson | null): Array<{ id: string; name: string; aliases?: string[] }> {
  return (cast?.characters ?? [])
    .filter((c) => c.id && c.name)
    .map((c) => ({ id: c.id!, name: c.name!, aliases: c.aliases }));
}

async function auditBook(book: Book): Promise<{ findings: Finding[]; cast: CastJson | null } | null> {
  const cast = readJson<CastJson>(join(book.bookDir, '.audiobook', 'cast.json'));
  const epub = join(book.bookDir, 'manuscript.epub');
  if (!existsSync(epub)) return null; // non-EPUB: audit needs parsed prose
  let parsed;
  try {
    parsed = await parseEpub(Buffer.alloc(0), { sourcePath: epub, fileName: 'manuscript.epub' });
  } catch {
    return null;
  }
  const excluded = new Set((book.state.chapters ?? []).filter((c) => c.excluded).map((c) => c.id));
  const rosterNames = rosterNamesOf(cast);
  const roster = rosterObjectsOf(cast);
  const edits = readJson<EditsJson>(join(book.bookDir, '.audiobook', 'manuscript-edits.json'));
  const byChapter = sentencesByChapter(edits);
  const findings: Finding[] = [];
  for (const ch of parsed.chapters) {
    if (excluded.has(ch.id)) continue;
    // (a) tagged speaker absent from the roster.
    const v = validateRosterCoverage(ch.body, rosterNames);
    // (b) rostered speaker prose-tagged but with 0 attributed lines (half-state).
    const av = validateAttributionCoverage(ch.body, roster, byChapter.get(ch.id) ?? []);
    if (!v.ok || !av.ok)
      findings.push({
        chapterId: ch.id,
        title: ch.title,
        speakers: v.missingSpeakers.map((s) => ({ name: s.name, id: s.id, tagCount: s.tagCount })),
        halfState: av.halfStateSpeakers.map((s) => ({
          name: s.name,
          id: s.id,
          tagCount: s.tagCount,
          narratorLines: s.narratorLines,
        })),
      });
  }
  return { findings, cast };
}

/** Snapshot cast.json next to it as insurance before a re-run. */
function backupCast(bookDir: string): string {
  const castPath = join(bookDir, '.audiobook', 'cast.json');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(bookDir, '.audiobook', `cast.before-repair-${stamp}.json`);
  writeFileSync(dest, readFileSync(castPath, 'utf8'), 'utf8');
  return dest;
}

async function rerun(manuscriptId: string, chapterIds: number[]): Promise<boolean> {
  const url = `${BASE}/api/manuscripts/${manuscriptId}/analysis/chapters`;
  console.log(`  ▶ POST ${url}  { chapterIds: [${chapterIds.join(', ')}] }`);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chapterIds }),
    });
  } catch (err) {
    console.error(`  ✗ Could not reach the server at ${BASE} (${(err as Error).message}).`);
    console.error('    Start the app and ensure it is on the #520 + #521 code, then restart it.');
    return false;
  }
  if (!resp.ok || !resp.body) {
    console.error(`  ✗ Server returned ${resp.status} ${resp.statusText}.`);
    return false;
  }
  const decoder = new TextDecoder();
  let buf = '';
  let ok = true;
  // @ts-expect-error — Node's fetch body is an async-iterable web stream.
  for await (const chunk of resp.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev: {
        kind?: string;
        message?: string;
        chapterId?: number;
        characters?: unknown[];
        code?: string;
      };
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.kind === 'log') console.log(`    · ${ev.message}`);
      else if (ev.kind === 'chapter-failed') console.log(`    ❌ chapter ${ev.chapterId} failed: ${ev.message}`);
      else if (ev.kind === 'cast-update') console.log(`    ↻ cast updated (${ev.characters?.length ?? '?'} characters)`);
      else if (ev.kind === 'error') {
        ok = false;
        console.error(`    ✗ ${ev.code}: ${ev.message}`);
      } else if (ev.kind === 'result') console.log('    ✓ subset re-analysis complete.');
    }
  }
  return ok;
}

async function main(): Promise<void> {
  console.log('=== Repair missing speakers (data half — steps 1–3) ===');
  console.log('workspace:', WORKSPACE_DIR);
  console.log('server   :', BASE);
  console.log('mode     :', apply ? 'APPLY' : 'dry-run', '\n');

  const books = resolveBooks();
  if (books.length === 0) {
    console.error('No matching books found. Pass --book <substr> or --manuscript <id>, or drop the filter for all books.');
    process.exit(2);
  }
  if (chaptersOverride && books.length > 1) {
    console.error('--chapters only makes sense for a single book — narrow with --book / --manuscript.');
    process.exit(2);
  }

  // ── Step 1: audit every book ──
  console.log(`── Step 1: audit (${books.length} book${books.length === 1 ? '' : 's'}) ──`);
  const affected: Array<{ book: Book; findings: Finding[]; chapterIds: number[]; recovered: Set<string> }> = [];
  for (const book of books) {
    const res = await auditBook(book);
    if (!res) continue; // non-EPUB / unreadable
    if (res.findings.length === 0) {
      if (force && chaptersOverride) {
        console.log(
          `  📕 ${book.label} — roster audit clean, but --force re-running chapters [${chaptersOverride.join(', ')}] for stage-2 re-attribution`,
        );
        affected.push({ book, findings: [], chapterIds: chaptersOverride, recovered: new Set() });
      } else if (bookFilter || manuscriptArg) {
        console.log(`  ✅ ${book.label} — clean`);
      }
      continue;
    }
    const recovered = new Set<string>();
    console.log(`  📕 ${book.label}`);
    for (const f of res.findings) {
      const parts: string[] = [];
      if (f.speakers.length)
        parts.push(`uncast: ${f.speakers.map((s) => `${s.name}×${s.tagCount}`).join(', ')}`);
      if (f.halfState.length)
        parts.push(
          `0-line half-state: ${f.halfState
            .map((s) => `${s.name}×${s.tagCount} (narrator ${s.narratorLines})`)
            .join(', ')}`,
        );
      console.log(`       ch ${f.chapterId} "${f.title}": ${parts.join('; ')}`);
      for (const s of f.speakers) recovered.add(s.id);
      for (const s of f.halfState) recovered.add(s.id);
    }
    const chapterIds = chaptersOverride ?? [...new Set(res.findings.map((f) => f.chapterId))].sort((a, b) => a - b);
    affected.push({ book, findings: res.findings, chapterIds, recovered });
  }

  if (affected.length === 0) {
    console.log('\n✅ No missing speakers anywhere — nothing to repair.');
    return;
  }

  console.log('\nAffected books:');
  for (const a of affected) console.log(`  • ${a.book.label} — chapterIds [${a.chapterIds.join(', ')}]; recover: ${[...a.recovered].join(', ')}`);

  if (!apply) {
    console.log('\n[dry-run] No changes made. Re-run with --apply to back up cast.json + re-run analysis per book.');
    console.log('PREREQ: the running server must be on #520 (guard) AND #521 (preserve voices) — see header.');
    return;
  }

  // ── Step 2 + 3: per book, backup → re-run → verify ──
  for (const a of affected) {
    console.log(`\n──────── ${a.book.label} ────────`);
    const editsBefore = readJson<EditsJson>(join(a.book.bookDir, '.audiobook', 'manuscript-edits.json'));
    const narrBefore = narratorCounts(editsBefore, a.chapterIds);

    console.log('── Step 2: backup + subset re-analysis ──');
    const backup = backupCast(a.book.bookDir);
    console.log(`  cast.json backed up → ${backup}`);
    const ok = await rerun(a.book.manuscriptId, a.chapterIds);
    if (!ok) {
      console.error('  ✗ Re-analysis did not complete cleanly — skipping verify for this book. cast.json backup is intact.');
      continue;
    }

    console.log('── Step 3: verify ──');
    const after = await auditBook(a.book);
    const editsAfter = readJson<EditsJson>(join(a.book.bookDir, '.audiobook', 'manuscript-edits.json'));
    const narrAfter = narratorCounts(editsAfter, a.chapterIds);

    console.log('  narrator lines per chapter (before → after):');
    for (const id of a.chapterIds) console.log(`    ch ${id}: ${narrBefore.get(id) ?? 0} → ${narrAfter.get(id) ?? 0}`);
    console.log('  recovered characters:');
    for (const id of a.recovered) {
      const inCast = after?.cast?.characters?.find((c) => c.id === id);
      console.log(`    ${id}: ${inCast ? `IN CAST (name="${inCast.name}")` : 'NOT in cast'} — ${lineCountFor(editsAfter, id)} line(s)`);
    }
    if ((after?.findings.length ?? 0) === 0) console.log('  ✅ re-audit clean.');
    else {
      console.log('  ⚠ re-audit still flags:');
      for (const f of after!.findings) {
        const parts = [
          ...f.speakers.map((s) => `${s.name}×${s.tagCount} (uncast)`),
          ...f.halfState.map((s) => `${s.name}×${s.tagCount} (0 lines)`),
        ];
        console.log(`    ch ${f.chapterId}: ${parts.join(', ')}`);
      }
    }
  }

  console.log('\nNext (UI/UX — your hands):');
  console.log('  4. Cast view → design or reuse a voice for each recovered character.');
  console.log('  5. Regenerate audio for the affected chapters (already rendered with old attribution).');
  console.log('\nIf voices look stripped despite #521, restore from the cast.before-repair-*.json backup written above.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
