/* Menu wiring regression: the "Change log" button in the global nav must
   dispatch onOpenChangelog so it actually surfaces the workspace activity
   feed. Pairs with src/lib/router.test.ts (which only covers stage↔hash
   conversion, not the click path). */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TopBar } from './top-bar';

function makeProps(overrides: Partial<Parameters<typeof TopBar>[0]> = {}): Parameters<typeof TopBar>[0] {
  return {
    stage: 'books',
    view: null,
    setView: vi.fn(),
    onHome: vi.fn(),
    pendingRevisionsCount: 0,
    onOpenRevisions: vi.fn(),
    onOpenVoices: vi.fn(),
    onOpenChangelog: vi.fn(),
    ...overrides,
  };
}

describe('TopBar — global nav', () => {
  it('renders the Change log button when no book is open', () => {
    render(<TopBar {...makeProps({ stage: 'books' })}/>);
    expect(screen.getByRole('button', { name: 'Change log' })).toBeInTheDocument();
  });

  it('fires onOpenChangelog when the Change log button is clicked from the Books page', () => {
    const onOpenChangelog = vi.fn();
    render(<TopBar {...makeProps({ stage: 'books', onOpenChangelog })}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
  });

  it('fires onOpenChangelog from the Voices page too — the nav stays consistent across global stages', () => {
    const onOpenChangelog = vi.fn();
    render(<TopBar {...makeProps({ stage: 'voices', onOpenChangelog })}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Change log' }));
    expect(onOpenChangelog).toHaveBeenCalledTimes(1);
  });

  it('hides the global nav when a book is open (in-book tabs render instead)', () => {
    render(<TopBar {...makeProps({ stage: 'ready', view: 'cast' })}/>);
    expect(screen.queryByRole('button', { name: 'Change log' })).not.toBeInTheDocument();
    /* The per-book log tab is the lowercase "Log" instead. */
    expect(screen.getByRole('button', { name: 'Log' })).toBeInTheDocument();
  });
});
