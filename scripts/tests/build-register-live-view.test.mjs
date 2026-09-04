import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGeneratedRegion,
  parseRegisterFigures,
  buildStripRegion,
  buildLiveView,
  parseBodyGroupCounts,
  reconcileRowShells,
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
  blocked = 5,
  unconfirmed = 2,
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

  <section class="group is-blocked" id="blocked">
    <header>
      <h3 class="gtitle"><span class="gtag">BLK</span> Blocked <span class="gcount">${blocked} rows</span></h3>
    </header>
    <details class="item">
      <summary><span class="num">—</span><span class="iname">fixture blocked item</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Fixture body.</p>
      </div>
    </details>
  </section>

  <section class="group is-soft" id="unconfirmed">
    <header>
      <h3 class="gtitle"><span class="gtag">?</span> Unconfirmed <span class="gcount">${unconfirmed} rows</span></h3>
    </header>
    <details class="item">
      <summary><span class="num">—</span><span class="iname">fixture unconfirmed item</span><span class="chev">›</span></summary>
      <div class="body">
        <p>Fixture body.</p>
      </div>
    </details>
  </section>
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

test('parseBodyGroupCounts counts headings, not the glance table', () => {
  const md = `## Group A — setup a

### A1 · one
### A2 · two

## Group B — setup b

### B1 · one
`;
  const counts = parseBodyGroupCounts(md);
  assert.deepEqual([...counts.entries()], [['A', 2], ['B', 1]]);
});

test('buildLiveView rewrites a gcount span located by its enclosing section id, leaving gtitle prose untouched', () => {
  const md = buildRegisterFixture() + '\n### A2 · two\n### A3 · three\n';
  const html = buildLiveViewFixture();
  const next = buildLiveView(md, html);
  assert.match(next, /id="ga"[\s\S]*?<span class="gcount">3 rows<\/span>/);
  assert.match(next, /<span class="gtag">A<\/span> Group A/);
});

test('the groups target covers Blocked and Unconfirmed sections too', () => {
  const md = buildRegisterFixture({ blocked: 5, unconfirmed: 2 });
  const html = buildLiveViewFixture({ blocked: 99, unconfirmed: 99 });
  const next = buildLiveView(md, html);
  assert.match(next, /id="blocked"[\s\S]*?<span class="gcount">5 rows<\/span>/);
  assert.match(next, /id="unconfirmed"[\s\S]*?<span class="gcount">2 rows<\/span>/);
});

test('a row added to the .md inserts a placeholder shell, wrapped in <details>, in markdown order', () => {
  const md = `## Group A — setup a

### A1 · first
### A2 · second (new)
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle"><span class="gtag">A</span> setup a <span class="gcount">1 row</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">existing body</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  const order = [...next.matchAll(/<span class="num">(A\d+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1', 'A2']);
  assert.match(next, /A2[\s\S]*body-placeholder/);
  assert.equal((next.match(/<details class="item">/g) ?? []).length, 2);
  assert.equal((next.match(/<\/details>/g) ?? []).length, 2); // balanced — the defect an earlier draft shipped
});

test('the header block is preserved verbatim, including the gcount span Task 6 already wrote', () => {
  const md = `## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle"><span class="gtag">A</span> The GPU box <span class="gcount">1 row</span></h3><p class="setup">hand-authored</p></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">b</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.match(next, /hand-authored/);
  assert.match(next, /<span class="gcount">1 row<\/span>/);
});

test('a row removed from the .md deletes its shell and nothing adjacent', () => {
  const md = `## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle">…<span class="gcount">2 rows</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">keep me</div>
      </details>
      <details class="item">
        <summary><span class="num">A2</span><span class="iname">discharged</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">gone</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.match(next, /keep me/);
  assert.doesNotMatch(next, /gone/);
});

test('reordered .md rows reorder shells, each body following its own ID', () => {
  const md = `## Group A — setup a

### A2 · second
### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle">…<span class="gcount">2 rows</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">body one</div>
      </details>
      <details class="item">
        <summary><span class="num">A2</span><span class="iname">second</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">body two</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  assert.ok(next.indexOf('body two') < next.indexOf('body one'), 'A2 (now first in .md order) must come before A1');
});

test('the publish-token heading is not treated as a row', () => {
  const md = `## Live view

### The publish token — never hand-edit it

Some prose.

## Group A — setup a

### A1 · first
`;
  const html = `<section class="group" id="ga">
      <header><h3 class="gtitle">…<span class="gcount">1 row</span></h3></header>
      <details class="item">
        <summary><span class="num">A1</span><span class="iname">first</span><span class="risk">r</span><span class="chev">›</span></summary>
        <div class="body">b</div>
      </details>
  </section>`;
  const next = reconcileRowShells(md, html);
  const order = [...next.matchAll(/<span class="num">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['A1']);
});
