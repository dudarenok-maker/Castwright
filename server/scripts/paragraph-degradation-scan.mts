/* Library scanner, skeleton: every supported file is parsed in its OWN child
   process (#2254; spec docs/superpowers/specs/2026-11-13-paragraph-degradation-
   signal-design.md §4.4 step 1, R9-1 as amended by AC9 M-6, R10-5).

   Why isolation: one EPUB in the owner's library can kill its host process
   (epub2 throws `TypeError: linkparts.shift is not a function` from a zip
   callback that no `await` or `try` can reach). So the parent never parses; it
   spawns this same file with `--child <file>`, gives it 60 s, and reports a
   file that crashed, hung or exited silently as `unparsed` while the scan goes
   on.

   Modes
     --library <dir> --out <scratchDir>   walk <dir>, write <out>/scan.json and
                                          <out>/scan.md; nothing outside <out>.
     --child <file>                       parse one file, measure it, print one JSON line.
     --rewrite <epub> --to <copy>         write the #4217 what-if copy of one EPUB, print one JSON line.
     --dump <bookDir> --chapters <id,id,…> --out <dir>
                                          write the hydrated record's chapter bodies to
                                          <out>/ch<id>.txt and <out>/dump.json, read-only.
   Test-only seams (not for operators)
     --parser-module <path>  the child imports that module's default export
                             instead of parseManuscript.
     --timeout-ms <n>        per-file limit in ms instead of 60 000.
   Optional input
     --judgements <file.json>  { "<file path>#<chapterId>": "merged" | "clean" } for
                             chapters at >= 10; the summary then states the label outcome. */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fromBuffer as yauzlFromBuffer, type Entry } from 'yauzl';
import { ZipFile } from 'yazl';
import { SUPPORTED_MANUSCRIPT_EXTENSIONS } from '../src/parsers/index.js';
import { LEGACY_EXTRACTOR_VERSION } from '../src/parsers/version.js';
import {
  countTurnOpeners,
  measureChapterLegibility,
  MERGED_TURNS_DEGRADED,
  turnInParagraphRegex,
} from '../src/analyzer/dialogue-structure/legibility.js';
import { conventionsFor } from '../src/analyzer/dialogue-structure/lang/index.js';
import { detectManuscriptLanguageFromChapters } from '../src/tts/detect-language.js';

export const PER_FILE_TIMEOUT_MS = 60_000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
/* tsx's own .mjs entrypoint, run via process.execPath: no Windows .cmd shim. */
const TSX_CLI = join(SCRIPT_DIR, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

export type FileStatus = 'parsed' | 'unparsed' | 'unsupported';

export interface ScanEntry {
  path: string;
  extension: string;
  status: FileStatus;
  /** Present for `unparsed`: the child's own error message, never a stack. */
  reason?: string;
  /** Present for `parsed`: what the child reported (format, chapter count). */
  result?: Record<string, unknown>;
}

export interface ScanReport {
  library: string;
  build: string;
  entries: ScanEntry[];
}

export function extensionOf(file: string): string {
  return extname(file).slice(1).toLowerCase();
}

export function isSupported(file: string): boolean {
  return SUPPORTED_MANUSCRIPT_EXTENSIONS.includes(extensionOf(file));
}

export function walkLibrary(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    const items = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const it of items) {
      const full = join(d, it.name);
      if (it.isDirectory()) visit(full);
      else if (it.isFile()) out.push(full);
    }
  };
  visit(dir);
  return out;
}

export interface ParseOptions {
  parserModule?: string;
  timeoutMs?: number;
  /** The scan's --out dir: the only place a what-if copy is ever written. Absent:
      no what-if is computed. */
  outDir?: string;
}

/** Parse one file in its own child process and classify the outcome. An EPUB
    that parsed also gets its #4217 what-if (a rewritten scratch copy, parsed in
    its own child too) when `opts.outDir` is set. */
export function parseInIsolation(file: string, opts: ParseOptions = {}): ScanEntry {
  const entry = parseOne(file, opts);
  if (entry.status === 'parsed' && entry.result) {
    const w = whatIfFor(file, entry.result, opts);
    if (w) entry.result.whatIf = w;
  }
  return entry;
}

