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
     --child <file>                       parse one file, print one JSON line.
   Test-only seams (not for operators)
     --parser-module <path>  the child imports that module's default export
                             instead of parseManuscript.
     --timeout-ms <n>        per-file limit in ms instead of 60 000. */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_MANUSCRIPT_EXTENSIONS } from '../src/parsers/index.js';

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
}

/** Parse one file in its own child process and classify the outcome. */
export function parseInIsolation(file: string, opts: ParseOptions = {}): ScanEntry {
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

export function renderSummary(report: ScanReport): string {
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

export function writeReport(report: ScanReport, out: string): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'scan.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(join(out, 'scan.md'), renderSummary(report), 'utf8');
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
    const parsed = await parse({ buffer, fileName: basename(file) });
    report({ ok: true, format: parsed.format, chapterCount: parsed.chapters.length });
    process.exit(0);
  } catch (e) {
    fail(e);
  }
}

type ParseFn = (input: { buffer: Buffer; fileName: string }) => Promise<{
  format: string;
  chapters: unknown[];
}>;

/* ---- entry ------------------------------------------------------------- */

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
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
  });
  writeReport(rep, resolve(out));
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
