import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText } from '../scrub-kotlc.mjs';

test('multi-word before single-word', () => {
  assert.equal(scrubText('Sophie Foster and Sophie'), 'Wren Sparrow and Wren');
  assert.equal(scrubText('Keefe Sencen'), 'Marlow Halden');
});

test('case preservation', () => {
  assert.equal(scrubText('SOPHIE said to keefe'), 'WREN said to marlow');
  assert.equal(scrubText('Sophie said to Keefe'), 'Wren said to Marlow');
});

test('word boundaries — no mid-word hits', () => {
  assert.equal(scrubText('Fosters philosophiel'), 'Fosters philosophiel');
});

test('books', () => {
  assert.equal(scrubText('Keeper of the Lost Cities: Stellarlune'),
    'The Hollow Tide: The Drowning Bell');
});

test('kebab/slug forms', () => {
  assert.equal(scrubText("id: 'sophie-foster'"), "id: 'wren-sparrow'");
  assert.equal(scrubText('mock-book-stellarlune'), 'mock-book-the-drowning-bell');
  assert.equal(scrubText("characterId: 'keefe'"), "characterId: 'marlow'");
});

test('common words are LEFT ALONE (context-only, not codemod)', () => {
  assert.equal(scrubText('the legacy pairing format'), 'the legacy pairing format');
  assert.equal(scrubText('exile the chapter'), 'exile the chapter');
  assert.equal(scrubText('foster a connection'), 'foster a connection');
  assert.equal(scrubText('Unlocked the door'), 'Unlocked the door');
});

test('titled councillors/lords keep the rank, swap the surname', () => {
  assert.equal(scrubText('Dame Alina and Councillor Terik'),
    'Dame Linnet and Councillor Brask');
  assert.equal(scrubText('Lord Cassius'), 'Lord Vane');
});

test('manuscript path replaced before name patterns', () => {
  assert.equal(
    scrubText('C:\\Users\\dudar\\Downloads\\Bonus Keefe Story.txt'),
    'server/src/__fixtures__/the-coalfall-commission.md');
  assert.equal(scrubText('the Bonus Keefe Story regression'),
    'the the Coalfall Commission regression');
});

test('series acronym KOTLC (all cases) → the Hollow Tide', () => {
  assert.equal(scrubText('across KOTLC and KotLC and kotlc'),
    'across the Hollow Tide and the Hollow Tide and the Hollow Tide');
});

test('apostrophe target stays valid inside single-quoted strings', () => {
  assert.equal(scrubText("bookTitle: 'Everblaze'"),
    "bookTitle: 'The Tidewatcher’s Oath'");
});

test('underscore-adjacent tokens are caught (slug compound)', () => {
  assert.equal(scrubText('mock__everblaze'), 'mock__the-tidewatchers-oath');
});

test('Capitalised prose word next to a hyphen keeps its case (not a slug)', () => {
  assert.equal(scrubText('Keefe-as-Lady-Gisela said'), 'Marlow-as-Lady-Renna said');
  assert.equal(scrubText("id: 'keefe-foo'"), "id: 'marlow-foo'");
});

test('camelCase / PascalCase identifier prefixes', () => {
  assert.equal(scrubText('sophieFoster and keefeRow'), 'wrenFoster and marlowRow');
  assert.equal(scrubText('const BianaCall = 1'), 'const MaerinCall = 1');
});

test('camelCase pass does NOT over-match a name glued to a lowercase letter', () => {
  // `Dex`→Hart, `Tam`→Pell: a following LOWERCASE letter is a different word,
  // not camelCase — must stay untouched (no `dexter`→`hartter`, `tamper`→`pellper`).
  assert.equal(scrubText('dexterity and tamper'), 'dexterity and tamper');
  assert.equal(scrubText('Dexterous'), 'Dexterous');
});

test('Tam (KotLC Tam Song) maps to Pell — no collision with Keefe', () => {
  assert.equal(scrubText('Keefe and Tam'), 'Marlow and Pell');
  assert.equal(scrubText('Tam Song'), 'Pell Marsh');
});
