/* Pairs with docs/features/archive/32-audiobook-export.md.

   Covers the modal's job lifecycle: open, render both tabs, submit, and
   surface a 409 export_incomplete with the missing-chapter list. The
   modal is a pure view of the exports slice — the store-level
   exportPollMiddleware (not the modal) advances jobs — so progress
   assertions drive the slice directly via exportsActions.exportUpdated
   rather than polling a mocked api. The api module is still mocked at the
   test boundary for createBookExport / cancelBookExport / LAN URLs. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { exportsSlice, exportsActions } from '../store/exports-slice';
import { accountSlice } from '../store/account-slice';
import { uiSlice } from '../store/ui-slice';
import type { BookExportJob } from '../lib/types';

/* qrcode resolves to a data: URL via a real toDataURL — keep it real, the
   modal's QR rendering is part of the contract. */

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: {
      createBookExport: vi.fn(),
      getBookExport: vi.fn(),
      cancelBookExport: vi.fn(async () => undefined),
      getExportLanUrls: vi.fn(async () => ({ urls: ['http://192.168.1.42:8080'], port: 8080 })),
      getUserSettings: vi.fn(async () => ({}) as unknown),
      putUserSettings: vi.fn(),
      /* Plan 79 — sync-folder Test button calls this. Default to "ok" so
         existing specs render without a probe banner; per-test override
         flips the resolved value when the failure branch needs covering. */
      testSyncFolderPath: vi.fn(async (_path: string) => ({ ok: true })),
    },
  };
});

import { ExportAudiobookModal } from './export-audiobook';
import { api, ExportIncompleteError } from '../lib/api';

const mockedApi = api as unknown as {
  createBookExport: ReturnType<typeof vi.fn>;
  getBookExport: ReturnType<typeof vi.fn>;
  cancelBookExport: ReturnType<typeof vi.fn>;
  getExportLanUrls: ReturnType<typeof vi.fn>;
  putUserSettings: ReturnType<typeof vi.fn>;
  testSyncFolderPath: ReturnType<typeof vi.fn>;
};

function makeStore() {
  return configureStore({
    reducer: {
      exports: exportsSlice.reducer,
      account: accountSlice.reducer,
      ui: uiSlice.reducer,
    },
  });
}

/* Seeds account.exportSyncFolder via preloadedState so the Voice-mode tests
   can drive canSubmit=true without a real PUT to /api/account/settings. */
