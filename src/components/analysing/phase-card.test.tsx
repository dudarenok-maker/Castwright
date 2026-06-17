// Pairs with docs/features/archive/04-analysing-view-progress.md

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { accountSlice } from '../../store/account-slice';
import { castSlice } from '../../store/cast-slice';
import type { AnalysisPhase } from '../../lib/types';
import type { AnalysisLiveChapter } from '../../lib/api';
import type React from 'react';
import { PhaseCard } from './phase-card';

function mountStore() {
  return configureStore({
    reducer: { account: accountSlice.reducer, cast: castSlice.reducer },
  });
}

function renderPhase(phase: AnalysisPhase) {
  const store = mountStore();
  return render(
    <Provider store={store}>
      <PhaseCard
        phase={phase}
        activePhaseId={phase.id}
        phaseProgress={0.5}
        phaseLogs={[]}
        live={null}
        isLocalAnalyzer={false}
        analysisStarted={true}
        conn="streaming"
        bookId={null}
        droppedQuotesRefreshKey={0}
      />
    </Provider>,
  );
}

const activePhase: AnalysisPhase = {
  id: 0,
  label: 'Detecting characters',
  detail: 'Named-entity extraction, dialogue attribution, speaker resolution.',
  duration: 1000,
};

describe('LiveChapterRow — section sub-bar', () => {
  /* When a chapter has sectionsTotal > 1 the row must show "section M/N"
     and a thin sub-bar; single-section (or absent) chapters must stay clean. */
  it('shows "section M/N" text when sectionsTotal > 1', () => {
    const store = mountStore();
    render(
      <Provider store={store}>
        <PhaseCard
          phase={activePhase}
          activePhaseId={activePhase.id}
          phaseProgress={0.5}
          phaseLogs={[]}
          live={{
            totalChapters: 10,
            chapters: [
              {
                chapterIndex: 2,
                chapterTitle: 'Chapter 2',
                elapsedMs: 3000,
                estMs: 8000,
                sectionsDone: 3,
                sectionsTotal: 4,
              },
            ],
          }}
          isLocalAnalyzer={false}
          analysisStarted={true}
          conn="streaming"
          bookId={null}
          droppedQuotesRefreshKey={0}
        />
      </Provider>,
    );
    expect(screen.getByText(/section 3\/4/i)).toBeInTheDocument();
  });

  it('renders no "section" text when sectionsTotal is 1', () => {
    const store = mountStore();
    render(
      <Provider store={store}>
        <PhaseCard
          phase={activePhase}
          activePhaseId={activePhase.id}
          phaseProgress={0.5}
          phaseLogs={[]}
          live={{
            totalChapters: 10,
            chapters: [
              {
                chapterIndex: 2,
                chapterTitle: 'Chapter 2',
                elapsedMs: 3000,
                estMs: 8000,
                sectionsDone: 1,
                sectionsTotal: 1,
              },
            ],
          }}
          isLocalAnalyzer={false}
          analysisStarted={true}
          conn="streaming"
          bookId={null}
          droppedQuotesRefreshKey={0}
        />
      </Provider>,
    );
    expect(screen.queryByText(/section/i)).toBeNull();
  });

  it('renders no "section" text when sectionsTotal is absent', () => {
    const store = mountStore();
    render(
      <Provider store={store}>
        <PhaseCard
          phase={activePhase}
          activePhaseId={activePhase.id}
          phaseProgress={0.5}
          phaseLogs={[]}
          live={{
            totalChapters: 10,
            chapters: [
              {
                chapterIndex: 2,
                chapterTitle: 'Chapter 2',
                elapsedMs: 3000,
                estMs: 8000,
              },
            ],
          }}
          isLocalAnalyzer={false}
          analysisStarted={true}
          conn="streaming"
          bookId={null}
          droppedQuotesRefreshKey={0}
        />
      </Provider>,
    );
    expect(screen.queryByText(/section/i)).toBeNull();
  });
});

const phase1: AnalysisPhase = {
  id: 1,
  label: 'Parsing and attribution',
  detail: 'Splitting chapters into sentences and labelling each speaker.',
  duration: 1000,
};

function liveChapter(over: Partial<AnalysisLiveChapter> = {}): AnalysisLiveChapter {
  return { chapterIndex: 1, chapterTitle: 'Chapter 1', elapsedMs: 5000, estMs: 60000, ...over };
}