function parseOne(file: string, opts: ParseOptions): ScanEntry {
  const timeoutMs = opts.timeoutMs ?? PER_FILE_TIMEOUT_MS;
  const base: Pick<ScanEntry, 'path' | 'extension'> = { path: file, extension: extensionOf(file) };
  const args = [TSX_CLI, SCRIPT_PATH, '--child', file];
  if (opts.parserModule) args.push('--parser-module', opts.parserModule);

  const result = spawnSync(process.execPath, args, {
    windowsHide: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    return {
      ...base,
      status: 'unparsed',
      reason: `timed out after ${Math.round(timeoutMs / 1000)} s`,
    };
  }

  const payload = lastJsonLine(result.stdout ?? '');
  if (payload && payload.ok === true) {
    const { ok: _ok, ...rest } = payload;
    return { ...base, status: 'parsed', result: rest };
  }
  if (payload && payload.ok === false) {
    return { ...base, status: 'unparsed', reason: String(payload.error ?? 'unknown error') };
  }

  const how = result.error
    ? `error ${(result.error as NodeJS.ErrnoException).code ?? result.error.message}`
    : result.signal
      ? `signal ${result.signal}`
      : `exit code ${result.status}`;
  return { ...base, status: 'unparsed', reason: `exited without reporting (${how})` };
}

/* ---- the #4217 what-if (spec §4.4 step 1 "#4217 exposure"; R4-8 as amended by R5-8) -- */

/** The block closers `stripHtml` drops at extractor version 1: extractor version
    2's list (`html-utils.ts`). The scanner reads every library file as a book
    without a `manuscriptExtractorVersion` stamp (a library file has no
    state.json), so this list always applies. */
export const WHAT_IF_CLOSERS = /<\/\s*(?:div|li|blockquote|h[1-6]|dd|dt|section|article)\s*>/gi;

export type WhatIfStatus = 'paired' | 'not aligned' | 'not computed' | 'failed';

export interface WhatIfChapter {
  id: number;
  title: string;
  /** Legibility of the imported text, and of the same chapter in the copy. */
  legibility: number | null;
  whatIfLegibility: number | null;
  /** Flagged (>= MERGED_TURNS_DEGRADED) on the imported text and below it in the copy. */
  extractorMerged: boolean;
}

export interface WhatIfResult {
  status: WhatIfStatus;
  /** Why not paired: 'not aligned' names the mismatch; 'failed' the copy or parse error. */
  reason?: string;
  /** Closers the rewrite put a `<br/>` after, over every XHTML entry of the book. */
  closersInserted?: number;
  chapters?: WhatIfChapter[];
}

function whatIfFor(
  file: string,
  result: Record<string, unknown>,
  opts: ParseOptions,
): WhatIfResult | undefined {
  const format = String(result.format ?? '');
  if (format === 'mobi') {
    return { status: 'not computed', reason: "MOBI's HTML sits inside a compressed binary" };
  }
  if (format !== 'epub' || !opts.outDir) return undefined;
  const timeoutMs = opts.timeoutMs ?? PER_FILE_TIMEOUT_MS;
  const dir = join(opts.outDir, 'whatif', createHash('sha1').update(file).digest('hex').slice(0, 12));
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, basename(file));
  const rw = spawnSync(process.execPath, [TSX_CLI, SCRIPT_PATH, '--rewrite', file, '--to', copy], {
    windowsHide: true,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const rwPayload = lastJsonLine(rw.stdout ?? '');
  if (!rwPayload || rwPayload.ok !== true) {
    return {
      status: 'failed',
      reason: `copy not written: ${String(rwPayload?.error ?? `exit ${rw.status}`)}`,
    };
  }
  const copyEntry = parseOne(copy, opts);
  if (copyEntry.status !== 'parsed' || !copyEntry.result) {
    return { status: 'failed', reason: `copy did not parse: ${copyEntry.reason ?? 'unknown'}` };
  }
  return pairWhatIf(
    result.chapters as MeasuredChapter[],
    copyEntry.result.chapters as MeasuredChapter[],
    Number(rwPayload.closers ?? 0),
  );
}

/** Pair the imported and what-if chapter lists by position, only when they have
    the same count AND the same titles; otherwise the book is "not aligned" and
    no chapter is labelled. */
export function pairWhatIf(
  imported: Array<Pick<MeasuredChapter, 'id' | 'title' | 'legibility'>>,
  copy: Array<Pick<MeasuredChapter, 'title' | 'legibility'>>,
  closersInserted: number,
): WhatIfResult {
  if (imported.length !== copy.length) {
    return {
      status: 'not aligned',
      reason: `${imported.length} chapters imported, ${copy.length} in the copy`,
      closersInserted,
    };
  }
  const at = imported.findIndex((c, i) => c.title !== copy[i].title);
  if (at >= 0) {
    return { status: 'not aligned', reason: `chapter ${at + 1} title differs`, closersInserted };
  }
  return {
    status: 'paired',
    closersInserted,
    chapters: imported.map((c, i) => ({
      id: c.id,
      title: c.title,
      legibility: c.legibility,
      whatIfLegibility: copy[i].legibility,
      extractorMerged:
        c.legibility !== null &&
        c.legibility >= MERGED_TURNS_DEGRADED &&
        copy[i].legibility !== null &&
        (copy[i].legibility as number) < MERGED_TURNS_DEGRADED,
    })),
  };
}

function whatIfOf(e: ScanEntry): WhatIfResult | undefined {
  return e.result?.whatIf as WhatIfResult | undefined;
}

/** True when the book's what-if labels this chapter extractor-merged (#4217). */
export function isLabelledExtractorMerged(e: ScanEntry, chapterId: number): boolean {
  return whatIfOf(e)?.chapters?.some((c) => c.id === chapterId && c.extractorMerged) ?? false;
}

/** Labelled books first, so the owner sees which books #4217 affects; then
    every book whose what-if was not paired, and why. */
export function renderExtractorExposure(parsed: ScanEntry[]): string[] {
  const labelled = parsed.filter((e) => whatIfOf(e)?.chapters?.some((c) => c.extractorMerged));
  const lines = [`## Extractor-merged (#4217): books the extractor merges (${labelled.length})`, ''];
  if (!labelled.length) lines.push('None.');
  for (const e of labelled) {
    const w = whatIfOf(e) as WhatIfResult;
    lines.push(`- ${e.path}: ${w.closersInserted ?? 0} closers inserted`);
    for (const c of (w.chapters ?? []).filter((x) => x.extractorMerged)) {
      lines.push(
        `  - chapter ${c.id} "${c.title}": extractor-merged (#4217), ${c.legibility} imported, ${c.whatIfLegibility} in the what-if`,
      );
    }
  }
  const other = parsed.filter((e) => {
    const w = whatIfOf(e);
    return w && w.status !== 'paired';
  });
  lines.push('', `## What-if not paired (${other.length})`, '');
  if (!other.length) lines.push('None.');
  for (const e of other) {
    const w = whatIfOf(e) as WhatIfResult;
    lines.push(`- ${e.path}: what-if ${w.status}${w.reason ? ` (${w.reason})` : ''}`);
  }
  lines.push('');
  return lines;
}

/* The rewrite: a copy of the EPUB with a `<br/>` after every closer `stripHtml`
   drops, on every XHTML entry. Runs in its own child like any parse. */
async function readZipEntries(buffer: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  return new Promise((resolveAll, reject) => {
    yauzlFromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('not a zip'));
      const out: Array<{ name: string; data: Buffer }> = [];
      zip.on('error', reject);
      zip.on('end', () => resolveAll(out));
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export async function rewriteEpub(buffer: Buffer): Promise<{ copy: Buffer; closers: number }> {
  const entries = await readZipEntries(buffer);
  let closers = 0;
  const zip = new ZipFile();
  for (const { name, data } of entries) {
    let body = data;
    if (/\.x?html?$/i.test(name)) {
      body = Buffer.from(
        data.toString('utf8').replace(WHAT_IF_CLOSERS, (m) => {
          closers++;
          return `${m}<br/>`;
        }),
        'utf8',
      );
    }
    zip.addBuffer(body, name, { compress: false });
  }
  zip.end();
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveEnd, reject) => {
    zip.outputStream
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolveEnd())
      .on('error', reject);
  });
  return { copy: Buffer.concat(chunks), closers };
}

function lastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean') {
        return v as Record<string, unknown>;
      }
    } catch {
      /* not the report line; keep looking */
    }
  }
  return null;
}

