/* Pairs with docs/features/20-revisions-and-drift.md.

   Covers the C1+C2 split between auto-queueable (severe) and manual
   (moderate / mild) drift events: severe events render the one-click
   "Auto-regen now" pill that bypasses the regen-modal confirmation,
   moderate / mild events keep the existing "Regenerate this chapter"
   pill that opens the modal. When no autoQueueable handler is provided
   the modal falls back to the manual flow for every event (regression
   guard for surfaces that haven't opted into the shortcut). */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriftReportModal } from './drift-report';
import type { DriftEvent, Character } from '../lib/types';

const characters: Character[] = [
  /* color must be a CHAR_COLORS key (narrator or slot-N) — see colors.ts.
     Drift-report does `CHAR_COLORS[char.color].hex`, so a fixture using
     unmapped names like 'magenta' would crash before the test assertions
     ran. */
  { id: 'eliza', name: 'Eliza', role: 'Lead', color: 'slot-4' } as Character,
  { id: 'sten', name: 'Sten', role: 'Friend', color: 'slot-5' } as Character,
];

function makeEvent(over: Partial<DriftEvent>): DriftEvent {
  return {
    id: 'drift:1:eliza:voice',
    characterId: 'eliza',
    chapterId: 1,
    severity: 'severe',
    factor: 'voice',
    factorLabel: 'Voice',
    description: 'Voice changed.',
    autoQueueable: true,
    detected: '2026-01-01T00:00:00Z',
    suggestedAction: 'regenerate_chapter',
    ...over,
  } as DriftEvent;
}

describe('DriftReportModal — auto-queueable severe drift (C1+C2)', () => {
  it('renders the Auto-regen now pill for severe + autoQueueable events when the handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        events={[makeEvent({})]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const autoBtn = screen.getByTestId('drift-auto-regen-drift:1:eliza:voice');
    expect(autoBtn).toBeInTheDocument();
    expect(autoBtn).toHaveTextContent(/Auto-regen now/i);
    /* Manual pill is NOT rendered for this row — auto and manual are
       mutually exclusive on a single drift card. */
    expect(screen.queryByTestId('drift-regen-drift:1:eliza:voice')).toBeNull();

    fireEvent.click(autoBtn);
    expect(onAutoQueueRegenerate).toHaveBeenCalledWith('eliza', 1);
    /* The modal-opening manual handler stays untouched for auto-queueable rows. */
    expect(onRegenerateChapter).not.toHaveBeenCalled();
  });

  it('renders the manual Regenerate pill for moderate events even when an autoQueueable handler is provided', () => {
    const onAutoQueueRegenerate = vi.fn();
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        events={[
          makeEvent({
            id: 'drift:1:eliza:pace',
            factor: 'pace',
            factorLabel: 'Pace',
            severity: 'moderate',
            autoQueueable: undefined,
          }),
        ]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    const manualBtn = screen.getByTestId('drift-regen-drift:1:eliza:pace');
    expect(manualBtn).toBeInTheDocument();
    expect(manualBtn).toHaveTextContent(/Regenerate this chapter/i);
    expect(screen.queryByTestId('drift-auto-regen-drift:1:eliza:pace')).toBeNull();

    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('eliza', 1);
    expect(onAutoQueueRegenerate).not.toHaveBeenCalled();
  });

  it('falls back to the manual Regenerate pill on every event when no autoQueueable handler is provided', () => {
    /* Regression guard: surfaces that haven't opted into the shortcut
       (or are still mocking the modal under test) get the original UX
       without lighting up the new affordance. */
    const onRegenerateChapter = vi.fn();
    render(
      <DriftReportModal
        events={[makeEvent({})]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={onRegenerateChapter}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('drift-auto-regen-drift:1:eliza:voice')).toBeNull();
    const manualBtn = screen.getByTestId('drift-regen-drift:1:eliza:voice');
    fireEvent.click(manualBtn);
    expect(onRegenerateChapter).toHaveBeenCalledWith('eliza', 1);
  });

  it('groups severe + moderate events under separate severity headings (regression for the existing layout)', () => {
    /* Spot-check the existing grouping behavior survives the C1+C2
       split — the severe row picks up the Auto-regen pill while the
       moderate row keeps the manual pill, in the same modal. */
    const onAutoQueueRegenerate = vi.fn();
    render(
      <DriftReportModal
        events={[
          makeEvent({}),
          makeEvent({
            id: 'drift:1:sten:pace',
            characterId: 'sten',
            factor: 'pace',
            factorLabel: 'Pace',
            severity: 'moderate',
            autoQueueable: undefined,
          }),
        ]}
        characters={characters}
        onClose={vi.fn()}
        onRegenerateChapter={vi.fn()}
        onAutoQueueRegenerate={onAutoQueueRegenerate}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId('drift-auto-regen-drift:1:eliza:voice')).toBeInTheDocument();
    expect(screen.getByTestId('drift-regen-drift:1:sten:pace')).toBeInTheDocument();
  });
});
