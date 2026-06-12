/* ChangeLogView — verifies that the category filter actually narrows the
   per-day sections (user reported the Voice/Cast buttons weren't filtering)
   and that each daily section is capped to a scrollable viewport so a
   runaway "Today" bucket on a long generate run doesn't push the rest of
   the activity feed off-screen. */

import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { ChangeLogView } from './change-log';
import type { ChangeLogEvent } from '../lib/types';

/* jsdom has no IntersectionObserver. The view's infinite-scroll sentinel
   constructs one inside a useEffect, so without a stub here every test
   that mounts ChangeLogView with onLoadMore would crash with a
   ReferenceError. The stub is a no-op observer — tests don't need to
   simulate intersection callbacks; the sentinel-render assertions key off
   the data-testid alone. */
class StubIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  root: Element | null = null;
  rootMargin = '';
  thresholds: number[] = [];
}

let originalIO: typeof IntersectionObserver | undefined;
beforeAll(() => {
  originalIO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  (globalThis as { IntersectionObserver: unknown }).IntersectionObserver = StubIntersectionObserver;
});
afterAll(() => {
  if (originalIO === undefined) {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  } else {
    (globalThis as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
      originalIO;
  }
});

function makeEvent(
  overrides: Partial<ChangeLogEvent> & Pick<ChangeLogEvent, 'id' | 'type'>,
): ChangeLogEvent {
  return {
    ts: 'Just now',
    date: 'today',
    title: `event ${overrides.id}`,
    note: `note ${overrides.id}`,
    actor: 'you',
    ...overrides,
  };
}

/* Titles are deliberately distinct from the LOG_TYPES labels ("Voice tuned",
   "Analysis complete", "Generation started", "Boundary moved" etc.) — the
   row renders the label as a tag next to the title, so re-using a label as
   a title would yield duplicate text matches and bust the assertions. */
const sampleEvents: ChangeLogEvent[] = [
  makeEvent({ id: 1, type: 'voice_tune', title: 'Tuned Eliza' }),
  makeEvent({ id: 2, type: 'voice_lock', title: 'Locked Halloran' }),
  makeEvent({ id: 3, type: 'library_add', title: 'Added narrator to library' }),
  makeEvent({ id: 4, type: 'cast_confirm', title: 'Confirmed the cast roster' }),
  makeEvent({ id: 5, type: 'analysis_complete', title: 'Analysis run finished' }),
  makeEvent({ id: 6, type: 'regenerate', title: 'Regenerated CH 3', chapterId: 3 }),
  makeEvent({ id: 7, type: 'chapter_complete', title: 'Chapter 1 complete', chapterId: 1 }),
  makeEvent({ id: 8, type: 'chapter_complete', title: 'Chapter 2 complete', chapterId: 2 }),
  makeEvent({ id: 9, type: 'generation_started', title: 'Started a generate run' }),
  makeEvent({
    id: 10,
    type: 'boundary_move',
    title: 'Moved a speaker boundary',
    chapterId: 4,
    date: 'yesterday',
  }),
  makeEvent({ id: 11, type: 'import', title: 'Manuscript uploaded', date: 'yesterday' }),
];

describe('ChangeLogView filter', () => {
  it('shows all events when filter is All', () => {
    render(<ChangeLogView events={sampleEvents} />);
    /* Every event title should be present in the document. */
    for (const e of sampleEvents) expect(screen.getByText(e.title)).toBeInTheDocument();
  });

  it('Voice filter narrows the visible rows to voice/library events only', () => {
    render(<ChangeLogView events={sampleEvents} />);
    fireEvent.click(screen.getByRole('button', { name: /^Voice/ }));

    /* Voice category events survive. */
    expect(screen.getByText('Tuned Eliza')).toBeInTheDocument();
    expect(screen.getByText('Locked Halloran')).toBeInTheDocument();
    expect(screen.getByText('Added narrator to library')).toBeInTheDocument();

    /* Non-voice events are filtered out. */
    expect(screen.queryByText('Confirmed the cast roster')).not.toBeInTheDocument();
    expect(screen.queryByText('Analysis run finished')).not.toBeInTheDocument();
    expect(screen.queryByText('Regenerated CH 3')).not.toBeInTheDocument();
    expect(screen.queryByText('Chapter 1 complete')).not.toBeInTheDocument();
    expect(screen.queryByText('Moved a speaker boundary')).not.toBeInTheDocument();
    expect(screen.queryByText('Manuscript uploaded')).not.toBeInTheDocument();
  });

  it('Cast filter narrows the visible rows to cast/analysis events only', () => {
    render(<ChangeLogView events={sampleEvents} />);
    fireEvent.click(screen.getByRole('button', { name: /^Cast/ }));

    expect(screen.getByText('Confirmed the cast roster')).toBeInTheDocument();
    expect(screen.getByText('Analysis run finished')).toBeInTheDocument();

    expect(screen.queryByText('Tuned Eliza')).not.toBeInTheDocument();
    expect(screen.queryByText('Locked Halloran')).not.toBeInTheDocument();
    expect(screen.queryByText('Regenerated CH 3')).not.toBeInTheDocument();
    expect(screen.queryByText('Chapter 1 complete')).not.toBeInTheDocument();
    expect(screen.queryByText('Moved a speaker boundary')).not.toBeInTheDocument();
  });

  it('Cast filter includes a name_change (rename / alias-promote) event', () => {
    /* Dedicated event set so the shared sampleEvents counts stay stable. */
    const events: ChangeLogEvent[] = [
      makeEvent({ id: 1, type: 'name_change', title: 'Renamed Dame Linnet' }),
      makeEvent({ id: 2, type: 'voice_tune', title: 'Tuned Eliza' }),
    ];
    render(<ChangeLogView events={events} />);
    fireEvent.click(screen.getByRole('button', { name: /^Cast/ }));
    expect(screen.getByText('Renamed Dame Linnet')).toBeInTheDocument();
    expect(screen.queryByText('Tuned Eliza')).not.toBeInTheDocument();
  });

  it('Generation filter keeps regenerates + chapter lifecycle events', () => {
    render(<ChangeLogView events={sampleEvents} />);
    fireEvent.click(screen.getByRole('button', { name: /^Generation/ }));

    expect(screen.getByText('Regenerated CH 3')).toBeInTheDocument();
    expect(screen.getByText('Chapter 1 complete')).toBeInTheDocument();
    expect(screen.getByText('Chapter 2 complete')).toBeInTheDocument();
    expect(screen.getByText('Started a generate run')).toBeInTheDocument();

    expect(screen.queryByText('Tuned Eliza')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmed the cast roster')).not.toBeInTheDocument();
  });

  it('Manuscript filter keeps boundary + import + reparse events', () => {
    render(<ChangeLogView events={sampleEvents} />);
    fireEvent.click(screen.getByRole('button', { name: /^Manuscript/ }));

    expect(screen.getByText('Moved a speaker boundary')).toBeInTheDocument();
    expect(screen.getByText('Manuscript uploaded')).toBeInTheDocument();

    expect(screen.queryByText('Tuned Eliza')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirmed the cast roster')).not.toBeInTheDocument();
    expect(screen.queryByText('Chapter 1 complete')).not.toBeInTheDocument();
  });

  it('shows a category-named empty-state card when a filter has no matches', () => {
    const onlyVoice: ChangeLogEvent[] = [
      makeEvent({ id: 1, type: 'voice_tune', title: 'Tuned only' }),
    ];
    render(<ChangeLogView events={onlyVoice} />);
    fireEvent.click(screen.getByRole('button', { name: /^Cast/ }));
    expect(screen.getByRole('heading', { name: 'No cast events yet' })).toBeInTheDocument();
    /* Empty state offers a path back to All so a confused user isn't stuck
       on the empty bucket. */
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });

  it('shows the onboarding empty-state when no events have been logged at all', () => {
    render(<ChangeLogView events={[]} />);
    expect(screen.getByRole('heading', { name: 'No activity yet' })).toBeInTheDocument();
    /* All filter buttons render with a 0 count and the muted style. */
    expect(screen.getByRole('button', { name: 'All (0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Voice (0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cast (0)' })).toBeInTheDocument();
  });

  it('drops the entire Today bucket when its events do not match the active filter', () => {
    /* Reproduces the symptom the user reported: a Today bucket full of
       generation events (chapter_complete, regenerate, generation_started)
       and a Yesterday bucket of cast events. Clicking Cast must drop the
       Today heading entirely — not leave it stuck rendering all the
       generation rows. */
    const events: ChangeLogEvent[] = [
      makeEvent({
        id: 1,
        type: 'chapter_complete',
        title: 'Chapter 1 done',
        chapterId: 1,
        date: 'today',
      }),
      makeEvent({
        id: 2,
        type: 'chapter_complete',
        title: 'Chapter 2 done',
        chapterId: 2,
        date: 'today',
      }),
      makeEvent({ id: 3, type: 'regenerate', title: 'Regen CH 3', chapterId: 3, date: 'today' }),
      makeEvent({ id: 4, type: 'cast_confirm', title: 'Cast was confirmed', date: 'yesterday' }),
    ];
    render(<ChangeLogView events={events} />);
    /* Pre-click: all four events visible, Today heading present. */
    expect(screen.getByRole('heading', { name: 'Today' })).toBeInTheDocument();
    expect(screen.getByText('Chapter 1 done')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Cast/ }));
    /* Post-click: Today is gone, generation rows gone, only Cast row + Yesterday left. */
    expect(screen.queryByRole('heading', { name: 'Today' })).not.toBeInTheDocument();
    expect(screen.queryByText('Chapter 1 done')).not.toBeInTheDocument();
    expect(screen.queryByText('Chapter 2 done')).not.toBeInTheDocument();
    expect(screen.queryByText('Regen CH 3')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeInTheDocument();
    expect(screen.getByText('Cast was confirmed')).toBeInTheDocument();
  });

  it('renders per-category counts in filter button labels', () => {
    render(<ChangeLogView events={sampleEvents} />);
    /* 3 voice events (voice_tune + voice_lock + library_add). */
    expect(screen.getByRole('button', { name: 'Voice (3)' })).toBeInTheDocument();
    /* 2 cast events (cast_confirm + analysis_complete). */
    expect(screen.getByRole('button', { name: 'Cast (2)' })).toBeInTheDocument();
    /* 4 generation events (regenerate + 2 chapter_complete + generation_started). */
    expect(screen.getByRole('button', { name: 'Generation (4)' })).toBeInTheDocument();
    /* 2 manuscript events (boundary_move + import). */
    expect(screen.getByRole('button', { name: 'Manuscript (2)' })).toBeInTheDocument();
    /* All count tracks the full event set. */
    expect(
      screen.getByRole('button', { name: `All (${sampleEvents.length})` }),
    ).toBeInTheDocument();
  });

  it('uses server-side totalCount + categoryCounts when provided (workspace pagination case)', () => {
    /* When only one page of a 200-event workspace log is loaded, the pills
       must surface the SERVER totals — not the per-page loaded subset —
       otherwise the user sees "All (50)" on a 200-event workspace and the
       count looks invented. */
    render(
      <ChangeLogView
        events={sampleEvents}
        totalCount={199}
        categoryCounts={{ voice: 8, generation: 175, manuscript: 12, cast: 4 }}
      />,
    );
    expect(screen.getByRole('button', { name: 'All (199)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Voice (8)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generation (175)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manuscript (12)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cast (4)' })).toBeInTheDocument();
  });
});

describe('ChangeLogView removed-affordance regression', () => {
  it('does not render an Export log button — capability was never wired', () => {
    render(<ChangeLogView events={sampleEvents} />);
    expect(screen.queryByRole('button', { name: /Export log/i })).toBeNull();
  });

  it('does not render a per-row Revert button even on events marked revertible', () => {
    /* `revertible` stays in the data shape for a future revert UI, but the
       affordance is gone for now — the no-op button was misleading. */
    const withRevertible: ChangeLogEvent[] = [
      makeEvent({
        id: 1,
        type: 'regenerate',
        title: 'Regenerated CH 3',
        chapterId: 3,
        revertible: true,
      }),
    ];
    render(<ChangeLogView events={withRevertible} />);
    expect(screen.queryByRole('button', { name: /Revert/i })).toBeNull();
  });
});

describe('ChangeLogView infinite-scroll sentinel', () => {
  it('renders the load-more sentinel when hasMore + onLoadMore are supplied', () => {
    render(<ChangeLogView events={sampleEvents} onLoadMore={() => {}} hasMore={true} />);
    expect(screen.getByTestId('changelog-load-more-sentinel')).toBeInTheDocument();
  });

  it('omits the sentinel for the per-book view (no onLoadMore wired) so the page does not promise scroll-to-load it cannot deliver', () => {
    render(<ChangeLogView events={sampleEvents} />);
    expect(screen.queryByTestId('changelog-load-more-sentinel')).toBeNull();
  });

  it('omits the sentinel once the workspace tail is reached (hasMore=false)', () => {
    render(<ChangeLogView events={sampleEvents} onLoadMore={() => {}} hasMore={false} />);
    expect(screen.queryByTestId('changelog-load-more-sentinel')).toBeNull();
  });
});

describe('ChangeLogView daily-section scroller', () => {
  it('caps each daily section with overflow-y-auto so long buckets scroll internally', () => {
    /* Synthesise 30 chapter_complete events under "today" — well over the
       ~20-row cap. The data-testid lookup confirms the wrapper exists and
       owns the overflow. */
    const many: ChangeLogEvent[] = Array.from({ length: 30 }, (_, i) =>
      makeEvent({
        id: 100 + i,
        type: 'chapter_complete',
        title: `Chapter ${i + 1} complete`,
        chapterId: i + 1,
      }),
    );
    render(<ChangeLogView events={many} />);
    const scroller = screen.getByTestId('changelog-section-scroll-today');
    expect(scroller.className).toMatch(/overflow-y-auto/);
    expect(scroller.className).toMatch(/scrollbar-thin/);
    expect(scroller.style.maxHeight).toBeTruthy();
    /* All 30 rows are still in the DOM — the cap is visual via overflow,
       not by truncating the list. */
    const rows = within(scroller).getAllByText(/^Chapter \d+ complete$/);
    expect(rows).toHaveLength(30);
  });

  it('renders one scroller per date bucket', () => {
    const mixed: ChangeLogEvent[] = [
      makeEvent({ id: 1, type: 'chapter_complete', title: 'Today event', date: 'today' }),
      makeEvent({ id: 2, type: 'chapter_complete', title: 'Yesterday event', date: 'yesterday' }),
      makeEvent({ id: 3, type: 'chapter_complete', title: 'Earlier event', date: 'earlier' }),
    ];
    render(<ChangeLogView events={mixed} />);
    expect(screen.getByTestId('changelog-section-scroll-today')).toBeInTheDocument();
    expect(screen.getByTestId('changelog-section-scroll-yesterday')).toBeInTheDocument();
    expect(screen.getByTestId('changelog-section-scroll-earlier')).toBeInTheDocument();
  });
});
