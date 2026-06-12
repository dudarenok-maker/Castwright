import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText } from '../scrub-the Hollow Tide.mjs';

test('multi-word before single-word', () => {
  assert.equal(scrubText('Wren Sparrow and Wren'), 'Wren Sparrow and Wren');
  assert.equal(scrubText('Marlow Halden'), 'Marlow Halden');
});

test('case preservation', () => {
  assert.equal(scrubText('Wren said to Marlow'), 'WREN said to marlow');
  assert.equal(scrubText('Wren said to Marlow'), 'Wren said to Marlow');
});

test('word boundaries — no mid-word hits', () => {
  assert.equal(scrubText('Fosters philosophiel'), 'Fosters philosophiel');
});

test('books', () => {
  assert.equal(scrubText('The Hollow Tide: The Drowning Bell'),
    'The Hollow Tide: The Drowning Bell');
});

test('kebab/slug forms', () => {
  assert.equal(scrubText("id: 'Wren-foster'"), "id: 'wren-sparrow'");
  assert.equal(scrubText('mock-book-The Drowning Bell'), 'mock-book-the-drowning-bell');
  assert.equal(scrubText("characterId: 'Marlow'"), "characterId: 'marlow'");
});

test('common words are LEFT ALONE (context-only, not codemod)', () => {
  assert.equal(scrubText('the legacy pairing format'), 'the legacy pairing format');
  assert.equal(scrubText('exile the chapter'), 'exile the chapter');
  assert.equal(scrubText('foster a connection'), 'foster a connection');
  assert.equal(scrubText('Unlocked the door'), 'Unlocked the door');
});

test('titled councillors/lords keep the rank, swap the surname', () => {
  assert.equal(scrubText('Dame Linnet and Councillor Brask'),
    'Dame Linnet and Councillor Brask');
  assert.equal(scrubText('Lord Vane'), 'Lord Vane');
});

test('manuscript path replaced before name patterns', () => {
  assert.equal(
    scrubText('C:\\Users\\dudar\\Downloads\\the Coalfall Commission.txt'),
    'server/src/__fixtures__/the-coalfall-commission.md');
  assert.equal(scrubText('the the Coalfall Commission regression'),
    'the the Coalfall Commission regression');
});

test('series acronym the Hollow Tide (all cases) → the Hollow Tide', () => {
  assert.equal(scrubText('across the Hollow Tide and the Hollow Tide and the Hollow Tide'),
    'across the Hollow Tide and the Hollow Tide and the Hollow Tide');
});

test('apostrophe target stays valid inside single-quoted strings', () => {
  assert.equal(scrubText("bookTitle: 'The Tidewatcher's Oath'"),
    "bookTitle: 'The Tidewatcher’s Oath'");
});

test('underscore-adjacent tokens are caught (slug compound)', () => {
  assert.equal(scrubText('mock__The Tidewatcher's Oath'), 'mock__the-tidewatchers-oath');
});

test('Capitalised prose word next to a hyphen keeps its case (not a slug)', () => {
  assert.equal(scrubText('Marlow-as-Lady-Renna said'), 'Marlow-as-Lady-Renna said');
  assert.equal(scrubText("id: 'Marlow-foo'"), "id: 'marlow-foo'");
});

test('Pell (the Hollow Tide Pell Marsh) maps to Pell — no collision with Marlow', () => {
  assert.equal(scrubText('Marlow and Pell'), 'Marlow and Pell');
  assert.equal(scrubText('Pell Marsh'), 'Pell Marsh');
});
