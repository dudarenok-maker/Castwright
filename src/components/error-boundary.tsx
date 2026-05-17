/* Top-level React error boundary.

   Without this, a thrown render in any deep subtree (e.g. a reducer crash
   surfacing through a selector, or a malformed generation tick) unmounts
   the whole app — which, combined with the hash router, presents to the
   user as a page reload. The boundary catches the throw and shows a
   non-destructive fallback the user can recover from in-place without
   losing their session state. */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[error-boundary] render failed', error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="min-h-screen flex items-center justify-center p-6 bg-canvas">
        <div className="max-w-lg w-full bg-white rounded-3xl border border-ink/10 p-8 space-y-5">
          <div className="space-y-1.5">
            <p className="text-xs uppercase tracking-wider text-ink/50 font-semibold">
              Something broke
            </p>
            <h1 className="text-2xl font-bold text-ink">The Generate screen hit a render error.</h1>
            <p className="text-sm text-ink/70">
              Your work is still safe on disk. Click below to re-render the page without losing your
              session. If the error keeps coming back, copy the message and check the dev console
              for the full stack.
            </p>
          </div>
          <pre className="text-xs bg-ink/[0.04] text-ink/80 rounded-xl p-3 overflow-auto max-h-40 whitespace-pre-wrap">
            {this.state.error.message || String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            className="px-4 py-2 rounded-full bg-magenta text-white font-medium text-sm hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
