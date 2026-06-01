// Unit coverage for the pure parse/ID helpers in migrate-backlog-to-issues.mjs.
// No `gh`, no network — exercises the BACKLOG.md shapes the migration depends on
// (plan 165). The idempotency guarantee rests on issueIdFromTitle round-tripping
// the title issuePayload produces, so that's asserted explicitly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBacklogItems,
  issueIdFromTitle,
  issuePayload,
} from '../migrate-backlog-to-issues.mjs';

// A fixture covering every shape the real file uses: Must `###` item, Could
// `###` sub-group title + `####` items, a tracking item, a struck-through
// RESOLVED item, an inline ~~strikethrough~~ that is NOT resolved, an ID-less
// shipped-note paragraph between items, and a Won't `###` item.
const FIXTURE = `# Backlog (MoSCoW)

Some preamble that is not an item.

## Must — blocks v1 ship

### \`fs-1\` — In-app upgrade pathway (package-drop install)

- _What:_ one-click upgrade.
- _Benefit (user):_ removes the manual rite.

_\`fs-2\` (multi-language) shipped — see plan 162. This is a note, not an item._

---

## Should — important, not blocking ship

### \`srv-4\` — Track deprecation chains (~~jsdom~~ · @google/genai)

- _What:_ Pure tracking item. Re-run the audit.

### \`srv-17\` — ~~Root-cause the silent death~~ → RESOLVED as a port collision

- _What (done):_ added a listen error handler.

## Could — nice to have

### Audio & playback

#### \`fs-9\` — Configurable chapter-title silence

- _What:_ promote two constants to a per-book setting.

## Won't (this round) — explicitly parked

### \`ops-5\` — Trim build/e2e from per-PR verify

- _Why parked:_ Linux build breaks would slip past a Windows dev box.

## Retired numbering

### \`zz-9\` — should never be parsed (after Retired numbering)
`;

test('parseBacklogItems extracts items with the right tier + prefix, skipping non-items', () => {
  const { items, warnings } = parseBacklogItems(FIXTURE);

  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, ['fs-1', 'srv-4', 'fs-9', 'ops-5']);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join('; ')}`);

  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId['fs-1'].tier, 'must');
  assert.equal(byId['srv-4'].tier, 'should');
  assert.equal(byId['fs-9'].tier, 'could');
  assert.equal(byId['ops-5'].tier, 'wont');
  assert.equal(byId['fs-9'].prefix, 'fs');
});

test('a sub-group title and the Retired-numbering heading are not items', () => {
  const { items } = parseBacklogItems(FIXTURE);
  // "### Audio & playback" (no id) and "### `zz-9`" (after Retired numbering,
  // and zz is not an allowed prefix anyway) must not appear.
  assert.ok(!items.some((i) => i.id === 'zz-9'));
  assert.ok(!items.some((i) => /Audio & playback/.test(i.title)));
});

test('struck-through RESOLVED entries are reported, not filed', () => {
  const { items, skipped } = parseBacklogItems(FIXTURE);
  assert.ok(!items.some((i) => i.id === 'srv-17'), 'srv-17 must not be filed');
  assert.ok(skipped.some((s) => s.id === 'srv-17'), 'srv-17 must be reported as skipped');
});

test('inline ~~strikethrough~~ in a title does not mark the item resolved', () => {
  const { items } = parseBacklogItems(FIXTURE);
  const srv4 = items.find((i) => i.id === 'srv-4');
  assert.ok(srv4, 'srv-4 must be filed despite an inline ~~jsdom~~');
  // cleanTitle unwraps the inline strikethrough.
  assert.match(srv4.title, /jsdom · @google\/genai/);
  assert.doesNotMatch(srv4.title, /~~/);
});

test('a tracking item gets type:chore + tracking; a normal one gets type:feature', () => {
  const { items } = parseBacklogItems(FIXTURE);
  const srv4 = items.find((i) => i.id === 'srv-4'); // body says "Pure tracking item"
  const fs1 = items.find((i) => i.id === 'fs-1');
  assert.ok(srv4.tracking);
  assert.ok(!fs1.tracking);
  assert.deepEqual(issuePayload(srv4).labels, ['area:srv', 'moscow:should', 'type:chore', 'tracking']);
  assert.deepEqual(issuePayload(fs1).labels, ['area:fs', 'moscow:must', 'type:feature']);
});

test('the ID-less shipped-note paragraph does not bleed into fs-1 body', () => {
  const { items } = parseBacklogItems(FIXTURE);
  const fs1 = items.find((i) => i.id === 'fs-1');
  assert.doesNotMatch(fs1.body, /multi-language/);
  assert.match(fs1.body, /one-click upgrade/);
});

test('issueIdFromTitle round-trips the title issuePayload builds (idempotency key)', () => {
  const { items } = parseBacklogItems(FIXTURE);
  for (const item of items) {
    const { title } = issuePayload(item);
    assert.equal(issueIdFromTitle(title), item.id, `round-trip failed for ${item.id}: "${title}"`);
  }
});

test('issueIdFromTitle returns null for a title that lost its prefix', () => {
  assert.equal(issueIdFromTitle('In-app upgrade pathway'), null);
  assert.equal(issueIdFromTitle('fs-1 — In-app upgrade pathway'), 'fs-1');
  assert.equal(issueIdFromTitle('  side-12 — load .pt safely'), 'side-12');
});

test('issuePayload body carries the canonical detail + a backlog trailer', () => {
  const { items } = parseBacklogItems(FIXTURE);
  const fs1 = items.find((i) => i.id === 'fs-1');
  const { body } = issuePayload(fs1);
  assert.match(body, /one-click upgrade/);
  assert.match(body, /Backlog: `fs-1` · MoSCoW: Must/);
});
