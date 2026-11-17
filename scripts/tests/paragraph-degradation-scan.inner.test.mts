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
  measureBook,
  declaredLanguageOf,
  renderSummary,
  type ScanEntry,
  type BookMeasurement,
  type ParsedLike,
} from '../../server/scripts/paragraph-degradation-scan.mts';
import { parseManuscript } from '../../server/src/parsers/index.ts';
import { buildSingleChapterEpub } from '../../server/src/test-utils/empty-href-epub.ts';
import {
  countTurnOpeners,
  measureChapterLegibility,
} from '../../server/src/analyzer/dialogue-structure/legibility.ts';
import { conventionsFor } from '../../server/src/analyzer/dialogue-structure/lang/index.ts';

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

/* ---- measurements (#2254 Phase 7a step 3) ---------------------------------- */

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'server', 'src', '__fixtures__');
const RU_DASH = readFileSync(join(FIXTURE_DIR, 'the-coalfall-commission.ru-dash.md'), 'utf8');

/** Hard-wrap every line longer than `width` at a space (a single \n, no blank line). */
function hardWrap(text: string, width: number): string {
  return text
    .split('\n')
    .map((line) => {
      const out: string[] = [];
      let rest = line;
      while (rest.length > width) {
        let cut = rest.lastIndexOf(' ', width);
        if (cut <= 0) cut = rest.indexOf(' ', width);
        if (cut <= 0) break;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      }
      out.push(rest);
      return out.join('\n');
    })
    .join('\n');
}

async function measureText(text: string, fileName: string): Promise<BookMeasurement> {
  const parsed = await parseManuscript({ buffer: Buffer.from(text, 'utf8'), fileName });
  return measureBook(parsed);
}

test('the clean ru-dash fixture is not line-wrapped, and neither is one paragraph per line', async () => {
  const m = await measureText(RU_DASH, 'clean.md');
  assert.equal(m.language.detected, 'ru');
  assert.equal(m.lineWrap.wrapped, false);
  assert.equal(m.lineWrap.continuationLines, 0);
  const oneLine = await measureText(RU_DASH.replace(/\n\n+/g, '\n'), 'oneline.txt');
  assert.equal(oneLine.lineWrap.wrapped, false);
  assert.equal(oneLine.lineWrap.continuationLines, 0);
});

for (const width of [80, 200]) {
  for (const ext of ['txt', 'md']) {
    test(`the ru-dash fixture hard-wrapped at ${width} columns is flagged as .${ext}`, async () => {
      const m = await measureText(hardWrap(RU_DASH, width), `wrapped-${width}.${ext}`);
      assert.equal(m.lineWrap.wrapped, true, `share ${m.lineWrap.share}`);
      assert.ok(m.lineWrap.arms.length > 0);
    });
  }
}