function makeStoreWithSyncFolder(folder: string) {
  return configureStore({
    reducer: {
      exports: exportsSlice.reducer,
      account: accountSlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: {
      exports: exportsSlice.getInitialState(),
      account: {
        ...accountSlice.getInitialState(),
        exportSyncFolder: folder,
      },
      ui: uiSlice.getInitialState(),
    },
  });
}

function renderModal(overrides: Partial<React.ComponentProps<typeof ExportAudiobookModal>> = {}) {
  const props = {
    open: true,
    bookId: 'demo__sa__test',
    onClose: vi.fn(),
    ...overrides,
  };
  return render(
    <Provider store={makeStore()}>
      <ExportAudiobookModal {...props} />
    </Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExportAudiobookModal', () => {
  it('renders both tabs and the LAN URL on the Download tab', async () => {
    renderModal();
    expect(screen.getByTestId('export-tab-download')).toBeInTheDocument();
    expect(screen.getByTestId('export-tab-sync-folder')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/192\.168\.1\.42:8080/)).toBeInTheDocument();
    });
  });

  it('switches to the Save to sync folder tab and renders the input', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('export-tab-sync-folder'));
    expect(screen.getByTestId('sync-folder-input')).toBeInTheDocument();
  });

  it('starts a job on submit and renders progress as the store advances', async () => {
    /* The modal is a pure view of the exports slice — the store-level
       exportPollMiddleware (not the modal) advances the job. This drives
       that lifecycle by dispatching the updates the middleware would emit
       and asserts the modal re-renders from the store each step. */
    const started = makeJob({ id: 'exp_view', status: 'in_progress', progress: 0 });
    mockedApi.createBookExport.mockResolvedValue(started);

    const store = makeStore();
    render(
      <Provider store={store}>
        <ExportAudiobookModal open={true} bookId="demo__sa__test" onClose={vi.fn()} />
      </Provider>,
    );
    /* LAN URL hydrates async; the submit button only enables once it lands. */
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    /* exportStarted seeded the active job — the card renders immediately. */
    await waitFor(() => {
      expect(screen.getByTestId('export-active-job')).toBeInTheDocument();
    });
    expect(mockedApi.createBookExport).toHaveBeenCalledWith(
      'demo__sa__test',
      expect.objectContaining({ format: 'm4b', destination: 'download' }),
    );

    /* Simulate the middleware advancing the job to terminal. */
    act(() => {
      store.dispatch(
        exportsActions.exportUpdated(
          makeJob({
            id: 'exp_view',
            status: 'done',
            progress: 1,
            sizeBytes: 4096,
            downloadUrl: 'blob:demo',
          }),
        ),
      );
    });
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });

  it('switches the export format to MP3.ZIP and submits with that format', async () => {
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));
    mockedApi.getBookExport.mockResolvedValue(
      makeJob({ status: 'done', progress: 1, sizeBytes: 1024, downloadUrl: 'blob:demo' }),
    );

    renderModal();
    /* Default should be M4B — verify the toggle reflects that before clicking. */
    expect(screen.getByTestId('export-format-m4b')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('export-format-mp3-zip'));

    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mockedApi.createBookExport).toHaveBeenCalledWith(
        'demo__sa__test',
        expect.objectContaining({ format: 'mp3-zip', destination: 'download' }),
      );
    });
  });

  it('shows the missing-chapter banner on 409 export_incomplete', async () => {
    mockedApi.createBookExport.mockRejectedValue(
      new ExportIncompleteError(['02-chapter-two', '07-epilogue']),
    );
    renderModal();
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.getByTestId('export-missing-banner')).toBeInTheDocument();
    });
    expect(screen.getByText('02-chapter-two')).toBeInTheDocument();
    expect(screen.getByText('07-epilogue')).toBeInTheDocument();
  });

  it('cancels a running export and returns the modal to the picker', async () => {
    mockedApi.createBookExport.mockResolvedValue(
      makeJob({ id: 'exp_run', status: 'in_progress', progress: 0 }),
    );
    /* Poll keeps returning in_progress so Cancel is the only way out. */
    mockedApi.getBookExport.mockResolvedValue(
      makeJob({ id: 'exp_run', status: 'in_progress', progress: 0.3 }),
    );

    renderModal();
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    /* Wait for the EXPORTING state to render the Cancel button. */
    const cancelBtn = await screen.findByTestId('export-cancel');
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(mockedApi.cancelBookExport).toHaveBeenCalledWith('demo__sa__test', 'exp_run');
    });
    /* Picker reappears (submit returns), active-job card is gone. */
    await waitFor(() => {
      expect(screen.queryByTestId('export-active-job')).toBeNull();
      expect(screen.getByTestId('export-submit')).toBeInTheDocument();
    });
  });

  it('retries from FAILED by re-POSTing the same format/destination', async () => {
    /* First create resolves with a job the (now store-level) middleware
       would drive to failed; second create (from Retry) resolves with a
       fresh in_progress job. The modal only reads the slice, so we
       simulate the middleware writing the failed status via exportUpdated. */
    mockedApi.createBookExport
      .mockResolvedValueOnce(makeJob({ id: 'exp_fail', status: 'in_progress', progress: 0 }))
      .mockResolvedValueOnce(makeJob({ id: 'exp_retry', status: 'in_progress', progress: 0 }));

    const store = makeStore();
    render(
      <Provider store={store}>
        <ExportAudiobookModal open={true} bookId="demo__sa__test" onClose={vi.fn()} />
      </Provider>,
    );
    /* MP3.ZIP so the retried submit can be checked for format propagation. */
    fireEvent.click(screen.getByTestId('export-format-mp3-zip'));
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    /* Wait for the active-job card, then drive the job to FAILED through
       the store as the middleware would. */
    await screen.findByTestId('export-active-job');
    act(() => {
      store.dispatch(
        exportsActions.exportUpdated(
          makeJob({ id: 'exp_fail', status: 'failed', errorReason: 'ffmpeg crashed', progress: 0.4 }),
        ),
      );
    });

    /* FAILED surfaces the Retry button. */
    const retryBtn = await screen.findByTestId('export-retry');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(mockedApi.createBookExport).toHaveBeenCalledTimes(2);
    });
    /* Both calls used the same shape — mp3-zip + download. */
    expect(mockedApi.createBookExport).toHaveBeenNthCalledWith(2, 'demo__sa__test', {
      format: 'mp3-zip',
      destination: 'download',
    });
    /* Picker did NOT reappear — active-job card stays rendered against
       the new job. */
    await waitFor(() => {
      expect(screen.getByTestId('export-active-job')).toBeInTheDocument();
    });
  });
});