// Wraps PhaseCard in a real store so useAppSelector resolves. mountStore() is
// the helper already defined in this file (account + cast reducers).
function renderCard(props: Partial<React.ComponentProps<typeof PhaseCard>>) {
  return render(
    <Provider store={mountStore()}>
      <PhaseCard
        phase={phase1}
        activePhaseId={1}
        phaseProgress={0.4}
        phaseLogs={['x']}
        live={null}
        isLocalAnalyzer
        analysisStarted
        conn="streaming"
        bookId={null}
        droppedQuotesRefreshKey={0}
        {...props}
      />
    </Provider>,
  );
}

describe('LiveChapterRow sentence headline', () => {
  it('shows "Attributed ~N of ~M sentences" in sentence mode', () => {
    renderCard({
      live: { totalChapters: 9, chapters: [liveChapter({ sentencesDone: 247, sentencesTotal: 900, inSentenceMode: true })] },
    });
    expect(screen.getByText(/Attributed ~247 of ~900 sentences/)).toBeInTheDocument();
  });

  it('omits the sentence headline before sentence mode', () => {
    renderCard({ live: { totalChapters: 9, chapters: [liveChapter()] } });
    expect(screen.queryByText(/Attributed/)).not.toBeInTheDocument();
  });

  it('keeps the chars/s speed pulse in the heartbeat row', () => {
    renderCard({
      live: { totalChapters: 9, chapters: [liveChapter({ sentencesDone: 10, sentencesTotal: 900, inSentenceMode: true })] },
      heartbeat: { hb: { phaseId: 1, receivedBytes: 2048, charsPerSec: 145, elapsedMs: 14000, sinceLastChunkMs: 0, chapterIndex: 1 }, receivedAt: Date.now() },
    });
    expect(screen.getByText(/145 chars\/s/)).toBeInTheDocument();
  });
});

describe('PhaseCard layout', () => {
  /* The detail copy must span the full card width rather than the narrow
     column beneath the label. The model chip + swap dropdown share the
     label's flex row (`justify-between`); if the detail stays in that row it
     wraps into a cramped two- or three-line block — the bug this locks. */
  it('renders the detail outside the label/model-controls row so it spans full width', () => {
    const phase: AnalysisPhase = {
      id: 0,
      label: 'Detecting characters',
      detail: 'Named-entity extraction, dialogue attribution, speaker resolution.',
      duration: 1000,
    };
    renderPhase(phase);

    const label = screen.getByText(phase.label);
    const detail = screen.getByText(phase.detail);
    // The chip anchors the flex row that pairs the label with the model controls.
    const chip = screen.getByTestId('phase-model-chip-0');
    const controlsRow = chip.closest('[class*="justify-between"]');
    expect(controlsRow).not.toBeNull();

    // Label shares the row with the controls; detail does not.
    expect(controlsRow!.contains(label)).toBe(true);
    expect(controlsRow!.contains(detail)).toBe(false);
  });

  /* The active-phase streaming log scrolls. Without the shared `.scrollbar-thin`
     utility it falls back to the default OS scrollbar, which reads as a bright
     grey bar against the card. It must use the same treatment as the admin
     throughput table: a rounded, bordered, overflow-hidden wrapper with the
     scroller inside, opting into the themed thin inset scrollbar — with the
     clip radius pinned to the rounded-2xl (16px) wrapper so the thumb hugs the
     curve instead of bleeding past it. */
  it('mounts the active-phase log scroll region like the admin table (thin inset scrollbar)', () => {
    const phase: AnalysisPhase = {
      id: 1,
      label: 'Parsing and attribution',
      detail: 'Splitting chapters into sentences and labelling each with its speaker.',
      duration: 1000,
    };
    const store = mountStore();
    render(
      <Provider store={store}>
        <PhaseCard
          phase={phase}
          activePhaseId={phase.id}
          phaseProgress={0.5}
          phaseLogs={['Chapter 13/40 done — 631 sentences in 2m 31s']}
          live={null}
          isLocalAnalyzer={false}
          analysisStarted={true}
          conn="streaming"
          bookId={null}
          droppedQuotesRefreshKey={0}
        />
      </Provider>,
    );

    const line = screen.getByText(/631 sentences/);
    const scroller = line.closest('[class*="overflow-y-auto"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    // Same shared utility as Listen / Account / admin — not the default OS bar.
    expect(scroller!.className).toMatch(/scrollbar-thin/);
    // Clip radius matches the rounded-2xl wrapper so the thumb hugs the curve.
    expect(scroller!.style.getPropertyValue('--scrollbar-thin-radius')).toBe('16px');
    // Mounted inside a rounded, bordered, overflow-hidden wrapper (admin idiom).
    const wrapper = scroller!.parentElement as HTMLElement;
    expect(wrapper.className).toMatch(/rounded-2xl/);
    expect(wrapper.className).toMatch(/border/);
    expect(wrapper.className).toMatch(/overflow-hidden/);
  });
});
