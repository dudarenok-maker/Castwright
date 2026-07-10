// Unit coverage for the pure parse/group/render helpers in backlog-sync.mjs.
// No `gh`, no network — mirrors scripts/tests/migrate-backlog-to-issues.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseWhatBenefit, groupByMoscow, renderBacklogMd, toBacklogIssues } from '../backlog-sync.mjs';

test('parseWhatBenefit extracts the What and Benefit bullets', () => {
  const body = [
    'Some preamble prose that is not a bullet.',
    '',
    '- _What:_ Turn the QA gate into a visible per-book report.',
    '- _Benefit (user / strategic):_ proof, not promises.',
    '',
    '---',
  ].join('\n');
  assert.deepEqual(parseWhatBenefit(body), {
    what: 'Turn the QA gate into a visible per-book report.',
    benefit: 'proof, not promises.',
  });
});

test('parseWhatBenefit returns nulls when a bullet is missing', () => {
  const body = '- _What:_ Only a What bullet, no Benefit.';
  assert.deepEqual(parseWhatBenefit(body), {
    what: 'Only a What bullet, no Benefit.',
    benefit: null,
  });
});

test('parseWhatBenefit extracts a ## heading block (backlog-item.yml issue-form shape)', () => {
  const body = [
    '## What',
    'Turn the gate into a visible report.',
    '',
    '## Acceptance',
    '- Some acceptance bullet.',
    '',
    '## Benefit (user / strategic)',
    'Proof, not promises.',
  ].join('\n');
  assert.deepEqual(parseWhatBenefit(body), {
    what: 'Turn the gate into a visible report.',
    benefit: 'Proof, not promises.',
  });
});

test('parseWhatBenefit extracts a **What** bold-heading block and **Benefit (axis):** inline line', () => {
  const body = [
    '**What**',
    '- In-app voice-sample capture with quality guidance.',
    '- Explicit consent on the record.',
    '',
    '**Benefit (user):** the strongest consumer hook.',
  ].join('\n');
  assert.deepEqual(parseWhatBenefit(body), {
    what: 'In-app voice-sample capture with quality guidance. Explicit consent on the record.',
    benefit: 'the strongest consumer hook.',
  });
});

test('parseWhatBenefit returns nulls for a body with no recognizable What/Benefit section', () => {
  const body = '@-';
  assert.deepEqual(parseWhatBenefit(body), { what: null, benefit: null });
});

test('parseWhatBenefit does not truncate a Benefit block whose content merely opens with bold emphasis', () => {
  // Regression: content like "**Proof, not promises.** epub2tts now does..."
  // must NOT be mistaken for the start of a new labeled section — only a
  // recognized label keyword (What/Benefit/Acceptance/...) ends the block.
  const body = [
    '## What',
    'Turn the gate into a report.',
    '',
    '## Benefit (user / strategic)',
    '**Proof, not promises.** Making ours legibly more defends the QA moat.',
  ].join('\n');
  assert.deepEqual(parseWhatBenefit(body), {
    what: 'Turn the gate into a report.',
    benefit: '**Proof, not promises.** Making ours legibly more defends the QA moat.',
  });
});

test('groupByMoscow buckets by tier, ignoring wont/unlabeled, sorted by Priority ascending', () => {
  const issues = [
    { id: 'fs-9', number: 50, moscow: 'could', body: '', priority: null },
    { id: 'fs-1', number: 10, moscow: 'must', body: '', priority: 20 },
    { id: 'fs-5', number: 30, moscow: 'wont', body: '', priority: 5 },
    { id: 'fs-2', number: 20, moscow: 'must', body: '', priority: 10 },
  ];
  const groups = groupByMoscow(issues);
  // fs-2 (priority 10) ranks ABOVE fs-1 (priority 20) despite its higher
  // issue number — this is the whole point of the Priority field.
  assert.deepEqual(groups.must.map((i) => i.id), ['fs-2', 'fs-1']);
  assert.deepEqual(groups.should, []);
  assert.deepEqual(groups.could.map((i) => i.id), ['fs-9']);
});