export function buildId(): string {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: SCRIPT_DIR,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

export function scanLibrary(library: string, opts: ParseOptions = {}): ScanReport {
  const entries: ScanEntry[] = [];
  for (const file of walkLibrary(library)) {
    if (!isSupported(file)) {
      entries.push({ path: file, extension: extensionOf(file), status: 'unsupported' });
      continue;
    }
    entries.push(parseInIsolation(file, opts));
  }
  return { library, build: buildId(), entries };
}

function measurementOf(e: ScanEntry): BookMeasurement | null {
  const r = e.result as Partial<BookMeasurement> | undefined;
  return r && r.language && r.lineWrap && r.dialogue ? (r as BookMeasurement) : null;
}

function renderMeasured(parsed: ScanEntry[]): string[] {
  const rows = parsed
    .map((e) => ({ e, m: measurementOf(e) }))
    .filter((x): x is { e: ScanEntry; m: BookMeasurement } => x.m !== null)
    .sort((a, b) => (b.m.bookMax ?? -1) - (a.m.bookMax ?? -1));
  const lines = [`## Books by worst-paragraph turn openers (${rows.length})`, ''];
  if (!rows.length) lines.push('None.');
  for (const { e, m } of rows) {
    const flags = [
      m.lineWrap.wrapped ? `line-wrapped (${m.lineWrap.arms.join('+')})` : '',
      m.dialogue.dense ? 'dialogue-dense' : '',
    ].filter(Boolean);
    lines.push(
      `- ${e.path}: max ${m.bookMax ?? 'not measured'}; lang ${m.language.detected}` +
        ` (declared ${m.language.declared ?? 'none'}); wrap ${m.lineWrap.continuationLines}/${m.lineWrap.nonBlankLines}` +
        ` (${(m.lineWrap.share * 100).toFixed(1)}%); dash turns ${m.dialogue.dashTurns ?? 'n/a'}` +
        ` (${m.dialogue.per1000Words === null ? 'n/a' : m.dialogue.per1000Words.toFixed(1)}/1000 words)` +
        (flags.length ? `; ${flags.join(', ')}` : ''),
    );
    for (const c of m.chapters) {
      if (c.worstParagraph) {
        lines.push(
          `  - chapter ${c.id} "${c.title}" at ${c.legibility}: ${JSON.stringify(c.worstParagraph.text)}`,
        );
      }
    }
  }
  const cyr = rows.filter((x) => x.m.nonRuCyrillic);
  lines.push('', `## Non-ru Cyrillic books (${cyr.length})`, '');
  lines.push(
    ...(cyr.length
      ? cyr.map(
          (x) =>
            `- ${x.e.path} (detected ${x.m.language.detected}, declared ${x.m.language.declared ?? 'none'})`,
        )
      : ['None.']),
  );
  lines.push('');
  return lines;
}

/* ---- calibration candidates and the label outcome (spec §2, §4.4 step 1) -- */

/** The owner's verdict on a chapter at >= MERGED_TURNS_DEGRADED, keyed `<file path>#<chapterId>`. */
export type Judgements = Record<string, 'merged' | 'clean'>;

export interface SummaryOptions {
  judgements?: Judgements;
  /** Hook for the extractor-merged (#4217) label: such a chapter is a true
      positive, never a breach, even when the owner judged it clean. */
  isExtractorMerged?: (path: string, chapterId: number) => boolean;
}

export function judgementKey(path: string, chapterId: number): string {
  return `${path}#${chapterId}`;
}

export function renderCandidates(parsed: ScanEntry[]): string[] {
  const rows = parsed
    .map((e) => ({ e, m: measurementOf(e) }))
    .filter((x): x is { e: ScanEntry; m: BookMeasurement } => x.m !== null);
  const cands = rows.filter((x) => x.m.calibrationCandidate);
  const lines = [`## Clean, dialogue-dense ru dash books (${cands.length})`, ''];
  lines.push(...(cands.length ? cands.map((x) => `- ${x.e.path}`) : ['None.']));
  const checked = rows.filter((x) => (x.m.strayBreaks?.checked ?? 0) > 0);
  lines.push('', `## Stray-break check (${checked.length} books with continuation lines)`, '');
  if (!checked.length) lines.push('None.');
  for (const { e, m } of checked) {
    const s = m.strayBreaks;
    const arm = m.lineWrap.arms.length ? m.lineWrap.arms.join('+') : 'none';
    const iso =
      s.isolation === 'pass'
        ? 'isolation pass'
        : `isolation fail (chapter ${s.isolation.chapterId} line ${s.isolation.line}: ${s.isolation.why})`;
    lines.push(
      `- ${e.path}: flagged by ${arm}; ${s.checked} continuation lines; ${iso};` +
        ` largest window ${s.largestWindow}; ${s.pass ? 'candidate-eligible' : 'disqualified'}`,
    );
  }
  lines.push('');
  return lines;
}

export function renderLabelOutcome(parsed: ScanEntry[], opts: SummaryOptions = {}): string[] {
  const rows = parsed
    .map((e) => ({ e, m: measurementOf(e) }))
    .filter((x): x is { e: ScanEntry; m: BookMeasurement } => x.m !== null);
  const high: Array<{ e: ScanEntry; path: string; chapterId: number; count: number; format: string }> = [];
  for (const { e, m } of rows) {
    for (const c of m.chapters) {
      if ((c.legibility ?? -1) >= MERGED_TURNS_DEGRADED) {
        high.push({ e, path: e.path, chapterId: c.id, count: c.legibility as number, format: String(e.result?.format ?? '') });
      }
    }
  }
  const lines = [`## Label outcome (${MERGED_TURNS_DEGRADED} is provisional)`, ''];
  const j = opts.judgements;
  const unjudged = high.filter((h) => !j || j[judgementKey(h.path, h.chapterId)] === undefined);
  if (!j || unjudged.length) {
    lines.push('label: pending owner judgement');
    lines.push(
      ...(unjudged.length
        ? unjudged.map((h) => `- to judge: ${h.path} chapter ${h.chapterId} at ${h.count} (${h.format})`)
        : ['- no judgements file given (--judgements <file.json>)']),
    );
    lines.push('');
    return lines;
  }
  const breaches = high.filter(
    (h) =>
      j[judgementKey(h.path, h.chapterId)] === 'clean' &&
      !(opts.isExtractorMerged?.(h.path, h.chapterId) ?? false) &&
      !isLabelledExtractorMerged(h.e, h.chapterId),
  );
  const cands = rows.filter((x) => x.m.calibrationCandidate);
  if (!breaches.length && cands.length) {
    lines.push(`label may drop: no breach in any scanned book; candidate ${cands[0].e.path}`);
  } else {
    lines.push('label stays provisional');
    for (const b of breaches) {
      lines.push(`- breach: ${b.path} chapter ${b.chapterId} at ${b.count} (${b.format})`);
    }
    if (!cands.length) lines.push('- no clean, dialogue-dense ru dash book');
  }
  lines.push('');
  return lines;
}

export function renderSummary(report: ScanReport, opts: SummaryOptions = {}): string {
  const by = (s: FileStatus): ScanEntry[] => report.entries.filter((e) => e.status === s);
  const parsed = by('parsed');
  const unparsed = by('unparsed');
  const unsupported = by('unsupported');
  const lines = [
    '# Paragraph-degradation library scan',
    '',
    `Library: ${report.library}`,
    `Build: ${report.build}`,
    '',
    `Files: ${report.entries.length} (parsed ${parsed.length}, unparsed ${unparsed.length}, unsupported ${unsupported.length})`,
    '',
    ...renderExtractorExposure(parsed),
    ...renderMeasured(parsed),
    ...renderCandidates(parsed),
    ...renderLabelOutcome(parsed, opts),
    `## Unparsed (${unparsed.length})`,
    '',
    ...(unparsed.length ? unparsed.map((e) => `- ${e.path}: ${e.reason}`) : ['None.']),
    '',
    `## Unsupported (${unsupported.length})`,
    '',
    ...(unsupported.length
      ? unsupported.map((e) => `- ${e.path} (.${e.extension || 'none'})`)
      : ['None.']),
    '',
  ];
  return lines.join('\n');
}

export function writeReport(report: ScanReport, out: string, opts: SummaryOptions = {}): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'scan.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(join(out, 'scan.md'), renderSummary(report, opts), 'utf8');
}