/* Plan 33 — Voice tile opens the modal in Voice mode: format radio
   hidden, destination tab strip hidden, Voice body in place of the
   SyncFolderTab, submit forces { format: 'm4b', destination: 'sync-folder' }.
   When no sync folder is configured the submit stays disabled (the
   existing canSubmit path reused as the empty-sync-folder error path);
   typing + saving a folder unlocks submission. */
describe('ExportAudiobookModal — Voice mode (prefill.appHint === "voice")', () => {
  it('hides the destination tab strip and format toggle', () => {
    renderModal({ prefill: { format: 'm4b', destination: 'sync-folder', appHint: 'voice' } });
    expect(screen.queryByTestId('export-tab-download')).toBeNull();
    expect(screen.queryByTestId('export-tab-sync-folder')).toBeNull();
    expect(screen.queryByTestId('export-format-m4b')).toBeNull();
    expect(screen.queryByTestId('export-format-mp3-zip')).toBeNull();
    expect(screen.getByTestId('export-voice-body')).toBeInTheDocument();
  });

  it('renames the submit button to "Export to Voice library"', async () => {
    render(
      <Provider store={makeStoreWithSyncFolder('C:\\Users\\me\\OneDrive\\Audiobooks')}>
        <ExportAudiobookModal
          open={true}
          bookId="demo__sa__test"
          prefill={{ format: 'm4b', destination: 'sync-folder', appHint: 'voice' }}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    const submit = screen.getByTestId('export-submit');
    expect(submit).toHaveTextContent('Export to Voice library');
  });

  it('keeps the submit button disabled until a sync folder is configured', async () => {
    /* Mirrors the existing empty-sync-folder error path — submit is
       gated by canSubmit, which requires a non-empty exportSyncFolder
       for the sync-folder destination. Voice exports forced to
       sync-folder inherit that gate without a new banner. */
    renderModal({ prefill: { format: 'm4b', destination: 'sync-folder', appHint: 'voice' } });
    const submit = screen.getByTestId('export-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('submits with { format: "m4b", destination: "sync-folder" } regardless of any prior state', async () => {
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));
    mockedApi.getBookExport.mockResolvedValue(
      makeJob({ status: 'done', progress: 1, sizeBytes: 4096, downloadUrl: 'blob:demo' }),
    );

    render(
      <Provider store={makeStoreWithSyncFolder('C:\\Users\\me\\OneDrive\\Audiobooks')}>
        <ExportAudiobookModal
          open={true}
          bookId="demo__sa__test"
          prefill={{ format: 'm4b', destination: 'sync-folder', appHint: 'voice' }}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    const submit = screen.getByTestId('export-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(mockedApi.createBookExport).toHaveBeenCalledWith(
        'demo__sa__test',
        expect.objectContaining({ format: 'm4b', destination: 'sync-folder' }),
      );
    });
  });

  it('still renders the full toggle surface when prefill is undefined (regression guard)', async () => {
    /* Make sure the appHint branch hasn't accidentally collapsed the
       generic flow's UX. The header "Export audiobook" pill in the
       Listen view opens the modal with no prefill — those callers must
       still see both tab strip pills and both format toggles. */
    renderModal();
    expect(screen.getByTestId('export-tab-download')).toBeInTheDocument();
    expect(screen.getByTestId('export-tab-sync-folder')).toBeInTheDocument();
    expect(screen.getByTestId('export-format-m4b')).toBeInTheDocument();
    expect(screen.getByTestId('export-format-mp3-zip')).toBeInTheDocument();
    expect(screen.queryByTestId('export-voice-body')).toBeNull();
  });
});