test('groupByMoscow sorts a missing Priority last, tiebroken by issue number', () => {
  const issues = [
    { id: 'fs-3', number: 30, moscow: 'must', body: '', priority: null },
    { id: 'fs-1', number: 10, moscow: 'must', body: '', priority: 100 },
    { id: 'fs-4', number: 40, moscow: 'must', body: '', priority: null },
  ];
  const groups = groupByMoscow(issues);
  assert.deepEqual(groups.must.map((i) => i.id), ['fs-1', 'fs-3', 'fs-4']);
});

test('renderBacklogMd produces the row shape with issue link + What/Benefit', () => {
  const groups = {
    must: [
      {
        id: 'fs-1',
        number: 973,
        title: 'Per-book performance-QA report',
        url: 'https://github.com/dudarenok-maker/Castwright/issues/973',
        body: '- _What:_ Turn the gate into a report.\n- _Benefit:_ proof, not promises.',
      },
    ],
    should: [],
    could: [],
  };
  const md = renderBacklogMd({ groups, wontIssues: [] });
  assert.match(md, /#### `fs-1` — Per-book performance-QA report \(\[#973\]\(https:\/\/github\.com\/dudarenok-maker\/Castwright\/issues\/973\)\)/);
  assert.match(md, /- _What:_ Turn the gate into a report\./);
  assert.match(md, /- _Benefit:_ proof, not promises\./);
  assert.match(md, /_Full detail \+ acceptance:_ \[#973\]\(https:\/\/github\.com\/dudarenok-maker\/Castwright\/issues\/973\)\./);
});

test('renderBacklogMd flags an issue body missing a What or Benefit bullet', () => {
  const groups = {
    must: [
      { id: 'fs-2', number: 5, title: 'No bullets here', url: 'https://x/5', body: 'just prose' },
    ],
    should: [],
    could: [],
  };
  const md = renderBacklogMd({ groups, wontIssues: [] });
  assert.match(md, /no What section found in #5/);
  assert.match(md, /no Benefit section found in #5/);
});

test('renderBacklogMd lists Won\'t issues as one-liners, sorted by number', () => {
  const groups = { must: [], should: [], could: [] };
  const wontIssues = [
    { id: 'ops-5', number: 200, title: 'Trim build/e2e from per-PR verify', url: 'https://x/200' },
    { id: 'ops-1', number: 100, title: 'An earlier wont item', url: 'https://x/100' },
  ];
  const md = renderBacklogMd({ groups, wontIssues });
  const iOps1 = md.indexOf('ops-1');
  const iOps5 = md.indexOf('ops-5');
  assert.ok(iOps1 > -1 && iOps5 > -1 && iOps1 < iOps5, 'wont issues sorted by issue number');
  assert.match(md, /- `ops-1` — An earlier wont item \(\[#100\]\(https:\/\/x\/100\)\)\./);
});

test('toBacklogIssues skips a project item whose content is a PullRequest or DraftIssue', () => {
  // Regression: a Project item's content can be a PullRequest or DraftIssue,
  // not just an Issue. The GraphQL query's `... on Issue { ... }` fragment
  // then resolves `content` to an empty (non-null) object, so `content.labels`
  // is undefined rather than `content` itself being falsy — crashed the sync
  // the first time a non-Issue card landed on the board.
  const nodes = [
    { status: { name: 'Todo' }, priority: null, content: {} }, // PullRequest/DraftIssue shape
    { status: { name: 'Todo' }, priority: { number: 1 }, content: null }, // no content at all
    {
      status: { name: 'Todo' },
      priority: { number: 2 },
      content: {
        number: 42,
        title: 'fs-9 — Real feature issue',
        url: 'https://github.com/dudarenok-maker/Castwright/issues/42',
        body: '- _What:_ x\n- _Benefit:_ y',
        state: 'OPEN',
        labels: { nodes: [{ name: 'type:feature' }, { name: 'moscow:must' }] },
      },
    },
  ];
  const { featureIssues, wontIssues } = toBacklogIssues(nodes);
  assert.deepEqual(wontIssues, []);
  assert.equal(featureIssues.length, 1);
  assert.equal(featureIssues[0].id, 'fs-9');
});
