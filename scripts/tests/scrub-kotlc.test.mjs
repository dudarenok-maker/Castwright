import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText } from '../scrub-kotlc.mjs';

test('multi-word before single-word', () => {
  assert.equal(scrubText('Sophie Foster and Sophie'), 'Wren Sparrow and Wren');
  assert.equal(scrubText('Keefe Sencen'), 'Tam Hollis');
});

test('case preservation', () => {
  assert.equal(scrubText('SOPHIE said to keefe'), 'WREN said to tam');
  assert.equal(scrubText('Sophie said to Keefe'), 'Wren said to Tam');
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
  assert.equal(scrubText("characterId: 'keefe'"), "characterId: 'tam'");
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
