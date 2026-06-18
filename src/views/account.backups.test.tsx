/* srv-2 — AccountView Backups card. Asserts the card renders, the
   cadence/retention controls reflect slice state, the enable toggle
   dispatches through to the Save patch, and the restore picker lists a
   selected book's snapshots. Mocks src/lib/api so the api wrappers and
   library hydrate in memory. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accountSlice, type AccountState } from '../store/account-slice';
import { librarySlice, type LibraryState } from '../store/library-slice';
import { uiSlice } from '../store/ui-slice';
import { settingsSlice } from '../store/settings-slice';
import { upgradeSlice } from '../store/upgrade-slice';
import { AccountView } from './account';
import type { UserSettings } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    getUserSettings: vi.fn(),
    putUserSettings: vi.fn(),
    putGeminiKey: vi.fn(),
    listBookBackups: vi.fn(),
    backupBookNow: vi.fn(),
    restoreBookBackup: vi.fn(),
    getLibrary: vi.fn(),
    /* UpgradeCard (inside AccountView) checks for updates on mount; fail-open. */
    getUpdateStatus: vi.fn().mockResolvedValue({
      reachable: false,
      currentVersion: '',
      latestVersion: null,
      updateAvailable: false,
      url: null,
    }),
  },
}));

import { api } from '../lib/api';

const SERVER_FIXTURE: UserSettings = {
  displayName: 'Castwright',
  defaultAnalysisModel: 'gemma-4-31b-it',
  defaultTtsEngine: 'local',
  defaultTtsModelKey: 'coqui-xtts-v2',
  sidecarUrl: 'http://localhost:9000',
  analysisEngine: 'local',
  ollamaUrl: 'http://localhost:11434',
  workspaceDirOverride: null,
  minorCastMinLines: 3,
  analyzerPhase0Model: null,
  analyzerPhase1Model: null,
  analyzerPhase1MinLagChapters: null,
  apiKeyStatus: 'unset',
  workspaceRoot: '/users/mike/workspace',
  workspaceSource: 'env',
  backupEnabled: true,
  backupCadence: 'daily',
  backupRetention: 14,
};

const SB_BOOK = {
  bookId: 'sb',
  title: 'Solway Bay',
  author: 'Marin Vale',
  series: 'Northern Coast Trilogy',
  seriesPosition: 1,
  isStandalone: false,
  status: 'complete' as const,
  chapterCount: 18,
  completedChapters: 18,
  characterCount: 6,
  voiceCount: 6,
  lastWorkedOn: '2026-05-30',
  coverGradient: ['#6B6663', '#1A1A1A'] as [string, string],
  tags: [],
};

const LIBRARY_FIXTURE: LibraryState = {
  loaded: true,
  error: null,
  authors: [
    {
      name: 'Marin Vale',
      series: [{ name: 'Northern Coast Trilogy', books: [SB_BOOK] }],
    },
  ],
  books: [SB_BOOK],
  pausedSnapshots: {},
};

