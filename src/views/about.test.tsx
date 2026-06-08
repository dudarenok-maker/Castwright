/* Task 1 — /about brand page. TDD tests run before the view exists.
   Regression: the About page must show the primary tagline, manifesto,
   the castwright.ai link, and the app version so the brand identity
   is always reachable from Admin. */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice } from '../store/ui-slice';
import { AboutView } from './about';
import { buildInfo } from '../lib/build-info';

function renderAbout() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  return render(
    <Provider store={store}>
      <AboutView />
    </Provider>,
  );
}

describe('AboutView', () => {
  it('renders the primary tagline', () => {
    renderAbout();
    expect(
      screen.getByText(
        /Any book, performed by a full cast — effortlessly\. Even in your own voice\./,
      ),
    ).toBeInTheDocument();
  });

  it('renders the manifesto', () => {
    renderAbout();
    expect(screen.getByText(/Many voices, one machine\./)).toBeInTheDocument();
  });

  it('renders the castwright.ai external link with the correct href', () => {
    renderAbout();
    const link = screen.getByRole('link', { name: /castwright\.ai/i });
    expect(link).toHaveAttribute('href', 'https://castwright.ai');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('renders the app version string', () => {
    renderAbout();
    expect(screen.getByText(new RegExp(`Castwright v${buildInfo.version}`))).toBeInTheDocument();
  });
});
