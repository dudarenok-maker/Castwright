// Pairs with docs/features/04-analysing-view-progress.md

import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { AnalysingView } from './analysing';
import type { AnalyseOpts, AnalysisLiveInfo } from '../lib/api';
import type { AnalyseResponse } from '../lib/types';

/* Captured handlers so tests can drive phase/log events at will. */
let capturedOpts: AnalyseOpts | undefined;

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      /* Never-resolving so the view stays mounted in its "streaming" state
         for the duration of the test. */
      analyseManuscript: (_id: string, opts?: AnalyseOpts) => {
        capturedOpts = opts;
        return new Promise<AnalyseResponse>(() => {});
      },
    },
  };
});

function renderView() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  return render(
    <Provider store={store}>
      <AnalysingView
        manuscriptId="m1"
        title="the Coalfall Commission"
        wordCount={2440}
        onComplete={() => {}}
      />
    </Provider>,
  );
}

describe('AnalysingView — live ticker (regression for stuck-chapter screenshot bug)', () => {
  it('renders one row per in-flight chapter so a slow chapter does not hide concurrent progress', () => {
    renderView();

    const live: AnalysisLiveInfo = {
      totalChapters: 7,
      chapters: [
        { chapterIndex: 2, chapterTitle: 'DAY ONE',   elapsedMs: 4 * 60_000 + 15_000, estMs: 21_000  },
        { chapterIndex: 7, chapterTitle: 'DAY SIX',   elapsedMs: 8_000,               estMs: 123_000 },
      ],
    };

    act(() => {
      capturedOpts?.onPhase?.({ phaseId: 1, progress: 0.56, live });
    });

    /* Both chapters render — the screenshot bug was that only "Chapter 2/7"
       (the oldest in-flight) was visible while chapters 6 & 7 ran behind it. */
    expect(screen.getByText('Chapter 2/7')).toBeInTheDocument();
    expect(screen.getByText('Chapter 7/7')).toBeInTheDocument();
    expect(screen.getByText('DAY ONE')).toBeInTheDocument();
    expect(screen.getByText('DAY SIX')).toBeInTheDocument();

    /* The chapter that's run far past its estimate is flagged "over budget";
       the freshly-started one is not. */
    const overBudget = screen.getAllByText('over budget');
    expect(overBudget).toHaveLength(1);
  });

  it('hides the ticker entirely when no chapters are in flight (between completion and next start)', () => {
    renderView();

    act(() => {
      capturedOpts?.onPhase?.({
        phaseId: 1,
        progress: 0.4,
        live: { totalChapters: 7, chapters: [] },
      });
    });

    expect(screen.queryByText(/Chapter \d+\/7/)).not.toBeInTheDocument();
  });
});