/* ---- measurements (spec §4.4 step 1: R7-5, R7-6, Decision 4) ------------ */

/** Share of non-blank lines that are continuation lines at or above which a
    book counts as line-wrapped (share arm; owner decision 13). */
export const LINE_WRAP_SHARE = 0.02;
/** Continuation-line count at or above which a book counts as line-wrapped
    (count arm). */
export const LINE_WRAP_COUNT = 10;
/** Dialogue-dense: dash turns per 1,000 words AND total dash turns (R7-5). */
export const DENSE_PER_1000_WORDS = 25;
export const DENSE_MIN_TURNS = 1000;
/** Languages written in Cyrillic other than ru (Decision 4). */
const NON_RU_CYRILLIC = new Set(['uk', 'bg', 'be', 'sr', 'mk', 'kk', 'ky', 'mn', 'tg']);

export interface MeasuredChapter {
  id: number;
  title: string;
  /** false: the language has no paragraph-dash conventions ("not measured", never 0). */
  measured: boolean;
  legibility: number | null;
  turnOpeners: number | null;
  dashParagraphs: number | null;
  /** Only for a chapter at >= MERGED_TURNS_DEGRADED. */
  worstParagraph?: { count: number; text: string };
}

export interface BookMeasurement {
  language: {
    detected: string;
    detectedSource: 'detectManuscriptLanguageFromChapters';
    declared: string | null;
    declaredSource: 'metadata.opf' | null;
  };
  chapters: MeasuredChapter[];
  bookMax: number | null;
  lineWrap: {
    wrapped: boolean;
    arms: Array<'pdf' | 'share' | 'count'>;
    continuationLines: number;
    nonBlankLines: number;
    share: number;
  };
  dialogue: {
    dashTurns: number | null;
    words: number;
    per1000Words: number | null;
    dense: boolean | null;
  };
  nonRuCyrillic: boolean;
  /** Spec §4.4 step 1 "stray breaks": the fail-closed check on every continuation line. */
  strayBreaks: StrayBreakResult;
  /** Whether the book may calibrate the threshold (a clean, dialogue-dense ru dash book). */
  calibrationCandidate: boolean;
  /** Why not, when `calibrationCandidate` is false. */
  calibrationReason?: CalibrationReason;
}

