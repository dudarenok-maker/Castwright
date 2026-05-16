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
    onOpenAccount: vi.fn(),
    userDisplayName: 'Mike Dudarenok',
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

describe('TopBar — avatar entry to account', () => {
  it('renders the avatar as a button labelled with the display name', () => {
    render(<TopBar {...makeProps({ userDisplayName: 'Captain Picard' })}/>);
    expect(screen.getByRole('button', { name: /account.*captain picard/i })).toBeInTheDocument();
  });

  it('fires onOpenAccount when the avatar is clicked', () => {
    const onOpenAccount = vi.fn();
    render(<TopBar {...makeProps({ onOpenAccount })}/>);
    fireEvent.click(screen.getByRole('button', { name: /account.*mike dudarenok/i }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it('falls back to an "unnamed user" label when displayName is empty', () => {
    render(<TopBar {...makeProps({ userDisplayName: '' })}/>);
    expect(screen.getByRole('button', { name: /account.*unnamed user/i })).toBeInTheDocument();
  });
});

describe('TopBar — AnalysisPill (B3 sticky analysis)', () => {
  it('hides the pill entirely when analysisPill is null (no in-flight analysis)', () => {
    render(<TopBar {...makeProps({ analysisPill: null })}/>);
    expect(screen.queryByTestId('analysis-pill')).not.toBeInTheDocument();
  });

  it('renders the running variant with the phase label and percent', () => {
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 42,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Analysing');
    expect(pill.textContent).toContain('Detecting characters');
    expect(pill.textContent).toContain('42%');
  });

  it('renders the halted variant with the trimmed halt reason and a full-message title attribute', () => {
    const longReason = 'Phase 1 demoted 60% of sentences to narrator — model attribution unreliable.';
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'halted',
        phaseLabel: 'Parsing and attribution',
        percent: 0,
        haltReason: longReason,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Halted');
    /* Trimmed to 32 chars + ellipsis on render so a long halt message
       doesn't blow out the header layout. */
    expect(pill.textContent).toContain('…');
    /* Full message is preserved on the title attribute for hover. */
    expect(pill).toHaveAttribute('title', longReason);
  });

  it('renders the paused variant without a percent (paused work doesn\'t tick)', () => {
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'paused',
        phaseLabel: 'Detecting characters',
        percent: 30,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Paused');
    expect(pill.textContent).not.toContain('30%');
  });

  it('fires onClick when the pill is clicked (routes back to the analysing view)', () => {
    const onClick = vi.fn();
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 10,
        onClick,
      },
    })}/>);
    fireEvent.click(screen.getByTestId('analysis-pill'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders alongside the generation pill — both can be visible during a cross-book analysis + generation', () => {
    /* Sticky analysis (B1-3) + sticky generation (plan 31) can both be
       alive at the same time on different books. The header must show
       BOTH pills, not one or the other. */
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 20,
        onClick: vi.fn(),
      },
      generationPill: {
        state: 'running',
        done: 3, total: 10, percent: 30,
        onClick: vi.fn(),
      },
    })}/>);
    expect(screen.getByTestId('analysis-pill')).toBeInTheDocument();
    /* GenerationPill has no testid, identify by its visible text. */
    expect(screen.getByText(/Generating/)).toBeInTheDocument();
  });
});

describe('TopBar — AnalysisPill subset variant (plan 32 D2)', () => {
  it('renders the running variant as "Retrying N chapters · 42%" when kind === subset', () => {
    /* Plan 32 D2: subset retries swap the headline label from
       "Analysing" to "Retrying" and surface the chapter count in
       place of the per-phase label. The percent still tracks the
       phase-weighted overall progress so the user sees the retry
       advance. */
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 42,
        kind: 'subset',
        subsetChapterCount: 3,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill).toHaveAttribute('data-pill-kind', 'subset');
    expect(pill.textContent).toContain('Retrying');
    expect(pill.textContent).toContain('3 chapters');
    expect(pill.textContent).toContain('42%');
    /* The phase-label fallback must NOT render in subset mode — the
       chapter-count copy is the more useful signal. */
    expect(pill.textContent).not.toContain('Detecting characters');
  });

  it('singularises the chapter count for a one-chapter retry', () => {
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 12,
        kind: 'subset',
        subsetChapterCount: 1,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('1 chapter');
    expect(pill.textContent).not.toContain('1 chapters');
  });

  it('falls back to the phase label when kind === subset but subsetChapterCount is missing', () => {
    /* Defensive default — if a cold-boot snapshot omits the chapter ids
       (legacy file, or an in-flight glitch where the count's not on the
       snapshot yet), the pill still renders rather than NaN-ing out. */
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 5,
        kind: 'subset',
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Retrying');
    expect(pill.textContent).toContain('Detecting characters');
  });

  it('renders the main variant ("Analysing") when kind is undefined or "main"', () => {
    /* Regression guard — a pill with no `kind` field on the data (e.g.
       from a pre-D2 snapshot) must keep the main rendering. The
       data-pill-kind attribute also defaults to "main" so tests can
       target either kind explicitly. */
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'running',
        phaseLabel: 'Detecting characters',
        percent: 30,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill).toHaveAttribute('data-pill-kind', 'main');
    expect(pill.textContent).toContain('Analysing');
    expect(pill.textContent).toContain('Detecting characters');
  });

  it('subset paused / halted variants keep the standard terminal copy (not the retrying label)', () => {
    render(<TopBar {...makeProps({
      analysisPill: {
        state: 'paused',
        phaseLabel: 'Detecting characters',
        percent: 0,
        kind: 'subset',
        subsetChapterCount: 2,
        onClick: vi.fn(),
      },
    })}/>);
    const pill = screen.getByTestId('analysis-pill');
    expect(pill.textContent).toContain('Paused');
    /* Paused subset jobs still surface as "Paused · <phase>" so the
       Resume affordance reads the same as a paused main run. */
    expect(pill.textContent).not.toContain('Retrying');
  });
});
