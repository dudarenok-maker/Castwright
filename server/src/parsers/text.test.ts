// Pairs with docs/features/archive/02-upload-paste-or-file.md (plain text + Markdown layer).

import { describe, expect, it } from 'vitest';
import { parseText, parseFilenameMetadata, parseSeriesFromTitle } from './text.js';

describe('parseFilenameMetadata', () => {
  it('extracts author / series / position / title from the conventional pattern', () => {
    expect(parseFilenameMetadata('Jane Doe - Solway Bay 03 - The Long Tide.txt')).toEqual({
      author: 'Jane Doe',
      series: 'Solway Bay',
      seriesPosition: 3,
      title: 'The Long Tide',
    });
  });

  it('strips the extension before matching', () => {
    expect(parseFilenameMetadata('Jane Doe - Solway Bay 01 - Open Water.epub').seriesPosition).toBe(
      1,
    );
  });

  it('returns all-null when the filename does not match the pattern', () => {
    expect(parseFilenameMetadata('just-a-title.txt')).toEqual({
      author: null,
      series: null,
      seriesPosition: null,
      title: null,
    });
  });

  it('returns all-null for an undefined filename', () => {
    expect(parseFilenameMetadata(undefined)).toEqual({
      author: null,
      series: null,
      seriesPosition: null,
      title: null,
    });
  });
});

/* Bug B: conservative title-parenthetical heuristic for series extraction.
   Used as a fallback when authoritative metadata (Calibre tags / filename
   pattern) doesn't carry series info. */
describe('parseSeriesFromTitle', () => {
  it('extracts series and integer position from "Title (Series Book N)"', () => {
    expect(parseSeriesFromTitle('The Tidewatcher’s Oath (The Hollow Tide Book 3)')).toEqual({
      title: 'The Tidewatcher’s Oath',
      series: 'The Hollow Tide',
      seriesPosition: 3,
    });
  });

  it('extracts series and integer position from "Title (Series #N)"', () => {
    expect(parseSeriesFromTitle('A Wizard of Earthsea (Earthsea #1)')).toEqual({
      title: 'A Wizard of Earthsea',
      series: 'Earthsea',
      seriesPosition: 1,
    });
  });

  it('preserves decimal positions like 1.5 (novellas)', () => {
    expect(parseSeriesFromTitle('Knife Children (Lakewalker Book 1.5)')).toEqual({
      title: 'Knife Children',
      series: 'Lakewalker',
      seriesPosition: 1.5,
    });
  });

  it('matches case-insensitively (Book / BOOK / book)', () => {
    expect(parseSeriesFromTitle('Foo (Bar BOOK 2)').series).toBe('Bar');
    expect(parseSeriesFromTitle('Foo (Bar book 2)').series).toBe('Bar');
  });

  it('leaves the title untouched and returns null series when no parenthetical matches', () => {
    expect(parseSeriesFromTitle('Pride and Prejudice')).toEqual({
      title: 'Pride and Prejudice',
      series: null,
      seriesPosition: null,
    });
  });

  it('does not false-positive on subtitles that lack "Book N" or "#N"', () => {
    /* "(Revised Edition)" is a common non-series subtitle — must NOT split. */
    expect(parseSeriesFromTitle('Foundation (Revised Edition)').series).toBeNull();
    /* "(A Novel)" too. */
    expect(parseSeriesFromTitle('The Underground Railroad (A Novel)').series).toBeNull();
  });

  it('trims whitespace from the input title before matching', () => {
    expect(parseSeriesFromTitle('  The Tidewatcher’s Oath (The Hollow Tide Book 3)  ').series).toBe(
      'The Hollow Tide',
    );
  });
});

/* parseText integration with parseSeriesFromTitle — markdown H1 with a
   series parenthetical should produce a clean title plus extracted series
   even when there's no filename metadata to lean on. */