export type CalibrationReason =
  | 'pdf'
  | 'share-arm'
  | 'not ru'
  | 'not dialogue-dense'
  | 'stray-break check'
  | 'chapter >= 10'
  | 'unparsed';

export interface StrayBreakResult {
  /** Continuation lines checked (0: the check passes trivially). */
  checked: number;
  /** Every one of them is an isolated stray break (the strict reading), else the first failure. */
  isolation:
    | 'pass'
    | {
        chapterId: number;
        line: number;
        why: 'adjacent' | 'within two lines';
      };
  /** Largest TURN_IN_PARAGRAPH count over every neighbour window (null: none checked). */
  largestWindow: number | null;
  /** Every window holds fewer than MERGED_TURNS_DEGRADED matches. */
  windowPass: boolean;
  /** Isolation passes and windowPass: the book stays a candidate. */
  pass: boolean;
}

export interface ParsedLike {
  format: string;
  chapters: Array<{ id?: number; title?: string; body?: string }>;
  author?: string | null;
  title?: string | null;
}

/** The `<dc:language>` of a Calibre `metadata.opf` next to `file`, else null. */
export function declaredLanguageOf(file: string): string | null {
  try {
    const opf = readFileSync(join(dirname(file), 'metadata.opf'), 'utf8');
    const m = /<dc:language[^>]*>\s*([^<\s][^<]*?)\s*<\/dc:language>/iu.exec(opf);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Dash-turn density bars, in integers (no float edge at exactly 25). */
export function isDialogueDense(dashTurns: number, words: number): boolean {
  return dashTurns >= DENSE_MIN_TURNS && dashTurns * 1000 >= DENSE_PER_1000_WORDS * words;
}

/** A continuation line directly follows another non-blank line (a single \n)
    and starts with a lowercase letter. */
export function countContinuationLines(body: string): { continuation: number; nonBlank: number } {
  const lines = body.split('\n');
  let continuation = 0;
  let nonBlank = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    nonBlank++;
    if (i > 0 && lines[i - 1].trim() && /^\s*\p{Ll}/u.test(lines[i])) continuation++;
  }
  return { continuation, nonBlank };
}

/** Indices (into `body.split('\n')`) of the continuation lines. */
function continuationIndices(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() && lines[i - 1].trim() && /^\s*\p{Ll}/u.test(lines[i])) out.push(i);
  }
  return out;
}

