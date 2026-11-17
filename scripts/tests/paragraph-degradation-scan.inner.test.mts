/* Assertions for server/scripts/paragraph-degradation-scan.mts (#2254, spec §4.4
   step 1, R9-1 / R10-5): each file is parsed in an isolated child, and one bad
   file never stops the scan. Run under tsx; paragraph-degradation-scan.test.mjs
   wraps this so `npm run test:hooks` sees it. Later scanner/runner children
   reuse the fixture helpers below. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { buildEpub, buildSingleChapterEpub } from '../../server/src/test-utils/empty-href-epub.ts';
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

/* ---- stray-break check, calibration candidates, label outcome (#2254 Phase 7a step 4) ---- */

/** A line holding `n` TURN_IN_PARAGRAPH matches (and no dash at its start). */
const rich = (n: number): string => 'Он.' + ' — Да.'.repeat(n);
const FILLER = Array.from({ length: 6 }, () => '— Да.');

/** Dense ru dash text (>= 1,000 turns, 1,000 per 1,000 words) with `blocks`
    placed deliberately, each followed by filler dash lines. */
function strayBook(blocks: string[][], format = 'plaintext'): ParsedLike {
  const lines: string[] = Array.from({ length: 1100 }, () => '— Да.');
  for (const b of blocks) lines.push(...b, ...FILLER);
  return { format, chapters: [{ id: 1, title: 'c', body: lines.join('\n') }] };
}

/** An isolated stray break whose neighbour window holds a + b + c matches. */
const stray = (a: number, b: number, c: number): string[] => [
  rich(a),
  rich(b),
  'продолжение строки.',
  rich(c),
];
const many = (n: number, mk: () => string[]): string[][] => Array.from({ length: n }, mk);
const measureRu = (p: ParsedLike): BookMeasurement => measureBook(p, { language: 'ru' });
const whyOf = (m: BookMeasurement): string | null =>
  m.strayBreaks.isolation === 'pass' ? null : m.strayBreaks.isolation.why;

test('a count-arm book (>= 10 isolated stray breaks, under 2%) is a candidate at window 9 and not at 10', () => {
  const nine = measureRu(strayBook(many(10, () => stray(3, 3, 3))));
  assert.deepEqual(nine.lineWrap.arms, ['count']);
  assert.equal(nine.dialogue.dense, true);
  assert.equal(nine.strayBreaks.checked, 10);
  assert.equal(nine.strayBreaks.largestWindow, 9);
  assert.equal(nine.strayBreaks.isolation, 'pass');
  assert.equal(nine.calibrationCandidate, true);
  const ten = measureRu(strayBook(many(10, () => stray(3, 3, 4))));
  assert.equal(ten.strayBreaks.largestWindow, 10);
  assert.equal(ten.calibrationCandidate, false);
  assert.equal(ten.calibrationReason, 'stray-break check');
});

test('4-7 isolated continuation lines, which no arm flags, are still checked (owner decision 21)', () => {
  const bad = measureRu(strayBook([...many(4, () => stray(3, 3, 3)), stray(4, 3, 3)]));
  assert.deepEqual(bad.lineWrap.arms, []);
  assert.equal(bad.strayBreaks.checked, 5);
  assert.equal(bad.strayBreaks.largestWindow, 10);
  assert.equal(bad.calibrationCandidate, false);
  assert.equal(bad.calibrationReason, 'stray-break check');
  const ok = measureRu(strayBook(many(5, () => stray(3, 3, 3))));
  assert.deepEqual(ok.lineWrap.arms, []);
  assert.equal(ok.strayBreaks.largestWindow, 9);
  assert.equal(ok.calibrationCandidate, true);
});

test('a book with no continuation line passes the check trivially', () => {
  const m = measureRu(strayBook([]));
  assert.equal(m.strayBreaks.checked, 0);
  assert.equal(m.strayBreaks.largestWindow, null);
  assert.equal(m.strayBreaks.pass, true);
  assert.equal(m.calibrationCandidate, true);
});

test('a break before the dash is restored by the space join and counted', () => {
  const split = (): string[] => [rich(4), rich(5), 'продолжение строки. —', 'Да. Конец.'];
  const m = measureRu(strayBook(many(5, split)));
  assert.equal(m.strayBreaks.largestWindow, 10);
  assert.equal(m.calibrationCandidate, false);
  assert.equal(m.calibrationReason, 'stray-break check');
});