/* Plan 79 — sync-folder UX hardening. Before this round the user had to
   spot a small "Save folder" button before the submit gate would unlock,
   the most common failure mode for Voice → Google Drive (folder typed,
   never saved, modal reopens empty). The blur autosave + visible error
   banner + Test probe close that loop. */
describe('ExportAudiobookModal — sync-folder UX (plan 79)', () => {
  it('auto-saves on input blur-sm when the draft differs from the saved value', async () => {
    mockedApi.putUserSettings.mockResolvedValue({
      exportSyncFolder: 'G:\\My Drive\\Audiobooks',
    } as never);
    renderModal({ prefill: { format: 'm4b', destination: 'sync-folder', appHint: 'voice' } });
    const input = screen.getByTestId('sync-folder-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'G:\\My Drive\\Audiobooks' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(mockedApi.putUserSettings).toHaveBeenCalledWith({
        exportSyncFolder: 'G:\\My Drive\\Audiobooks',
      });
    });
  });

  it('does NOT auto-save on blur-sm when the draft equals the saved value', () => {
    renderModal({ prefill: { format: 'm4b', destination: 'sync-folder', appHint: 'voice' } });
    /* Voice body opens with an empty draft (no saved folder yet); blurring
       without typing anything must NOT fire a PUT. */
    const input = screen.getByTestId('sync-folder-input');
    fireEvent.blur(input);
    expect(mockedApi.putUserSettings).not.toHaveBeenCalled();
  });

  it('renders the "Test" probe button and shows ✓ on a successful probe', async () => {
    mockedApi.testSyncFolderPath.mockResolvedValueOnce({ ok: true });
    render(
      <Provider store={makeStoreWithSyncFolder('G:\\My Drive\\Audiobooks')}>
        <ExportAudiobookModal
          open={true}
          bookId="demo__sa__test"
          prefill={{ format: 'm4b', destination: 'sync-folder', appHint: 'voice' }}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('sync-folder-test'));
    await waitFor(() => {
      expect(mockedApi.testSyncFolderPath).toHaveBeenCalledWith('G:\\My Drive\\Audiobooks');
      expect(screen.getByTestId('sync-folder-probe-ok')).toBeInTheDocument();
    });
  });

  it('shows ✗ with the failure code when the probe returns ok=false', async () => {
    mockedApi.testSyncFolderPath.mockResolvedValueOnce({
      ok: false,
      code: 'EACCES',
      message: 'permission denied',
    });
    render(
      <Provider store={makeStoreWithSyncFolder('G:\\My Drive\\Audiobooks')}>
        <ExportAudiobookModal
          open={true}
          bookId="demo__sa__test"
          prefill={{ format: 'm4b', destination: 'sync-folder', appHint: 'voice' }}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('sync-folder-test'));
    const fail = await screen.findByTestId('sync-folder-probe-fail');
    expect(fail.textContent).toMatch(/EACCES/);
    expect(fail.textContent).toMatch(/permission denied/);
  });

  it('disables the Test button when the input is empty', () => {
    renderModal({ prefill: { format: 'm4b', destination: 'sync-folder', appHint: 'voice' } });
    const test = screen.getByTestId('sync-folder-test') as HTMLButtonElement;
    expect(test.disabled).toBe(true);
  });

  it('surfaces a save error as a red banner when saveAccountSettings rejects', async () => {
    /* Seed account.error directly via preloadedState — the most reliable
       way to assert the banner renders when the slice carries an error,
       independent of whatever thunk lifecycle wrote it. */
    const store = configureStore({
      reducer: {
        exports: exportsSlice.reducer,
        account: accountSlice.reducer,
        ui: uiSlice.reducer,
      },
      preloadedState: {
        exports: exportsSlice.getInitialState(),
        account: {
          ...accountSlice.getInitialState(),
          exportSyncFolder: 'G:\\My Drive\\Audiobooks',
          error: 'EACCES: permission denied (server)',
        },
        ui: uiSlice.getInitialState(),
      },
    });
    render(
      <Provider store={store}>
        <ExportAudiobookModal
          open={true}
          bookId="demo__sa__test"
          prefill={{ format: 'm4b', destination: 'sync-folder', appHint: 'voice' }}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    const banner = screen.getByTestId('sync-folder-save-error');
    expect(banner.textContent).toMatch(/EACCES/);
    expect(banner.textContent).toMatch(/permission denied/);
  });
});

