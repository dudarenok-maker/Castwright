// Pairs with docs/features/archive/74-manuscript-diff-on-reupload.md

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManuscriptDiffModal } from './manuscript-diff';
import { diffManuscripts } from '../lib/manuscript-diff';

describe('ManuscriptDiffModal — render', () => {
  it('renders nothing when `open` is false (no backdrop, no dialog)', () => {
    render(
      <ManuscriptDiffModal
        open={false}
        bookTitle="Solway Bay"
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.queryByTestId('manuscript-diff-modal')).toBeNull();
    expect(screen.queryByTestId('diff-backdrop')).toBeNull();
  });

  it('renders the modal with title and counts when `open` is true', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle="Solway Bay"
        diff={diffManuscripts('A. Old. C.', 'A. New. C.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByTestId('manuscript-diff-modal')).toBeInTheDocument();
    expect(screen.getByTestId('diff-title').textContent).toMatch(/Solway Bay/);
    /* 1 replace = 1 changed; no inserts / deletes. */
    expect(screen.getByTestId('diff-counts').textContent).toMatch(/1.*changed/);
    expect(screen.getByTestId('diff-counts').textContent).toMatch(/0.*added/);
    expect(screen.getByTestId('diff-counts').textContent).toMatch(/0.*removed/);
  });

  it('renders an empty-state hint when the diff has no entries', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle="Solway Bay"
        diff={[]}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByTestId('diff-empty').textContent).toMatch(/matches the existing book/i);
  });

  it('falls back to a generic header when bookTitle is null', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle={null}
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(screen.getByTestId('diff-title').textContent).toMatch(/Re-uploading manuscript/);
    expect(screen.getByTestId('diff-title').textContent).not.toMatch(/"/);
  });
});

describe('ManuscriptDiffModal — diff row rendering', () => {
  it('renders an insert row with the new sentence highlighted (peach)', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A. C.', 'A. B. C.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    const inserts = screen.getAllByTestId('diff-row-insert');
    expect(inserts).toHaveLength(1);
    /* The inserted text "B." appears under a <mark> in the new column. */
    expect(inserts[0].querySelector('mark')?.textContent).toMatch(/B\./);
  });

  it('renders a delete row with the removed sentence struck-through (magenta)', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A. B. C.', 'A. C.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    const deletes = screen.getAllByTestId('diff-row-delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].querySelector('del')?.textContent).toMatch(/B\./);
  });

  it('renders a replace row with charDiff highlights inside the sentence', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('The quick brown fox.', 'The slow brown fox.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    const replaces = screen.getAllByTestId('diff-row-replace');
    expect(replaces).toHaveLength(1);
    /* OLD column has a <del> for "quick"; NEW column has a <mark> for "slow". */
    const oldCol = screen.getByTestId('diff-row-replace-old');
    const newCol = screen.getByTestId('diff-row-replace-new');
    expect(oldCol.querySelector('del')?.textContent).toMatch(/quick/);
    expect(newCol.querySelector('mark')?.textContent).toMatch(/slow/);
    /* Shared "brown fox." appears in BOTH columns as plain spans (no del / mark). */
    expect(oldCol.textContent).toMatch(/brown fox/);
    expect(newCol.textContent).toMatch(/brown fox/);
  });

  it('renders equal rows for unchanged sentences (no highlights)', () => {
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A. B. C.', 'A. X. C.')}
        onApply={() => {}}
        onDiscard={() => {}}
      />,
    );
    const equals = screen.getAllByTestId('diff-row-equal');
    expect(equals).toHaveLength(2); /* A. and C. unchanged */
  });
});

describe('ManuscriptDiffModal — callbacks', () => {
  it('fires onApply when the Apply button is clicked', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={onApply}
        onDiscard={() => {}}
      />,
    );
    await user.click(screen.getByTestId('diff-apply'));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('fires onDiscard when the Discard button is clicked', async () => {
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={onDiscard}
      />,
    );
    await user.click(screen.getByTestId('diff-discard'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('fires onDiscard when the backdrop is clicked', async () => {
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={onDiscard}
      />,
    );
    await user.click(screen.getByTestId('diff-backdrop'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('fires onDiscard when the X close button is clicked', async () => {
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={onDiscard}
      />,
    );
    await user.click(screen.getByTestId('diff-close'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});

describe('ManuscriptDiffModal — keyboard shortcuts', () => {
  it('fires onDiscard on Escape', () => {
    const onDiscard = vi.fn();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('fires onApply on Ctrl+Enter', () => {
    const onApply = vi.fn();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={onApply}
        onDiscard={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('fires onApply on Cmd+Enter (macOS)', () => {
    const onApply = vi.fn();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={onApply}
        onDiscard={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('does NOT fire onApply on plain Enter (without modifier)', () => {
    const onApply = vi.fn();
    render(
      <ManuscriptDiffModal
        open
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={onApply}
        onDiscard={() => {}}
      />,
    );
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('does NOT bind shortcuts when `open` is false', () => {
    const onDiscard = vi.fn();
    render(
      <ManuscriptDiffModal
        open={false}
        bookTitle="t"
        diff={diffManuscripts('A.', 'B.')}
        onApply={() => {}}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDiscard).not.toHaveBeenCalled();
  });
});
