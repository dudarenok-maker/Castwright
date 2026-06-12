import { describe, it, expect } from 'vitest';
import { stepsForScreen, TOUR_STEPS } from '../../lib/tour-steps';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { tourSlice } from '../../store/tour-slice';
import { uiSlice } from '../../store/ui-slice';
import { TourOverlay } from './tour-overlay';

function mkStore(stepIndex: number, active = true) {
  const store = configureStore({ reducer: { tour: tourSlice.reducer, ui: uiSlice.reducer } });
  store.dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
  store.dispatch(tourSlice.actions.setStepIndex(stepIndex));
  if (!active) store.dispatch(tourSlice.actions.endTour());
  return store;
}

describe('TourOverlay', () => {
  it('renders nothing when inactive', () => {
    const { container } = render(<Provider store={mkStore(0, false)}><TourOverlay /></Provider>);
    expect(container.querySelector('[data-testid="tour-overlay"]')).toBeNull();
    expect(document.querySelector('[data-testid="tour-overlay"]')).toBeNull();
  });

  it('renders the coach bubble title/body for the current step', () => {
    render(<Provider store={mkStore(0)}><TourOverlay /></Provider>);
    expect(screen.getByText('Welcome to Castwright')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('falls back to a centered bubble when the anchor is missing', () => {
    render(<Provider store={mkStore(1)}><TourOverlay /></Provider>);
    const bubble = screen.getByTestId('tour-bubble');
    expect(bubble.getAttribute('data-anchored')).toBe('false');
  });

  it('Skip ends the tour', () => {
    const store = mkStore(0);
    render(<Provider store={store}><TourOverlay /></Provider>);
    fireEvent.click(screen.getByRole('button', { name: /skip/i }));
    expect(store.getState().tour.active).toBe(false);
  });

  it('shows Back when not on the first step', () => {
    render(<Provider store={mkStore(1)}><TourOverlay /></Provider>);
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });

  it('shows Done on the last step', () => {
    render(<Provider store={mkStore(TOUR_STEPS.length - 1)}><TourOverlay /></Provider>);
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
  });

  it('screen-mode shows slice-scoped dots and Done on the slice last step', () => {
    const store = configureStore({ reducer: { tour: tourSlice.reducer, ui: uiSlice.reducer } });
    const cast = stepsForScreen('cast');
    const lastCastGlobalIndex = TOUR_STEPS.indexOf(cast[cast.length - 1]);
    store.dispatch(tourSlice.actions.startTour({ tourId: 'cast', mode: 'screen' }));
    store.dispatch(tourSlice.actions.setStepIndex(lastCastGlobalIndex));
    render(<Provider store={store}><TourOverlay /></Provider>);
    expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument();
    // dot count == cast slice length (the dots are small rounded-full spans in the bubble)
    const bubble = screen.getByTestId('tour-bubble');
    const dots = bubble.querySelectorAll('span.rounded-full');
    expect(dots.length).toBe(cast.length);
  });
});
