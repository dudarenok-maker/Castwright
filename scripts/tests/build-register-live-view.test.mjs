import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGeneratedRegion,
  parseRegisterFigures,
  buildStripRegion,
  buildLiveView,
} from '../build-register-live-view.mjs';

test('applyGeneratedRegion replaces only the marked region', () => {
  const html = 'before\n<!-- BEGIN GENERATED:x -->old<!-- END GENERATED:x -->\nafter';
  const result = applyGeneratedRegion(html, 'x', 'new');
  assert.equal(result, 'before\n<!-- BEGIN GENERATED:x -->new<!-- END GENERATED:x -->\nafter');
});

test('applyGeneratedRegion throws when the marker pair is missing', () => {
  assert.throws(
    () => applyGeneratedRegion('no markers here', 'x', 'new'),
    /missing generated-region marker pair "x"/,
  );
});

function buildRegisterFixture({
  owed = 61,
  oldest = '**2026-06-01**',
  glanceRows = [['A', 37], ['B', 2], ['C', 4], ['D', 3], ['E', 10], ['G', 2], ['H', 2]],
  blocked = 5,
  unconfirmed = 2,
  a1StillOwed = 40,
  a1Subtotal = 60,
} = {}) {
  const rows = glanceRows
    .map(([l, n]) => `| **${l}** | Setup ${l} | ${n} |`)
    .join('\n');
  return `# On-box acceptance register

## At a glance

| Group | Setup | Rows |
|---|---|---|
${rows}
| — | **Blocked** (hardware absent) | ${blocked} |
| — | **Unconfirmed** (not debts until substantiated) | ${unconfirmed} |

**${owed} owed.** Oldest: ${oldest} (plan 161).

---

## Group A — setup a

### A1 · A title

<!-- stat:a1-still-owed ${a1StillOwed} -->
<!-- stat:a1-subtotal ${a1Subtotal} -->

Some body text.
`;
}

// Companion live-view fixture for buildRegisterFixture. Matches its default
// group letters (A, B, C, D, E, G, H). Task 7 (row-shell reconciliation) and
// Task 8 (idempotence) call this bare and need a structurally-complete page —
// not just the strip/glance regions this task exercises — so every group gets
// a full <header> plus at least one real <details class="item"> shell.
function buildLiveViewFixture({
  glance = { A: 37, B: 2, C: 4, D: 3, E: 10, G: 2, H: 2 },
  setupText = 'Setup text for the group',
} = {}) {
  const rows = Object.entries(glance)
    .map(
      ([letter, count]) =>
        `      <tr><td><a href="#g${letter.toLowerCase()}">${letter}</a></td><td>${setupText}</td><td><!-- BEGIN GENERATED:glance:${letter} -->${count}<!-- END GENERATED:glance:${letter} --></td></tr>`,
    )
    .join('\n');

  const sections = Object.entries(glance)
    .map(
      ([letter, count]) => `  <section class="group" id="g${letter.toLowerCase()}">
    <header>
      <h3 class="gtitle"><span class="gtag">${letter}</span> Group ${letter} <span class="gcount">${count} rows</span></h3>
    </header>
    <details class="item">
      <summary><span class="num">${letter}1</span><span class="iname">fixture item</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Fixture body.</p>
      </div>
    </details>
  </section>`,
    )
    .join('\n\n');

  return `<!doctype html>
<html>
<body>
  <div class="strip">
    <!-- BEGIN GENERATED:strip -->placeholder<!-- END GENERATED:strip -->
  </div>

  <div class="tscroll">
  <table class="glance">
    <thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>

${sections}
</body>
</html>
`;
}

test('buildLiveView rewrites only the glance count cells that changed', () => {
  const md = buildRegisterFixture({ glanceRows: [['A', 5], ['B', 2]] });
  const html = buildLiveViewFixture({ glance: { A: 99, B: 2 } });
  const next = buildLiveView(md, html);
  assert.match(next, /BEGIN GENERATED:glance:A -->5<!-- END/);
  assert.match(next, /BEGIN GENERATED:glance:B -->2<!-- END/); // unchanged value, still rewritten byte-identically
});

test('buildLiveView never touches the Setup cell or the jump link', () => {
  const md = buildRegisterFixture();
  const html = buildLiveViewFixture({ setupText: 'A hand-authored, editorially shortened description' });
  const next = buildLiveView(md, html);
  assert.match(next, /A hand-authored, editorially shortened description/);
  assert.match(next, /<a href="#ga">A<\/a>/);
});

test('parseRegisterFigures reads the owed total, oldest debt, and A1 markers', () => {
  const figures = parseRegisterFigures(buildRegisterFixture());
  assert.equal(figures.owedTotal, 61);
  assert.equal(figures.oldestDebtRaw, '**2026-06-01**');
  assert.equal(figures.a1StillOwed, 40);
  assert.equal(figures.a1Subtotal, 60);
});

test('parseRegisterFigures excludes Blocked/Unconfirmed from glanceGroups', () => {
  const figures = parseRegisterFigures(buildRegisterFixture());
  assert.deepEqual([...figures.glanceGroups.keys()].sort(), ['A', 'B', 'C', 'D', 'E', 'G', 'H']);
  assert.equal(figures.blockedCount, 5);
  assert.equal(figures.unconfirmedCount, 2);
});

test('buildStripRegion derives the Groups tile excluding Blocked/Unconfirmed, and the Oldest-debt tile strips markup and the year', () => {
  const inner = buildStripRegion(parseRegisterFigures(buildRegisterFixture()));
  // 7 lettered groups, not 9 (Blocked/Unconfirmed excluded) — tile markup is
  // number-then-label, matching the real live-view's existing tile order.
  assert.match(inner, /<div class="n">7<\/div><div class="l">Groups<\/div>/);
  assert.match(inner, /06-01/);
  assert.doesNotMatch(inner, /2026-06-01/);
});

test('buildStripRegion does not derive the A1 tile from the owed total — the coincidence trap', () => {
  const withDifferentOwed = buildRegisterFixture({ owed: 999 });
  const inner = buildStripRegion(parseRegisterFigures(withDifferentOwed));
  assert.match(inner, /\(of 60\)/); // still A1's own subtotal marker, unaffected by owed=999
});

test('a missing A1 marker is an explicit error, not a silent skip', () => {
  const noMarkers = buildRegisterFixture().replace(
    /<!-- stat:a1-still-owed \d+ -->\n<!-- stat:a1-subtotal \d+ -->\n/,
    '',
  );
  assert.throws(() => parseRegisterFigures(noMarkers), /stat:a1-still-owed/);
});