describe('parseText — series extraction from title heuristic', () => {
  it('splits "(Series Book N)" off the H1 when filename has no metadata', () => {
    const out = parseText(
      '# The Tidewatcher’s Oath (The Hollow Tide Book 3)\n\nThe story begins.',
      { format: 'markdown' },
    );
    expect(out.title).toBe('The Tidewatcher’s Oath');
    expect(out.series).toBe('The Hollow Tide');
    expect(out.seriesPosition).toBe(3);
    expect(out.seriesFromTitle).toBe(true);
  });

  it('filename-derived series wins over title heuristic (authoritative > guess)', () => {
    const out = parseText(
      '# The Tidewatcher’s Oath (The Hollow Tide Book 3)\n\nThe story.',
      {
        format: 'markdown',
        fileName: 'Della Renwick - the Hollow Tide 03 - The Tidewatcher’s Oath.md',
      },
    );
    /* Filename gives the Hollow Tide + 3; the title heuristic doesn't run, so
       seriesFromTitle stays false (the value is filename-authoritative). */
    expect(out.series).toBe('the Hollow Tide');
    expect(out.seriesPosition).toBe(3);
    expect(out.seriesFromTitle).toBe(false);
  });

  it('leaves seriesFromTitle false on a plain markdown with no parenthetical', () => {
    const out = parseText('# Pride and Prejudice\n\nIt is a truth.', { format: 'markdown' });
    expect(out.series).toBeNull();
    expect(out.seriesFromTitle).toBe(false);
  });
});

describe('parseText — title detection', () => {
  it('captures the first markdown H1 as the manuscript title', () => {
    const out = parseText('# The Lighthouse\n\nOnce there was a tower.', { format: 'markdown' });
    expect(out.title).toBe('The Lighthouse');
  });

  it('falls back to filename-derived title when no H1 present', () => {
    const out = parseText('body only', {
      format: 'plaintext',
      fileName: 'Jane Doe - Solway Bay 02 - Riptide.txt',
    });
    expect(out.title).toBe('Riptide');
  });

  it('falls back to filename stem when filename has no series pattern', () => {
    const out = parseText('body only', { format: 'plaintext', fileName: 'rough-draft.txt' });
    expect(out.title).toBe('rough-draft');
  });

  it('falls back to "Untitled manuscript" when nothing else identifies it', () => {
    expect(parseText('body only', { format: 'plaintext' }).title).toBe('Untitled manuscript');
  });
});