/** The fail-closed stray-break check (spec §4.4 step 1; owner decisions 15, 21).
    For each continuation line `i` the fragment is lines i-1..i. Isolation: no
    other continuation line within two lines of the fragment (i-3..i+2), which
    also covers the lines directly before (i-2) and after (i+1) it; two adjacent
    continuation lines therefore always fail. Window: lines i-2..i+1 joined with
    ONE space (restoring a match a break destroyed at an edge) hold fewer than
    MERGED_TURNS_DEGRADED TURN_IN_PARAGRAPH matches. */
export function checkStrayBreaks(chapters: Array<{ id: number; body: string }>): StrayBreakResult {
  let checked = 0;
  let largest: number | null = null;
  let isolation: StrayBreakResult['isolation'] = 'pass';
  for (const c of chapters) {
    const lines = c.body.split('\n');
    const cont = continuationIndices(lines);
    const set = new Set(cont);
    for (const i of cont) {
      checked++;
      if (isolation === 'pass') {
        if (set.has(i - 1) || set.has(i + 1)) {
          isolation = { chapterId: c.id, line: i + 1, why: 'adjacent' };
        } else if (set.has(i - 2) || set.has(i + 2) || set.has(i - 3)) {
          isolation = { chapterId: c.id, line: i + 1, why: 'within two lines' };
        }
      }
      const window = lines.slice(Math.max(0, i - 2), i + 2).join(' ');
      const n = (window.match(turnInParagraphRegex()) ?? []).length;
      if (largest === null || n > largest) largest = n;
    }
  }
  const windowPass = largest === null || largest < MERGED_TURNS_DEGRADED;
  return {
    checked,
    isolation,
    largestWindow: largest,
    windowPass,
    pass: isolation === 'pass' && windowPass,
  };
}

function isRu(l: string | null): boolean {
  return !!l && l.toLowerCase().split(/[-_]/u)[0] === 'ru';
}

function worstParagraphOf(body: string): { count: number; text: string } | undefined {
  let best: { count: number; text: string } | undefined;
  for (const paragraph of body.split('\n')) {
    if (!paragraph.trim()) continue;
    const count = (paragraph.match(turnInParagraphRegex()) ?? []).length;
    if (!best || count > best.count) best = { count, text: paragraph.slice(0, 400) };
  }
  return best;
}