test('an EPUB whose <p> text carries raw newlines is flagged', async () => {
  const wrapped = hardWrap(RU_DASH, 80)
    .split(/\n\n+/)
    .filter((p) => p.length > 200)
    .slice(0, 30)
    .map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
    .join('\n');
  const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${wrapped}</body></html>`;
  const parsed = await parseManuscript({
    buffer: await buildSingleChapterEpub(xhtml),
    fileName: 'wrapped.epub',
  });
  const m = measureBook(parsed);
  assert.equal(parsed.format, 'epub');
  assert.equal(m.lineWrap.wrapped, true, `continuation ${m.lineWrap.continuationLines}`);
});

function wrapBook(pairs: number, filler = 600): ParsedLike {
  const lines: string[] = [];
  for (let i = 0; i < filler; i++) lines.push('Абзац номер один без переноса.');
  for (let i = 0; i < pairs; i++) lines.push('Начало длинной строки\nпродолжение строки.');
  return { format: 'plaintext', chapters: [{ id: 1, title: 'c', body: lines.join('\n') }] };
}

test('exactly 10 continuation lines (under 2%) trip the count arm; 9 do not', () => {
  const ten = measureBook(wrapBook(10), { language: 'ru' });
  assert.ok(ten.lineWrap.share < 0.02);
  assert.equal(ten.lineWrap.continuationLines, 10);
  assert.deepEqual(ten.lineWrap.arms, ['count']);
  assert.equal(ten.lineWrap.wrapped, true);
  const nine = measureBook(wrapBook(9), { language: 'ru' });
  assert.equal(nine.lineWrap.continuationLines, 9);
  assert.equal(nine.lineWrap.wrapped, false);
});

test('a PDF is always line-wrapped', () => {
  const m = measureBook(
    { format: 'pdf', chapters: [{ id: 1, title: 'c', body: 'Один.\n\nДва.' }] },
    { language: 'ru' },
  );
  assert.deepEqual(m.lineWrap.arms, ['pdf']);
});

function denseBook(turns: number, words: number): ParsedLike {
  const filler = Array.from({ length: words - turns }, () => 'слово').join(' ');
  const dialogue = Array.from({ length: turns }, () => '— Да.').join('\n');
  return { format: 'plaintext', chapters: [{ id: 1, title: 'c', body: `${dialogue}\n${filler}` }] };
}

test('dialogue-dense bars: 25 per 1,000 words and 1,000 turns, each side', () => {
  const at = measureBook(denseBook(1000, 40000), { language: 'ru' });
  assert.equal(at.dialogue.dashTurns, 1000);
  assert.equal(at.dialogue.per1000Words, 25);
  assert.equal(at.dialogue.dense, true);
  assert.equal(measureBook(denseBook(1000, 40001), { language: 'ru' }).dialogue.dense, false);
  assert.equal(measureBook(denseBook(999, 39960), { language: 'ru' }).dialogue.dense, false);
  assert.equal(measureBook(denseBook(1001, 40000), { language: 'ru' }).dialogue.dense, true);
});

test('per-chapter legibility and turn openers match the measure; a chapter at >= 10 carries its worst paragraph', () => {
  const merged =
    'Он вошёл.' +
    Array.from({ length: 12 }, (_, i) => ` — Реплика номер${i}? — Да.`).join('') +
    ' Конец.';
  const clean = 'Тихая глава.\n— Да.\n— Нет.';
  const parsed: ParsedLike = {
    format: 'plaintext',
    chapters: [
      { id: 1, title: 'Склеенная', body: merged },
      { id: 2, title: 'Чистая', body: clean },
    ],
  };
  const m = measureBook(parsed, { language: 'ru' });
  const ru = conventionsFor('ru')!;
  for (const [i, c] of parsed.chapters.entries()) {
    assert.equal(m.chapters[i].legibility, measureChapterLegibility(c.body!, ru));
    assert.equal(m.chapters[i].turnOpeners, countTurnOpeners(c.body!));
  }
  assert.ok(m.chapters[0].legibility! >= 10);
  assert.equal(m.chapters[0].worstParagraph?.text, merged.slice(0, 400));
  assert.equal(m.chapters[0].worstParagraph?.count, m.chapters[0].legibility);
  assert.equal(m.chapters[1].worstParagraph, undefined);
  assert.equal(m.bookMax, m.chapters[0].legibility);
  assert.equal(m.chapters[1].dashParagraphs, 2);
});

test('a language without conventions reports not measured, never 0', () => {
  const m = measureBook(
    { format: 'plaintext', chapters: [{ id: 1, title: 'c', body: 'Hello there.' }] },
    { language: 'xx' },
  );
  assert.equal(m.chapters[0].measured, false);
  assert.equal(m.chapters[0].legibility, null);
  assert.equal(m.bookMax, null);
  assert.equal(m.dialogue.dense, null);
});

test('the declared language comes from a Calibre metadata.opf beside the file; uk is listed apart', () => {
  const lib = tempDir('lib');
  writeFileSync(
    join(lib, 'metadata.opf'),
    '<package><metadata><dc:language>uk</dc:language></metadata></package>',
  );
  writeFileSync(join(lib, 'book.md'), '# T\n\nТекст.\n');
  assert.equal(declaredLanguageOf(join(lib, 'book.md')), 'uk');
  assert.equal(declaredLanguageOf(join(lib, 'sub', 'none.md')), null);
  const m = measureBook(
    { format: 'markdown', chapters: [{ id: 1, title: 'c', body: 'Текст.' }] },
    { language: 'ru', declaredLanguage: 'uk' },
  );
  assert.equal(m.language.declaredSource, 'metadata.opf');
  assert.equal(m.nonRuCyrillic, true);
  assert.equal(measureBook({ format: 'markdown', chapters: [] }, { language: 'ru' }).nonRuCyrillic, false);
  rmSync(lib, { recursive: true, force: true });
});

test('the summary sorts books by their maximum, shows the flags and lists non-ru Cyrillic apart', () => {
  const mk = (path: string, max: number, lang: string): ScanEntry => ({
    path,
    extension: 'md',
    status: 'parsed',
    result: {
      ...measureBook(
        { format: 'plaintext', chapters: [{ id: 1, title: 'c', body: 'Текст.' }] },
        { language: lang },
      ),
      bookMax: max,
    },
  });
  const md = renderSummary({
    library: 'L',
    build: 'b',
    entries: [mk('/low.md', 1, 'ru'), mk('/high.md', 12, 'ru'), mk('/ua.md', 3, 'uk')],
  });
  assert.ok(md.indexOf('/high.md') < md.indexOf('/low.md'));
  assert.match(md, /Non-ru Cyrillic books \(1\)[\s\S]*\/ua\.md/);
});