test('two adjacent continuation lines disqualify the book, and so do two within two lines', () => {
  const adjacent = measureRu(strayBook([[rich(1), 'продолжение один.', 'продолжение два.', rich(1)]]));
  assert.equal(adjacent.strayBreaks.checked, 2);
  assert.equal(whyOf(adjacent), 'adjacent');
  assert.equal(adjacent.calibrationCandidate, false);
  const near = measureRu(
    strayBook([[rich(1), 'продолжение один.', 'Он.', 'продолжение два.', rich(1)]]),
  );
  assert.equal(near.strayBreaks.checked, 2);
  assert.equal(whyOf(near), 'within two lines');
  assert.equal(near.calibrationCandidate, false);
  assert.equal(near.calibrationReason, 'stray-break check');
});

test('a share-arm book is never a candidate, nor is a PDF', () => {
  const share = measureRu(strayBook(many(40, () => stray(0, 0, 0))));
  assert.ok(share.lineWrap.arms.includes('share'));
  assert.equal(share.strayBreaks.pass, true);
  assert.equal(share.calibrationCandidate, false);
  assert.equal(share.calibrationReason, 'share-arm');
  const pdf = measureRu(strayBook([], 'pdf'));
  assert.equal(pdf.calibrationCandidate, false);
  assert.equal(pdf.calibrationReason, 'pdf');
});

test('a candidate must be ru, dense and free of chapters at >= 10', () => {
  const clean = strayBook([]);
  assert.equal(measureBook(clean, { language: 'en' }).calibrationReason, 'not ru');
  /* declared ru passes the language bar, but a detected en has no dash conventions to measure */
  assert.equal(
    measureBook(clean, { language: 'en', declaredLanguage: 'ru' }).calibrationReason,
    'not dialogue-dense',
  );
  const sparse: ParsedLike = {
    format: 'plaintext',
    chapters: [{ id: 1, title: 'c', body: '— Да.\nТекст.' }],
  };
  assert.equal(measureRu(sparse).calibrationReason, 'not dialogue-dense');
  const merged: ParsedLike = {
    format: 'plaintext',
    chapters: [...clean.chapters, { id: 2, title: 'm', body: rich(12) }],
  };
  assert.equal(measureRu(merged).calibrationReason, 'chapter >= 10');
});

function entry(path: string, p: ParsedLike): ScanEntry {
  return { path, extension: 'txt', status: 'parsed', result: { format: p.format, ...measureRu(p) } };
}
const candidateBook = (): ScanEntry => entry('/cand.txt', strayBook([]));
/** A line-wrapped (count arm) book holding one chapter at >= 10. */
function wrappedMergedBook(): ScanEntry {
  const p = strayBook(many(10, () => stray(1, 1, 1)));
  p.chapters.push({ id: 2, title: 'm', body: rich(12) });
  return entry('/wrapped.txt', p);
}
const label = (entries: ScanEntry[], judgements?: Record<string, 'merged' | 'clean'>): string =>
  renderSummary({ library: 'L', build: 'b', entries }, { judgements });

test('the summary lists the clean dialogue-dense ru dash books and the stray-break detail', () => {
  const md = label([candidateBook(), entry('/q.txt', strayBook(many(5, () => stray(3, 3, 4))))]);
  assert.match(md, /Clean, dialogue-dense ru dash books \(1\)\s+- \/cand\.txt/);
  assert.match(
    md,
    /\/q\.txt: flagged by none; 5 continuation lines; isolation pass; largest window 10; disqualified/,
  );
});

test('label: no --judgements is pending owner judgement, listing what is left to judge', () => {
  const md = label([candidateBook(), wrappedMergedBook()]);
  assert.match(md, /label: pending owner judgement/);
  assert.match(md, /to judge: \/wrapped\.txt chapter 2 at 12/);
  assert.match(label([candidateBook(), wrappedMergedBook()], {}), /label: pending owner judgement/);
});

test('label: a breach in a line-wrapped book keeps the label provisional', () => {
  const md = label([candidateBook(), wrappedMergedBook()], { '/wrapped.txt#2': 'clean' });
  assert.match(md, /label stays provisional/);
  assert.match(md, /breach: \/wrapped\.txt chapter 2 at 12/);
  assert.doesNotMatch(md, /label may drop/);
});

test('label: all-merged judgements plus a candidate say the label may drop, naming the book', () => {
  const md = label([candidateBook(), wrappedMergedBook()], { '/wrapped.txt#2': 'merged' });
  assert.match(md, /label may drop[^\n]*\/cand\.txt/);
});

