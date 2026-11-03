/* #3965 - the one book-scope predicate behind every notLinkedTo join gate. */
import { describe, it, expect } from 'vitest';
import { notLinkedToId } from './not-linked-to-scope.js';

const row = (notLinkedTo: unknown): Record<string, unknown> => ({ id: 'a', notLinkedTo });

describe('notLinkedToId', () => {
  it('blocks on a bare-string entry whatever the current book', () => {
    expect(notLinkedToId(row(['b']), 'b', 'book-2')).toBe(true);
    expect(notLinkedToId(row(['b']), 'b', undefined)).toBe(true);
  });

  it('blocks on a same-book object entry (reject-orphan writes these)', () => {
    expect(notLinkedToId(row([{ bookId: 'book-2', characterId: 'b' }]), 'b', 'book-2')).toBe(true);
  });

  it('ignores an object entry recorded in another book', () => {
    expect(notLinkedToId(row([{ bookId: 'book-1', characterId: 'b' }]), 'b', 'book-2')).toBe(false);
  });

  it('is bookId-blind when no current book is known (the fail-safe)', () => {
    expect(notLinkedToId(row([{ bookId: 'book-1', characterId: 'b' }]), 'b', undefined)).toBe(true);
  });

  it('still blocks on a legacy object entry that carries no string bookId', () => {
    // Without the typeof guard, `undefined !== currentBookId` would make this read as cross-book.
    expect(notLinkedToId(row([{ characterId: 'b' }]), 'b', 'book-2')).toBe(true);
    expect(notLinkedToId(row([{ bookId: 7, characterId: 'b' }]), 'b', 'book-2')).toBe(true);
  });

  it('does not block on an entry naming a different character, or on no list', () => {
    expect(notLinkedToId(row([{ bookId: 'book-2', characterId: 'c' }]), 'b', 'book-2')).toBe(false);
    expect(notLinkedToId({ id: 'a' }, 'b', 'book-2')).toBe(false);
  });
});