function wordCount(body: string): number {
  return (body.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function measureBook(
  parsed: ParsedLike,
  opts: { declaredLanguage?: string | null; language?: string } = {},
): BookMeasurement {
  const chapters = parsed.chapters.map((c, i) => ({
    id: c.id ?? i + 1,
    title: c.title ?? '',
    body: c.body ?? '',
  }));
  const detected =
    opts.language ??
    detectManuscriptLanguageFromChapters(chapters, { author: parsed.author, title: parsed.title })
      .language;
  const declared = opts.declaredLanguage ?? null;
  const conventions = conventionsFor(detected);

  let bookMax: number | null = null;
  let dashTurns = 0;
  let words = 0;
  let continuation = 0;
  let nonBlank = 0;
  const measuredChapters: MeasuredChapter[] = chapters.map((c) => {
    words += wordCount(c.body);
    const wrap = countContinuationLines(c.body);
    continuation += wrap.continuation;
    nonBlank += wrap.nonBlank;
    const legibility = conventions ? measureChapterLegibility(c.body, conventions) : undefined;
    if (!conventions || legibility === undefined) {
      return {
        id: c.id,
        title: c.title,
        measured: false,
        legibility: null,
        turnOpeners: null,
        dashParagraphs: null,
      };
    }
    const openers = countTurnOpeners(c.body);
    const open = conventions.dialogueOpen as RegExp;
    const dashParagraphs = c.body.split('\n').filter((l) => l.trim() && open.test(l)).length;
    dashTurns += dashParagraphs + openers;
    bookMax = bookMax === null ? legibility : Math.max(bookMax, legibility);
    const out: MeasuredChapter = {
      id: c.id,
      title: c.title,
      measured: true,
      legibility,
      turnOpeners: openers,
      dashParagraphs,
    };
    if (legibility >= MERGED_TURNS_DEGRADED) out.worstParagraph = worstParagraphOf(c.body);
    return out;
  });

  const arms: Array<'pdf' | 'share' | 'count'> = [];
  if (parsed.format === 'pdf') arms.push('pdf');
  if (nonBlank > 0 && continuation / nonBlank >= LINE_WRAP_SHARE) arms.push('share');
  if (continuation >= LINE_WRAP_COUNT) arms.push('count');

  const dialogueMeasured = measuredChapters.some((c) => c.measured);
  const strayBreaks = checkStrayBreaks(chapters);
  const dense = dialogueMeasured ? isDialogueDense(dashTurns, words) : null;
  const hasMergedChapter = measuredChapters.some((c) => (c.legibility ?? -1) >= MERGED_TURNS_DEGRADED);
  let calibrationReason: CalibrationReason | undefined;
  if (arms.includes('pdf')) calibrationReason = 'pdf';
  else if (arms.includes('share')) calibrationReason = 'share-arm';
  else if (!isRu(detected) && !isRu(declared)) calibrationReason = 'not ru';
  else if (!dense) calibrationReason = 'not dialogue-dense';
  else if (!strayBreaks.pass) calibrationReason = 'stray-break check';
  else if (hasMergedChapter) calibrationReason = 'chapter >= 10';
  const cyr = (l: string | null): boolean =>
    !!l && NON_RU_CYRILLIC.has(l.toLowerCase().split(/[-_]/u)[0]);
  return {
    language: {
      detected,
      detectedSource: 'detectManuscriptLanguageFromChapters',
      declared,
      declaredSource: declared ? 'metadata.opf' : null,
    },
    chapters: measuredChapters,
    bookMax,
    lineWrap: {
      wrapped: arms.length > 0,
      arms,
      continuationLines: continuation,
      nonBlankLines: nonBlank,
      share: nonBlank > 0 ? continuation / nonBlank : 0,
    },
    dialogue: {
      dashTurns: dialogueMeasured ? dashTurns : null,
      words,
      per1000Words: dialogueMeasured && words > 0 ? (dashTurns * 1000) / words : null,
      dense,
    },
    nonRuCyrillic: cyr(detected) || cyr(declared),
    strayBreaks,
    calibrationCandidate: calibrationReason === undefined,
    ...(calibrationReason ? { calibrationReason } : {}),
  };
}

/* ---- child ------------------------------------------------------------- */

function report(obj: Record<string, unknown>): void {
  writeSync(1, JSON.stringify(obj) + '\n');
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runChild(file: string, parserModule?: string): Promise<void> {
  const fail = (e: unknown): never => {
    report({ ok: false, error: messageOf(e) });
    process.exit(1);
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);

  try {
    const parse = parserModule
      ? ((await import(pathToFileURL(resolve(parserModule)).href)) as { default: ParseFn }).default
      : ((await import('../src/parsers/index.js')) as { parseManuscript: ParseFn }).parseManuscript;
    const buffer = readFileSync(file);
    /* A library file has no state.json stamp: read it as every unstamped book is. */
    const parsed = await parse({
      buffer,
      fileName: basename(file),
      extractorVersion: LEGACY_EXTRACTOR_VERSION,
    });
    report({
      ok: true,
      format: parsed.format,
      chapterCount: parsed.chapters.length,
      ...measureBook(parsed, { declaredLanguage: declaredLanguageOf(file) }),
    });
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

type ParseFn = (input: {
  buffer: Buffer;
  fileName: string;
  extractorVersion: number;
}) => Promise<ParsedLike>;

/* ---- dump -------------------------------------------------------------- */

/* The #2254 runner reads these files, so they must be the strings analysis and
   GET /state read (a restructure held in manuscript-hints.json included), and
   producing them must write nothing under the workspace (spec §4.4 step 2).
   That rules out getOrHydrateManuscript: its book lookup applies the lazy
   self-heal, which rewrites state.json from this process, outside the running
   server's locks. So: read state.json (reads only), build the record. Neither
   findBookBy* nor anything else in scan.ts is imported here. Bodies are written
   exactly (utf8, no trim, no newline conversion): the runner and the
   measurement normalise nothing (AC5 M-8). */

export interface DumpChapterInfo {
  id: number;
  title: string;
  length: number;
  sha256: string;
}

export interface DumpManifest {
  bookId: string;
  manuscriptId: string;
  hintsSource: string;
  chapters: DumpChapterInfo[];
}

export async function dumpChapters(
  bookDir: string,
  chapterIds: number[],
  outDir: string,
): Promise<DumpManifest> {
  const { readStateJsonWithRecovery } = await import('../src/workspace/state-migrate.js');
  const { buildManuscriptRecord } = await import('../src/store/manuscripts.js');
  const dir = resolve(bookDir);
  const state = await readStateJsonWithRecovery(join(dir, '.audiobook', 'state.json'));
  if (!state) throw new Error(`no state.json under ${dir}`);
  const record = await buildManuscriptRecord(dir, state);
  if (!record) throw new Error(`no manuscript record for ${dir}`);
  if (chapterIds.length === 0) throw new Error('--chapters needs at least one chapter id');
  /* Every id is resolved before the first write: an error writes nothing. */
  const picked = chapterIds.map((id) => {
    const hint = record.chapterHints.find((h) => h.id === id);
    if (!hint) throw new Error(`unknown chapter id ${id}`);
    return hint;
  });
  const target = resolve(outDir);
  mkdirSync(target, { recursive: true });
  const chapters: DumpChapterInfo[] = [];
  for (const h of picked) {
    writeFileSync(join(target, `ch${h.id}.txt`), h.body, 'utf8');
    chapters.push({
      id: h.id,
      title: h.title,
      length: h.body.length,
      sha256: createHash('sha256').update(h.body, 'utf8').digest('hex'),
    });
  }
  const manifest: DumpManifest = {
    bookId: state.bookId,
    manuscriptId: record.manuscriptId,
    hintsSource: record.hintsSource ?? 'parse',
    chapters,
  };
  writeFileSync(join(target, 'dump.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

/* ---- entry ------------------------------------------------------------- */

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
  const rewrite = argValue(argv, '--rewrite');
  if (rewrite) {
    const to = argValue(argv, '--to');
    try {
      if (!to) throw new Error('--rewrite needs --to <copy>');
      const { copy, closers } = await rewriteEpub(readFileSync(rewrite));
      writeFileSync(to, copy);
      report({ ok: true, closers });
      return 0;
    } catch (e) {
      report({ ok: false, error: messageOf(e) });
      return 1;
    }
  }
  const dump = argValue(argv, '--dump');
  if (dump) {
    try {
      const out = argValue(argv, '--out');
      const ids = argValue(argv, '--chapters');
      if (!out || !ids) throw new Error('--dump needs --chapters <id,id,…> and --out <dir>');
      const parsed = ids.split(',').map((x) => (/^\d+$/.test(x.trim()) ? Number(x.trim()) : NaN));
      if (parsed.some((n) => !Number.isInteger(n))) throw new Error(`bad --chapters: ${ids}`);
      report({ ok: true, ...(await dumpChapters(dump, parsed, out)) });
      return 0;
    } catch (e) {
      report({ ok: false, error: messageOf(e) });
      return 1;
    }
  }
  const child = argValue(argv, '--child');
  if (child) {
    await runChild(child, argValue(argv, '--parser-module'));
    return 0;
  }
  const library = argValue(argv, '--library');
  const out = argValue(argv, '--out');
  if (!library || !out) {
    process.stderr.write('usage: paragraph-degradation-scan.mts --library <dir> --out <scratchDir>\n');
    return 2;
  }
  const t = argValue(argv, '--timeout-ms');
  const rep = scanLibrary(resolve(library), {
    parserModule: argValue(argv, '--parser-module'),
    timeoutMs: t ? Number(t) : undefined,
    outDir: resolve(out),
  });
  const jfile = argValue(argv, '--judgements');
  const judgements = jfile
    ? (JSON.parse(readFileSync(resolve(jfile), 'utf8')) as Judgements)
    : undefined;
  writeReport(rep, resolve(out), { judgements });
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
