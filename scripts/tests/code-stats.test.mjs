// Pin the pure helpers of scripts/code-stats.mjs.
// Discovered by `npm run test:hooks` (node --test scripts/tests/*.test.mjs).
//
// These exercise the tokei-JSON → markdown transform WITHOUT invoking tokei:
// the script's procedure is behind an import.meta-main guard, so importing it
// here is inert and CI (which has no tokei) stays green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFile,
  summarize,
  renderMarkdown,
  replaceBlock,
  START_MARKER,
  END_MARKER,
} from '../code-stats.mjs';

// A minimal tokei `--output json` shape: top-level language keys + "Total",
// each language carrying per-file `reports`. Mixes prod + test paths across
// languages, plus a non-code language (JSON) that must stay out of the code
// totals.
const FIXTURE = {
  Total: { code: 420, comments: 0, blanks: 0, reports: [] },
  TypeScript: {
    code: 115,
    comments: 30,
    blanks: 12,
    reports: [
      { name: 'src/lib/api.ts', stats: { code: 60, comments: 18, blanks: 8 } },
      { name: 'src/lib/api.test.ts', stats: { code: 40, comments: 10, blanks: 3 } },
      { name: 'e2e/flow.spec.ts', stats: { code: 15, comments: 2, blanks: 1 } },
    ],
  },
  TSX: {
    code: 30,
    comments: 4,
    blanks: 2,
    reports: [{ name: 'src/views/cast.tsx', stats: { code: 30, comments: 4, blanks: 2 } }],
  },
  Python: {
    code: 75,
    comments: 6,
    blanks: 9,
    reports: [
      { name: 'server/tts-sidecar/main.py', stats: { code: 50, comments: 4, blanks: 6 } },
      { name: 'server/tts-sidecar/tests/test_x.py', stats: { code: 25, comments: 2, blanks: 3 } },
    ],
  },
  JSON: {
    code: 200,
    comments: 0,
    blanks: 0,
    reports: [{ name: 'package-lock.json', stats: { code: 200, comments: 0, blanks: 0 } }],
  },
};

test('classifyFile flags test/spec files and e2e/tests dirs (both separators)', () => {
  assert.equal(classifyFile('src/lib/api.ts'), 'prod');
  assert.equal(classifyFile('src/lib/api.test.ts'), 'test');
  assert.equal(classifyFile('src/views/cast.test.tsx'), 'test');
  assert.equal(classifyFile('scripts/foo.test.mjs'), 'test');
  assert.equal(classifyFile('e2e/flow.spec.ts'), 'test');
  assert.equal(classifyFile('server/x/tests/y.ts'), 'test');
  assert.equal(classifyFile('C:\\repo\\src\\lib\\api.test.ts'), 'test');
  // `spec`/`test` only count as a file-name suffix or a full path segment —
  // these must NOT be misread as tests.
  assert.equal(classifyFile('src/spec-utils.ts'), 'prod');
  assert.equal(classifyFile('src/tests-helpers/foo.ts'), 'prod');
});

test('summarize buckets code vs test and excludes non-code languages from the code total', () => {
  const s = summarize(FIXTURE);

  // Totals span every listed language (including JSON), recomputed from reports.
  assert.equal(s.totals.files, 7); // 3 TS + 1 TSX + 2 PY + 1 JSON
  assert.equal(s.totals.code, 420); // 115 + 30 + 75 + 200

  // "Source code" excludes JSON.
  assert.equal(s.code.code, 220); // 115 + 30 + 75
  assert.equal(s.code.files, 6); // 3 + 1 + 2

  // Prod vs test split is by file path, summed over code languages only.
  assert.equal(s.code.prodCode, 140); // api.ts 60 + cast.tsx 30 + main.py 50
  assert.equal(s.code.testCode, 80); // api.test.ts 40 + flow.spec.ts 15 + test_x.py 25
  assert.equal(s.code.testFiles, 3);

  // Languages sorted by code desc.
  assert.deepEqual(
    s.byLanguage.map((l) => l.lang),
    ['JSON', 'TypeScript', 'Python', 'TSX'],
  );
});

test('renderMarkdown is deterministic given a fixed date and carries the headline numbers', () => {
  const md = renderMarkdown(summarize(FIXTURE), { date: '2026-01-01' });
  assert.match(md, /on 2026-01-01 via \[tokei\]/);
  assert.match(md, /\| TypeScript \| 3 \| 115 \| 30 \| 12 \|/);
  assert.match(md, /\| \*\*Total\*\* \| \*\*7\*\* \| \*\*420\*\*/);
  assert.match(md, /\*\*220\*\* lines across \*\*6\*\* files/);
  assert.match(md, /~140 lines of application code against ~80 lines of test code \(3 test files\)/);
  assert.match(md, /roughly \*\*0\.57\*\*/); // 80 / 140
});

test('replaceBlock swaps content between markers and is idempotent (LF)', () => {
  const doc = `intro\n${START_MARKER}\nold body\n${END_MARKER}\noutro\n`;
  const once = replaceBlock(doc, 'NEW\nBODY');
  assert.match(once, /intro\n/);
  assert.match(once, /outro\n/);
  assert.match(once, /NEW\nBODY/);
  assert.doesNotMatch(once, /old body/);
  // Re-applying the same body yields a byte-identical doc.
  assert.equal(replaceBlock(once, 'NEW\nBODY'), once);
});

test('replaceBlock preserves CRLF line endings (Windows checkout idempotency)', () => {
  const doc = `intro\r\n${START_MARKER}\r\nold\r\n${END_MARKER}\r\noutro\r\n`;
  const once = replaceBlock(doc, 'NEW\nBODY');
  assert.match(once, /NEW\r\nBODY/); // LF block normalised to the doc's CRLF
  assert.doesNotMatch(once, /NEW\nBODY/); // no bare LF leaked in
  assert.equal(replaceBlock(once, 'NEW\nBODY'), once);
});

test('replaceBlock throws when markers are missing', () => {
  assert.throws(() => replaceBlock('no markers here', 'x'), /Missing or malformed CODE-STATS/);
  assert.throws(
    () => replaceBlock(`${END_MARKER}\n${START_MARKER}`, 'x'),
    /Missing or malformed CODE-STATS/,
  );
});