test('label: no candidate keeps it provisional; an extractor-merged chapter is never a breach', () => {
  const md = label([wrappedMergedBook()], { '/wrapped.txt#2': 'merged' });
  assert.match(md, /label stays provisional/);
  assert.match(md, /no clean, dialogue-dense ru dash book/);
  const hooked = renderSummary(
    { library: 'L', build: 'b', entries: [candidateBook(), wrappedMergedBook()] },
    { judgements: { '/wrapped.txt#2': 'clean' }, isExtractorMerged: () => true },
  );
  assert.match(hooked, /label may drop/);
});

/* ---- the EPUB #4217 what-if (#2254 Phase 7a step 5) ------------------------- */

const PARSERS_INDEX_URL = pathToFileURL(
  join(import.meta.dirname, '..', '..', 'server', 'src', 'parsers', 'index.ts'),
).href;

/** A parser module that runs the real parseManuscript, then (only when the buffer
    holds the what-if's inserted `<br/>`) reshapes the result by file name: `short`
    drops the last chapter, `retitle` renames the last one. */
function writeDelegatingParser(dir: string): string {
  const p = join(dir, 'delegating-parser.mjs');
  writeFileSync(
    p,
    `import { parseManuscript } from ${JSON.stringify(PARSERS_INDEX_URL)};
export default async function parse(input) {
  const parsed = await parseManuscript(input);
  if (!input.buffer.includes('<br/>')) return parsed;
  if (input.fileName.startsWith('short')) parsed.chapters = parsed.chapters.slice(0, -1);
  if (input.fileName.startsWith('retitle')) {
    parsed.chapters[parsed.chapters.length - 1].title = 'Другое название';
  }
  return parsed;
}
`,
    'utf8',
  );
  return p;
}

/** A parser module for a stand-in MOBI: only the format tells it from markdown. */
function writeMobiParser(dir: string): string {
  const p = join(dir, 'mobi-parser.mjs');
  writeFileSync(
    p,
    `export default async function parse({ fileName }) {
  return { format: fileName.endsWith('.mobi') ? 'mobi' : 'markdown', chapters: [{ id: 1, title: 'c', body: 'Текст.' }] };
}
`,
    'utf8',
  );
  return p;
}

const TURNS = (n: number): string[] => Array.from({ length: n }, (_, i) => `— Реплика номер ${i + 1}.`);
/** Enough Russian prose for language detection to call the book ru. */
const PROSE = `<p>${'Он медленно шёл по тёмной улице и думал о том, что случилось сегодня утром. '.repeat(400)}</p>`;
const HTML_OPEN = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' + PROSE;
/** Twelve dash turns, each its own <div>, no <p>: v1 `stripHtml` merges them onto one line. */
const DIV_CHAPTER = `${HTML_OPEN}${TURNS(12).map((t) => `<div>${t}</div>`).join(' ')}</body></html>`;
/** Twelve turns inside ONE <p>: merged in the source itself. */
const P_CHAPTER = `${HTML_OPEN}<p>${TURNS(12).join(' ')}</p></body></html>`;
const CLEAN_CHAPTER = `${HTML_OPEN}<p>Тихая глава.</p><p>— Да.</p></body></html>`;

function scanEpubs(
  files: Record<string, Buffer>,
  parserModule?: string,
): { entries: ScanEntry[]; out: string; lib: string } {
  const lib = tempDir('lib');
  const out = join(tempDir('out'), 'scratch');
  for (const [name, buf] of Object.entries(files)) writeFileSync(join(lib, name), buf);
  const rep = scanLibrary(lib, { parserModule, outDir: out, timeoutMs: 60_000 });
  return { entries: rep.entries, out, lib };
}

type WhatIfShape = {
  status: string;
  reason?: string;
  closersInserted?: number;
  chapters?: Array<{
    id: number;
    legibility: number | null;
    whatIfLegibility: number | null;
    extractorMerged: boolean;
  }>;
};
const whatIf = (e: ScanEntry): WhatIfShape => e.result?.whatIf as WhatIfShape;