describe('parseText — chapter splitting', () => {
  it('splits on markdown H2 headings', () => {
    const out = parseText('# Book\n\n## One\nfirst chapter body\n\n## Two\nsecond chapter body', {
      format: 'markdown',
    });
    expect(out.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
    expect(out.chapters[0].body).toContain('first chapter body');
    expect(out.chapters[1].body).toContain('second chapter body');
  });

  it('splits on Arabic numbered chapter headings', () => {
    const out = parseText('Chapter 1\nalpha body\n\nChapter 2\nbeta body', { format: 'plaintext' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('splits on Roman-numeral chapter headings', () => {
    const out = parseText('Chapter IV\nfourth\n\nChapter V\nfifth', { format: 'plaintext' });
    expect(out.chapters).toHaveLength(2);
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter IV', 'Chapter V']);
  });

  it('splits on English-word numbered chapters including compound 21–99', () => {
    const out = parseText(
      'Chapter One\nfirst\n\nChapter Twenty-One\ntwenty-first\n\nChapter Forty Two\nforty-second',
      { format: 'plaintext' },
    );
    expect(out.chapters.map((c) => c.title)).toEqual([
      'Chapter One',
      'Chapter Twenty-One',
      'Chapter Forty Two',
    ]);
  });

  it('recognises other section keywords (Day, Part, Book, Act, Section, Scene)', () => {
    const out = parseText('Day One\nfirst\n\nPart II\nsecond\n\nAct III\nthird', {
      format: 'plaintext',
    });
    expect(out.chapters.map((c) => c.title)).toEqual(['Day One', 'Part II', 'Act III']);
  });

  it('recognises standalone Prologue / Epilogue / Interlude / Preface markers', () => {
    const out = parseText('Prologue\np-body\n\nChapter 1\nbody\n\nEpilogue\ne-body', {
      format: 'plaintext',
    });
    expect(out.chapters.map((c) => c.title)).toEqual(['Prologue', 'Chapter 1', 'Epilogue']);
  });

  it('strips cosmetic decoration around chapter markers', () => {
    const out = parseText('+ DAY ONE +\nbody\n\n=== Chapter 3 ===\nthree', { format: 'plaintext' });
    expect(out.chapters.map((c) => c.title)).toEqual(['DAY ONE', 'Chapter 3']);
  });

  it('does NOT treat long heading-like lines (>120 chars) as headings', () => {
    const longLine =
      'Day after day the keeper climbed those iron stairs, polishing the lens, ' +
      'checking the wick, and watching the gray light slip across the cold water of Solway Bay forever.';
    expect(longLine.length).toBeGreaterThan(120);
    const out = parseText(`Chapter 1\n${longLine}\n\nMore body.`, { format: 'plaintext' });
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0].body).toContain(longLine);
  });

  it('falls back to one chapter when no headings are present', () => {
    const out = parseText('Just a paragraph.\n\nAnd another.', { format: 'plaintext' });
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0].body).toContain('Just a paragraph.');
    expect(out.chapters[0].body).toContain('And another.');
  });

  it('uses 1-based ids on chapters', () => {
    const out = parseText('## One\na\n\n## Two\nb', { format: 'markdown' });
    expect(out.chapters.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe('parseText — subtitle merge', () => {
  it('merges a title-cased next-line subtitle into the bare numbered heading', () => {
    const out = parseText('Chapter 3\nThe Beginning\n\nOnce upon a time, the wind blew softly.', {
      format: 'plaintext',
    });
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0].title).toBe('Chapter 3 — The Beginning');
    expect(out.chapters[0].body).toContain('Once upon a time');
    expect(out.chapters[0].body).not.toContain('The Beginning');
  });

  it('also merges across a blank line between heading and subtitle', () => {
    const out = parseText('Chapter 3\n\nThe Beginning\n\nBody text here.', { format: 'plaintext' });
    expect(out.chapters[0].title).toBe('Chapter 3 — The Beginning');
    expect(out.chapters[0].body).not.toContain('The Beginning');
  });

  it('merges with standalone Prologue / Epilogue when followed by a title', () => {
    const out = parseText('Prologue\nFirst Light\n\nThe sun rose over the bay.', {
      format: 'plaintext',
    });
    expect(out.chapters[0].title).toBe('Prologue — First Light');
  });

  it('does NOT merge when heading is already descriptive (`Chapter 3: The Beginning`)', () => {
    const out = parseText('Chapter 3: The Beginning\nFirst Light Of Dawn\n\nBody.', {
      format: 'plaintext',
    });
    expect(out.chapters[0].title).toBe('Chapter 3: The Beginning');
    expect(out.chapters[0].body).toContain('First Light Of Dawn');
  });

  it('does NOT merge when next line looks like body prose (capital + lowercase non-stopword)', () => {
    const out = parseText('Chapter 1\nFirst body line here.\n\nMore body.', {
      format: 'plaintext',
    });
    expect(out.chapters[0].title).toBe('Chapter 1');
    expect(out.chapters[0].body).toContain('First body line here.');
  });

  it('does NOT merge when next line is the next chapter heading', () => {
    const out = parseText('Chapter 1\n\nChapter 2\nbody.', { format: 'plaintext' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 2']);
  });

  it('does NOT merge when next line ends with a period', () => {
    const out = parseText('Chapter 1\nThe Beginning.\n\nBody.', { format: 'plaintext' });
    expect(out.chapters[0].title).toBe('Chapter 1');
    expect(out.chapters[0].body).toContain('The Beginning.');
  });

  it('does NOT merge when next line exceeds the 80-char subtitle cap', () => {
    const longLine =
      'A Beginning That Sprawls Across Many Words And Will Not Stop Anytime Soon Indeed Lengthy';
    expect(longLine.length).toBeGreaterThan(80);
    const out = parseText(`Chapter 1\n${longLine}\n\nBody.`, { format: 'plaintext' });
    expect(out.chapters[0].title).toBe('Chapter 1');
  });

  it('preserves stopwords in subtitle titles ("The Cook\'s Particular Soup")', () => {
    const out = parseText("Chapter 4\nThe Cook's Particular Soup\n\nBody.", {
      format: 'plaintext',
    });
    expect(out.chapters[0].title).toBe("Chapter 4 — The Cook's Particular Soup");
  });
});

describe('parseText — filename metadata propagation', () => {
  it('populates author / series / seriesPosition when filename matches', () => {
    const out = parseText('# Title from doc\n\nbody', {
      format: 'markdown',
      fileName: 'Jane Doe - Solway Bay 05 - Anything.txt',
    });
    expect(out.author).toBe('Jane Doe');
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(5);
  });

  it('leaves metadata null when filename does not match', () => {
    const out = parseText('body', { format: 'plaintext', fileName: 'random.txt' });
    expect(out.author).toBeNull();
    expect(out.series).toBeNull();
    expect(out.seriesPosition).toBeNull();
  });

  it('prefers the in-document H1 title over the filename-derived title', () => {
    const out = parseText('# Real Title\n\nbody', {
      format: 'markdown',
      fileName: 'Jane Doe - Solway Bay 02 - Ignored.txt',
    });
    expect(out.title).toBe('Real Title');
  });
});

describe('parseText — non-English chapter splitting (seam 3a)', () => {
  it('splits a Spanish plaintext manuscript on "Capítulo N"', () => {
    const md = 'Capítulo 1\n\nEra una noche oscura.\n\nCapítulo 2\n\nA la mañana siguiente.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toMatch(/Capítulo 1/);
  });

  it('splits a German plaintext manuscript on "Kapitel N"', () => {
    const md = 'Kapitel 1\n\nEs war eine dunkle Nacht.\n\nKapitel 2\n\nAm nächsten Morgen.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
  });

  it('splits a Russian plaintext manuscript on "Глава N" and preserves the Cyrillic title', () => {
    const md = 'Глава 1\n\nБыла тёмная ночь.\n\nГлава 2\n\nНа следующее утро.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toMatch(/Глава 1/); // not stripped to empty by normaliseHeading
  });

  it('splits Spanish word-numbered + standalone headings (Capítulo Uno / Prólogo)', () => {
    const md = 'Prólogo\n\nUnas palabras.\n\nCapítulo Uno\n\nComienza la historia.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
  });
});

describe('parseText — audio-tag passthrough', () => {
  it('applies tagShoutingDialog to chapter bodies', () => {
    const out = parseText('Chapter 1\nShe yelled "GET OUT NOW".', { format: 'plaintext' });
    expect(out.chapters[0].body).toContain('[shouting] Get Out Now');
  });

  it('applies tagMarkdownEmphasis to chapter bodies', () => {
    const out = parseText('Chapter 1\nthis is *important* news.', { format: 'plaintext' });
    expect(out.chapters[0].body).toContain('[emphatic] important');
  });

  it('applies audio tags to the single-chapter fallback body', () => {
    const out = parseText('Just "GO AWAY NOW".', { format: 'plaintext' });
    expect(out.chapters[0].body).toContain('[shouting] Go Away Now');
  });
});

describe('parseText — return shape', () => {
  it('returns sourceText as the concatenation of chapter bodies joined by \\n\\n', () => {
    const out = parseText('## One\nfirst\n\n## Two\nsecond', { format: 'markdown' });
    expect(out.sourceText).toBe(out.chapters.map((c) => c.body).join('\n\n'));
  });

  it('echoes the requested format', () => {
    expect(parseText('a', { format: 'markdown' }).format).toBe('markdown');
    expect(parseText('a', { format: 'plaintext' }).format).toBe('plaintext');
  });

  it('normalises CRLF line endings', () => {
    const out = parseText('## One\r\nbody one\r\n\r\n## Two\r\nbody two', { format: 'markdown' });
    expect(out.chapters.map((c) => c.title)).toEqual(['One', 'Two']);
  });
});