function renderView(initial: Partial<UserSettings> = {}) {
  const preloaded: AccountState = {
    ...SERVER_FIXTURE,
    ...initial,
    status: 'idle',
    error: null,
    hydrated: true,
    localAnalyzerModels: [],
    pullableModels: [],
  };
  const store = configureStore({
    reducer: {
      account: accountSlice.reducer,
      ui: uiSlice.reducer,
      library: librarySlice.reducer,
      settings: settingsSlice.reducer,
      upgrade: upgradeSlice.reducer,
    },
    preloadedState: { account: preloaded, library: LIBRARY_FIXTURE },
  });
  return {
    store,
    ...render(
      <Provider store={store}>
        <MemoryRouter>
          <AccountView />
        </MemoryRouter>
      </Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccountView — Backups card (srv-2)', () => {
  it('renders the Backups card with all three controls', () => {
    renderView();
    expect(screen.getByTestId('account-backup-enabled')).toBeInTheDocument();
    expect(screen.getByTestId('account-backup-cadence')).toBeInTheDocument();
    expect(screen.getByTestId('account-backup-retention')).toBeInTheDocument();
  });

  it('reflects the persisted cadence + retention in the controls', () => {
    renderView({ backupCadence: 'weekly', backupRetention: 30 });
    expect((screen.getByTestId('account-backup-cadence') as HTMLSelectElement).value).toBe('weekly');
    expect((screen.getByTestId('account-backup-retention') as HTMLInputElement).value).toBe('30');
  });

  it('renders the enable toggle checked when the preference is true', () => {
    renderView({ backupEnabled: true });
    expect((screen.getByTestId('account-backup-enabled') as HTMLInputElement).checked).toBe(true);
  });

  it('defaults to enabled/daily/14 when the fields are absent (legacy settings file)', () => {
    renderView({ backupEnabled: undefined, backupCadence: undefined, backupRetention: undefined });
    expect((screen.getByTestId('account-backup-enabled') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('account-backup-cadence') as HTMLSelectElement).value).toBe('daily');
    expect((screen.getByTestId('account-backup-retention') as HTMLInputElement).value).toBe('14');
  });

  it('clamps an out-of-range retention to [1, 365]', () => {
    renderView({ backupRetention: 14 });
    const input = screen.getByTestId('account-backup-retention') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '999' } });
    expect(input.value).toBe('365');
    fireEvent.change(input, { target: { value: '0' } });
    expect(input.value).toBe('1');
  });

  it('round-trips the three backup fields through the Save patch', async () => {
    (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...SERVER_FIXTURE,
      backupEnabled: false,
      backupCadence: 'weekly',
      backupRetention: 30,
    });
    const user = userEvent.setup();
    renderView({ backupEnabled: true, backupCadence: 'daily', backupRetention: 14 });

    await user.click(screen.getByTestId('account-backup-enabled'));
    fireEvent.change(screen.getByTestId('account-backup-cadence'), {
      target: { value: 'weekly' },
    });
    fireEvent.change(screen.getByTestId('account-backup-retention'), {
      target: { value: '30' },
    });

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(api.putUserSettings).toHaveBeenCalledTimes(1);
    });
    const [patch] = (api.putUserSettings as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(patch.backupEnabled).toBe(false);
    expect(patch.backupCadence).toBe('weekly');
    expect(patch.backupRetention).toBe(30);
  });

  it('lists a selected book\'s snapshots from the api', async () => {
    (api.listBookBackups as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { file: 'state.2026-05-31.json', sizeBytes: 18_432, createdAt: '2026-05-31T08:00:00.000Z' },
    ]);
    const user = userEvent.setup();
    renderView();
    await user.selectOptions(screen.getByTestId('account-backup-book-picker'), 'sb');
    await waitFor(() => {
      expect(api.listBookBackups).toHaveBeenCalledWith('sb');
    });
    expect(await screen.findByText('state.2026-05-31.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^restore$/i })).toBeInTheDocument();
  });

  it('refreshes the library from the server after a successful restore (#424)', async () => {
    (api.listBookBackups as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { file: '20260531-080000.json', sizeBytes: 18_432, createdAt: '2026-05-31T08:00:00.000Z' },
    ]);
    (api.restoreBookBackup as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    /* getLibrary returns the book with a different (restored) title so we can
       assert the slice was re-hydrated, not just that the call fired. */
    (api.getLibrary as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      authors: [
        {
          name: 'Marin Vale',
          series: [
            {
              name: 'Northern Coast Trilogy',
              books: [{ ...SB_BOOK, title: 'Solway Bay (restored)' }],
            },
          ],
        },
      ],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    const { store } = renderView();
    await user.selectOptions(screen.getByTestId('account-backup-book-picker'), 'sb');
    await screen.findByText('20260531-080000.json');

    await user.click(screen.getByRole('button', { name: /^restore$/i }));

    await waitFor(() => {
      expect(api.restoreBookBackup).toHaveBeenCalledWith('sb', '20260531-080000.json');
    });
    await waitFor(() => {
      expect(api.getLibrary).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(store.getState().library.books[0].title).toBe('Solway Bay (restored)');
    });

    confirmSpy.mockRestore();
  });
});
