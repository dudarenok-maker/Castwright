/* Assertions for server/scripts/paragraph-degradation-scan.mts (#2254, spec §4.4
   step 1, R9-1 / R10-5): each file is parsed in an isolated child, and one bad
   file never stops the scan. Run under tsx; paragraph-degradation-scan.test.mjs
   wraps this so `npm run test:hooks` sees it. Later scanner/runner children
   reuse the fixture helpers below. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanLibrary,
  writeReport,
  type ScanEntry,
} from '../../server/scripts/paragraph-degradation-scan.mts';

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `pds-${label}-`));
}

/** Fixture parser module: behaviour is chosen by the file's name, and every call
    appends the file name to `marker`. */
function writeParser(dir: string, marker: string): string {
  const p = join(dir, 'fixture-parser.mjs');
  writeFileSync(
    p,
    `import { appendFileSync } from 'node:fs';
export default async function parse({ buffer, fileName }) {
  appendFileSync(${JSON.stringify(marker)}, fileName + '\\n');
  if (fileName.startsWith('crash')) {
    setImmediate(() => { throw new TypeError('linkparts.shift is not a function'); });
    await new Promise(() => {});
  }
  if (fileName.startsWith('hang')) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  if (fileName.startsWith('exit')) process.exit(1);
  return { format: 'markdown', chapters: [{}, {}] };
}
`,
    'utf8',
  );
  return p;
}

function byName(entries: ScanEntry[], name: string): ScanEntry {
  const e = entries.find((x) => x.path.endsWith(name));
  assert.ok(e, `no entry for ${name}`);
  return e;
}

test('a parser crash from a bare callback is reported with its message, and the scan goes on', () => {
  const lib = tempDir('lib');
  const aux = tempDir('aux');
  writeFileSync(join(lib, 'good.md'), '# Hi\n\ntext\n');
  writeFileSync(join(lib, 'crash.epub'), 'x');
  const rep = scanLibrary(lib, {
    parserModule: writeParser(aux, join(aux, 'marker.txt')),
    timeoutMs: 20_000,
  });
  const crash = byName(rep.entries, 'crash.epub');
  assert.equal(crash.status, 'unparsed');
  assert.equal(crash.reason, 'linkparts.shift is not a function');
  const good = byName(rep.entries, 'good.md');
  assert.equal(good.status, 'parsed');
  assert.equal(good.result?.chapterCount, 2);
  rmSync(lib, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

test('a parse that never settles is reported timed out and the scan goes on', () => {
  const lib = tempDir('lib');
  const aux = tempDir('aux');
  writeFileSync(join(lib, 'hang.md'), 'x');
  writeFileSync(join(lib, 'ok.md'), 'x');
  const rep = scanLibrary(lib, {
    parserModule: writeParser(aux, join(aux, 'm.txt')),
    timeoutMs: 8000,
  });
  const hang = byName(rep.entries, 'hang.md');
  assert.equal(hang.status, 'unparsed');
  assert.match(hang.reason ?? '', /timed out after 8 s/);
  assert.equal(byName(rep.entries, 'ok.md').status, 'parsed');
  rmSync(lib, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

test('a child that hard-exits without reporting is unparsed with its exit code', () => {
  const lib = tempDir('lib');
  const aux = tempDir('aux');
  writeFileSync(join(lib, 'exit.md'), 'x');
  writeFileSync(join(lib, 'ok.md'), 'x');
  const rep = scanLibrary(lib, {
    parserModule: writeParser(aux, join(aux, 'm.txt')),
    timeoutMs: 20_000,
  });
  const e = byName(rep.entries, 'exit.md');
  assert.equal(e.status, 'unparsed');
  assert.match(e.reason ?? '', /exited without reporting/);
  assert.match(e.reason ?? '', /exit code 1/);
  assert.equal(byName(rep.entries, 'ok.md').status, 'parsed');
  rmSync(lib, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

test('an .fb2 file is listed unsupported and never spawned; reports go only under out', () => {
  const lib = tempDir('lib');
  const aux = tempDir('aux');
  const out = join(tempDir('out'), 'scratch');
  const marker = join(aux, 'marker.txt');
  mkdirSync(join(lib, 'sub'));
  writeFileSync(join(lib, 'sub', 'book.fb2'), 'x');
  writeFileSync(join(lib, 'notes.docx'), 'x');
  writeFileSync(join(lib, 'good.md'), 'x');
  const rep = scanLibrary(lib, { parserModule: writeParser(aux, marker), timeoutMs: 20_000 });
  const fb2 = byName(rep.entries, 'book.fb2');
  assert.equal(fb2.status, 'unsupported');
  assert.equal(fb2.extension, 'fb2');
  assert.equal(byName(rep.entries, 'notes.docx').status, 'unsupported');
  assert.ok(existsSync(marker), 'the good file must have reached the parser');
  const called = readFileSync(marker, 'utf8');
  assert.ok(!called.includes('book.fb2'), 'the .fb2 must never be spawned');
  assert.ok(!called.includes('notes.docx'), 'the .docx must never be spawned');

  writeReport(rep, out);
  const json = JSON.parse(readFileSync(join(out, 'scan.json'), 'utf8'));
  assert.equal(json.entries.length, 3);
  const md = readFileSync(join(out, 'scan.md'), 'utf8');
  assert.match(md, /book\.fb2/);
  assert.match(md, /Unsupported \(2\)/);
  assert.match(md, /Build: [0-9a-f]{40}/);
  rmSync(lib, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});