/* Plan 72 — AAC/M4A and Opus toggles. The picker exposes the codec-zip
   variants alongside MP3.ZIP + M4B; clicking through dispatches the
   matching `format` discriminator on createBookExport. The server-side
   gate (chapter audio must match the export codec) lives in the export
   route + builder and surfaces via the same missing-chapter banner the
   MP3.ZIP path already handles. */
describe('ExportAudiobookModal — AAC/Opus format picker (plan 72)', () => {
  it('renders all four format toggle buttons in the generic picker', () => {
    renderModal();
    expect(screen.getByTestId('export-format-m4b')).toBeInTheDocument();
    expect(screen.getByTestId('export-format-mp3-zip')).toBeInTheDocument();
    expect(screen.getByTestId('export-format-aac-m4a-zip')).toBeInTheDocument();
    expect(screen.getByTestId('export-format-opus-ogg-zip')).toBeInTheDocument();
  });

  it('submits with format=aac-m4a-zip when the AAC toggle is selected', async () => {
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));
    mockedApi.getBookExport.mockResolvedValue(
      makeJob({ status: 'done', progress: 1, sizeBytes: 1024, downloadUrl: 'blob:demo' }),
    );

    renderModal();
    fireEvent.click(screen.getByTestId('export-format-aac-m4a-zip'));
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mockedApi.createBookExport).toHaveBeenCalledWith(
        'demo__sa__test',
        expect.objectContaining({ format: 'aac-m4a-zip', destination: 'download' }),
      );
    });
  });

  it('submits with format=opus-ogg-zip when the Opus toggle is selected', async () => {
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));
    mockedApi.getBookExport.mockResolvedValue(
      makeJob({ status: 'done', progress: 1, sizeBytes: 1024, downloadUrl: 'blob:demo' }),
    );

    renderModal();
    fireEvent.click(screen.getByTestId('export-format-opus-ogg-zip'));
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mockedApi.createBookExport).toHaveBeenCalledWith(
        'demo__sa__test',
        expect.objectContaining({ format: 'opus-ogg-zip', destination: 'download' }),
      );
    });
  });
});

function makeJob(overrides: Partial<BookExportJob> = {}): BookExportJob {
  return {
    id: 'exp_test_1',
    bookId: 'demo__sa__test',
    format: 'mp3-zip',
    destination: 'download',
    status: 'in_progress',
    filename: 'demo.zip',
    sizeBytes: null,
    progress: 0,
    downloadUrl: null,
    syncPath: null,
    errorReason: null,
    createdAt: '2025-01-01T00:00:00Z',
    completedAt: null,
    ...overrides,
  };
}
