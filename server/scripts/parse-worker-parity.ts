/* Read-only parity harness for #4242 (EPUB/MOBI parse in a worker thread).

     npx tsx server/scripts/parse-worker-parity.ts <dir> [<dir> ...]

   For every .epub / .mobi / .azw3 under each directory (recursive,
   case-insensitive, sha256-deduplicated within each directory) it parses the
   book once IN-PROCESS (parseEpub / parseMobi) and once through the worker
   (parseManuscript), at extractor version 1 AND 2 (#4217: the worker must
   extract as the in-process parser does at whichever version the caller
   pinned), and reports identical / differ / error-same / error-differ /
   in-process-crash counts, one per book per version. Exit code 1 if differ +
   error-differ > 0, else 0.

   "Identical" is JSON.stringify(inProcess) === JSON.stringify(viaWorker). Two
   rejections are "error-same" when constructor name and message match. An
   in-process parse that ends the process (an epub2 async-callback throw) is
   caught by an uncaughtException handler installed here and counted as
   in-process-crash; the worker's outcome for that book is recorded and the
   run continues.

   Read-only: books are read with readFile and handed to both sides as a
   buffer alone (no sourcePath: parseEpub's temp-file path writes only under
   os.tmpdir(), never beside the book). Only base names are ever printed. */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseEpub } from '../src/parsers/epub.js';
import { parseMobi } from '../src/parsers/mobi.js';
import { parseManuscript } from '../src/parsers/index.js';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: npx tsx server/scripts/parse-worker-parity.ts <dir> [<dir> ...]');
  process.exit(2);
}

const EXTS = new Set(['.epub', '.mobi', '.azw3']);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name).toLowerCase())) out.push(p);
  }
}

type Outcome = { ok: true; json: string; value: unknown } | { ok: false; name: string; message: string };

async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    const value = await run();
    return { ok: true, json: JSON.stringify(value), value };
  } catch (e) {
    const err = e as { constructor?: { name?: string }; message?: string };
    return { ok: false, name: err?.constructor?.name ?? 'unknown', message: String(err?.message ?? e) };
  }
}

/* An in-process crash surfaces as an uncaughtException; remember it so the
   per-book wait below can stop waiting and classify the book. */
let wakeCrash: (() => void) | null = null;
process.on('uncaughtException', () => {
  wakeCrash?.();
});

async function inProcess(
  buf: Buffer,
  fileName: string,
  isMobi: boolean,
  extractorVersion: number,
): Promise<Outcome | 'crash'> {
  const crash = new Promise<'crash'>((resolve) => {
    wakeCrash = () => resolve('crash');
  });
  const run = settle(() => (isMobi ? parseMobi(buf, { fileName, extractorVersion }) : parseEpub(buf, { fileName, extractorVersion })));
  const r = await Promise.race([run, crash]);
  wakeCrash = null;
  return r;
}

function firstDiff(a: unknown, b: unknown, ja: string, jb: string): string {
  let i = 0;
  while (i < ja.length && i < jb.length && ja[i] === jb[i]) i++;
  const lo = Math.max(0, i - 40);
  const ctx = (s: string) => JSON.stringify(s.slice(lo, lo + 80));
  let chapter = 'n/a';
  const ca = (a as { chapters?: unknown[] })?.chapters;
  const cb = (b as { chapters?: unknown[] })?.chapters;
  if (Array.isArray(ca) && Array.isArray(cb)) {
    const n = Math.max(ca.length, cb.length);
    for (let k = 0; k < n; k++) {
      if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) {
        chapter = String(k);
        break;
      }
    }
  }
  return `first differing chapter ${chapter}, offset ${i}; in-process ${ctx(ja)} | worker ${ctx(jb)}`;
}

const counts = { identical: 0, differ: 0, errorSame: 0, errorDiffer: 0, crash: 0 };
let total = 0;
let distinct = 0;

for (const dir of dirs) {
  const files: string[] = [];
  try {
    walk(dir, files);
  } catch {
    console.error('cannot read a directory argument');
    process.exit(2);
  }
  files.sort();
  const seen = new Set<string>();
  for (const file of files) {
    total++;
    const buf = readFileSync(file);
    const sha = createHash('sha256').update(buf).digest('hex');
    if (seen.has(sha)) continue;
    seen.add(sha);
    distinct++;
    const fileName = basename(file);
    const isMobi = extname(fileName).toLowerCase() !== '.epub';

    for (const extractorVersion of [1, 2]) {
      const a = await inProcess(buf, fileName, isMobi, extractorVersion);
      const b = await settle(() => parseManuscript({ buffer: buf, fileName, extractorVersion }));

      if (a === 'crash') {
        counts.crash++;
        const w = b.ok ? 'parsed' : `${b.name}: ${b.message.slice(0, 80)}`;
        console.log(`IN-PROCESS-CRASH v${extractorVersion} ${fileName} (worker: ${w})`);
      } else if (a.ok && b.ok) {
        if (a.json === b.json) counts.identical++;
        else {
          counts.differ++;
          console.log(`DIFFER v${extractorVersion} ${fileName}: ${firstDiff(a.value, b.value, a.json, b.json)}`);
        }
      } else if (!a.ok && !b.ok) {
        if (a.name === b.name && a.message === b.message) counts.errorSame++;
        else {
          counts.errorDiffer++;
          console.log(
            `ERROR-DIFFER v${extractorVersion} ${fileName}: in-process ${a.name}: ${a.message.slice(0, 80)} | worker ${b.name}: ${b.message.slice(0, 80)}`,
          );
        }
      } else {
        counts.errorDiffer++;
        const side = (o: Outcome) => (o.ok ? 'parsed' : `${o.name}: ${o.message.slice(0, 80)}`);
        console.log(`ERROR-DIFFER v${extractorVersion} ${fileName}: in-process ${side(a)} | worker ${side(b)}`);
      }
    }
  }
}

console.log(
  `parity: ${total} books (${distinct} distinct) — identical ${counts.identical}, differ ${counts.differ}, error-same ${counts.errorSame}, error-differ ${counts.errorDiffer}, in-process-crash ${counts.crash}`,
);
process.exit(counts.differ + counts.errorDiffer > 0 ? 1 : 0);
