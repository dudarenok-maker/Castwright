/* Smoke test for the top-level ErrorBoundary.

   The regression we're guarding: before this boundary existed, any throw
   from a deep render (a reducer that crashed on a malformed generation tick,
   a selector that returned undefined where the view expected a chapter) took
   down the whole app — which, paired with the hash router, presented to the
   user as a page reload. The boundary catches the throw and renders a
   fallback the user can recover from in-place. */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './error-boundary';

/* Module-level flag so the test can disarm the throw between the initial
   crash and the "Try again" remount — using component state would re-throw
   on every fresh mount that the boundary creates. */
let armed = true;
function ThrowOnce({ message }: { message: string }) {
  if (armed) throw new Error(message);
  return <div>recovered</div>;
}

beforeEach(() => { armed = true; });

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(<ErrorBoundary><span>ok</span></ErrorBoundary>);
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('catches a render error and surfaces the message in the fallback', () => {
    /* React logs the caught error to console.error by default — silence it
       so the test output doesn't look like the test itself failed. */
    const origError = console.error;
    console.error = () => undefined;
    try {
      render(<ErrorBoundary><ThrowOnce message="reducer crashed on a tick"/></ErrorBoundary>);
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/reducer crashed on a tick/)).toBeTruthy();
      expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    } finally {
      console.error = origError;
    }
  });

  it('Try again button resets the boundary state', () => {
    const origError = console.error;
    console.error = () => undefined;
    try {
      render(<ErrorBoundary><ThrowOnce message="transient"/></ErrorBoundary>);
      expect(screen.getByRole('alert')).toBeTruthy();
      armed = false;
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('recovered')).toBeTruthy();
    } finally {
      console.error = origError;
    }
  });
});
