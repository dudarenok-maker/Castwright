import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { accountSlice } from '../../store/account-slice';
import { StepLibrary } from './step-library';
import { api } from '../../lib/api';
import type { SetupReadiness } from '../../lib/api';

const READINESS = { ready: true, completedAt: null, blockers: {} as never, info: { gpu: 'CPU' } } as unknown as SetupReadiness;

// Store idiom — mirrors step-defaults.test.tsx:53-65. NO default export exists;
// use accountSlice.reducer + accountSlice.getInitialState() (also fully resolves
// the account shape — do NOT hand-build AccountState).
type AccountPreload = Partial<ReturnType<typeof accountSlice.getInitialState>>;
function makeStore(over: AccountPreload = {}) {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: { ...accountSlice.getInitialState(), ...over } as ReturnType<typeof accountSlice.getInitialState>,
    },
  });
}
// getLibrary() shape is { authors: [{ name, series: [{ name, books: [] }] }] }.
const EMPTY_LIB = { authors: [] };
const TWO_BOOKS = { authors: [{ name: 'A', series: [{ name: 'S', books: [{}, {}] }] }] };

beforeEach(() => {
  vi.spyOn(api, 'getLibrary').mockResolvedValue(EMPTY_LIB as never);
});

describe('StepLibrary', () => {
  it('shows the resolved workspaceRoot as read-only display', async () => {
    render(<Provider store={makeStore({ workspaceRoot: 'C:\\Users\\me\\Castwright', workspaceSource: 'default' })}>
      <StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/C:\\Users\\me\\Castwright/)).toBeInTheDocument();
  });

  it('with no override: input empty, not dirty, no restart badge, Save disabled, no dispatch', async () => {
    const store = makeStore({ workspaceDirOverride: null });
    const spy = vi.spyOn(store, 'dispatch');
    render(<Provider store={store}><StepLibrary readiness={READINESS} /></Provider>);
    const input = await screen.findByLabelText(/library folder/i) as HTMLInputElement;
    expect(input.value).toBe('');               // REGRESSION: fails if seeded from workspaceRoot
    expect(screen.queryByText(/restart/i)).not.toBeInTheDocument();
    expect((screen.getByRole('button', { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
    // No account/save action dispatched (getLibrary's fetch may dispatch nothing on this slice).
    const saveCalls = spy.mock.calls.filter(
      ([a]) => typeof a === 'object' && a !== null && String((a as { type?: string }).type).includes('account/save'),
    );
    expect(saveCalls).toHaveLength(0);
  });

  it('editing then Save dispatches workspaceDirOverride and calls onLibrarySaved', async () => {
    const store = makeStore({ workspaceDirOverride: null });
    const onSaved = vi.fn();
    render(<Provider store={store}><StepLibrary readiness={READINESS} onLibrarySaved={onSaved} /></Provider>);
    const input = await screen.findByLabelText(/library folder/i);
    fireEvent.change(input, { target: { value: 'D:\\Books' } });
    expect(screen.getByText(/restart/i)).toBeInTheDocument();     // dirty badge
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('workspaceSource "override" renders the provenance note', async () => {
    render(<Provider store={makeStore({ workspaceSource: 'override', workspaceDirOverride: 'D:\\Books' })}>
      <StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/saved location from your Castwright settings/i)).toBeInTheDocument();
  });

  it('non-empty library renders the "does not move existing files" warning', async () => {
    vi.spyOn(api, 'getLibrary').mockResolvedValue(TWO_BOOKS as never);
    render(<Provider store={makeStore()}><StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/does not move existing files/i)).toBeInTheDocument();
  });

  it('empty library renders the "nothing to move" copy', async () => {
    render(<Provider store={makeStore()}><StepLibrary readiness={READINESS} /></Provider>);
    expect(await screen.findByText(/nothing to move/i)).toBeInTheDocument();
  });
});