test('a <div>-paragraphed EPUB is labelled extractor-merged (#4217), and the label outcome does not count it as a breach', async () => {
  const { entries, out, lib } = scanEpubs({
    'divs.epub': await buildEpub([DIV_CHAPTER, CLEAN_CHAPTER], { navLabels: ['Диалог', 'Тишина'] }),
  });
  const e = byName(entries, 'divs.epub');
  assert.equal(e.status, 'parsed');
  const w = whatIf(e);
  assert.equal(w.status, 'paired');
  assert.ok((w.closersInserted ?? 0) >= 12, `closers ${w.closersInserted}`);
  const c1 = w.chapters![0];
  assert.ok((c1.legibility ?? 0) >= 10, `imported ${c1.legibility}`);
  assert.ok((c1.whatIfLegibility ?? 99) < 10, `what-if ${c1.whatIfLegibility}`);
  assert.equal(c1.extractorMerged, true);
  assert.equal(w.chapters![1].extractorMerged, false);

  const judgements = { [`${e.path}#${c1.id}`]: 'clean' as const };
  const md = renderSummary({ library: lib, build: 'b', entries: [e, candidateBook()] }, { judgements });
  assert.match(md, /extractor-merged \(#4217\)/);
  assert.match(md, /label may drop/);
  assert.doesNotMatch(md, /breach:/);
  assert.ok(
    md.indexOf('Extractor-merged (#4217): books the extractor merges (1)') <
      md.indexOf('## Books by worst-paragraph'),
    'labelled books come first',
  );
  // Without the what-if the same judgement IS a breach: the label is what saves it.
  const bare = { ...e, result: { ...e.result, whatIf: undefined } } as ScanEntry;
  assert.match(
    renderSummary({ library: lib, build: 'b', entries: [bare, candidateBook()] }, { judgements }),
    /breach:/,
  );
  // The copy lives only under --out.
  assert.ok(existsSync(join(out, 'whatif')));
  assert.deepEqual(readdirSync(lib), ['divs.epub'], 'nothing else is written into the library');
  rmSync(lib, { recursive: true, force: true });
});

test('a genuinely merged <p> is flagged and not labelled', async () => {
  const { entries, lib } = scanEpubs({
    'merged-p.epub': await buildEpub([P_CHAPTER], { navLabels: ['Склейка'] }),
  });
  const e = byName(entries, 'merged-p.epub');
  const w = whatIf(e);
  assert.equal(w.status, 'paired');
  assert.ok((w.chapters![0].legibility ?? 0) >= 10);
  assert.ok((w.chapters![0].whatIfLegibility ?? 0) >= 10);
  assert.equal(w.chapters![0].extractorMerged, false);
  assert.match(
    renderSummary({ library: lib, build: 'b', entries }, {}),
    /Extractor-merged \(#4217\): books the extractor merges \(0\)/,
  );
  rmSync(lib, { recursive: true, force: true });
});

test('an EPUB whose copy yields another chapter count or other titles is what-if not aligned, and labels nothing', async () => {
  const aux = tempDir('aux');
  const epub = await buildEpub([DIV_CHAPTER, CLEAN_CHAPTER], { navLabels: ['Диалог', 'Тишина'] });
  const { entries, lib } = scanEpubs(
    { 'short.epub': epub, 'retitle.epub': epub },
    writeDelegatingParser(aux),
  );
  const short = whatIf(byName(entries, 'short.epub'));
  assert.equal(short.status, 'not aligned');
  assert.match(short.reason ?? '', /2 chapters imported, 1 in the copy/);
  assert.equal(short.chapters, undefined);
  const retitle = whatIf(byName(entries, 'retitle.epub'));
  assert.equal(retitle.status, 'not aligned');
  assert.match(retitle.reason ?? '', /title differs/);
  assert.equal(retitle.chapters, undefined);
  const md = renderSummary({ library: lib, build: 'b', entries }, {});
  assert.match(md, /short\.epub: what-if not aligned/);
  assert.match(md, /Extractor-merged \(#4217\): books the extractor merges \(0\)/);
  rmSync(lib, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

test('a MOBI is what-if not computed, per book', () => {
  const aux = tempDir('aux');
  const lib = tempDir('lib');
  writeFileSync(join(lib, 'book.mobi'), 'x');
  const rep = scanLibrary(lib, {
    parserModule: writeMobiParser(aux),
    outDir: join(aux, 'out'),
    timeoutMs: 20_000,
  });
  assert.equal(whatIf(byName(rep.entries, 'book.mobi')).status, 'not computed');
  assert.match(renderSummary(rep, {}), /book\.mobi: what-if not computed/);
  rmSync(lib, { recursive: true, force: true });
  rmSync(aux, { recursive: true, force: true });
});

test('an EPUB that never parses gets no what-if and never stops the scan', () => {
  const lib = tempDir('lib');
  writeFileSync(join(lib, 'ok.md'), '# Hi\n\ntext\n');
  writeFileSync(join(lib, 'a.epub'), 'not a zip');
  const rep = scanLibrary(lib, { outDir: join(tempDir('out'), 'scratch'), timeoutMs: 60_000 });
  assert.equal(byName(rep.entries, 'a.epub').status, 'unparsed');
  assert.equal(byName(rep.entries, 'a.epub').result, undefined);
  assert.equal(byName(rep.entries, 'ok.md').status, 'parsed');
  rmSync(lib, { recursive: true, force: true });
});
