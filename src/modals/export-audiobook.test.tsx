/* Pairs with docs/features/32-audiobook-export.md.

   Covers the modal's job lifecycle: open, render both tabs, submit,
   poll a job through in_progress → done, and surface a 409
   export_incomplete with the missing-chapter list. The api module is
   mocked at the test boundary so we can drive deterministic timings. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { exportsSlice } from '../store/exports-slice';
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
      getUserSettings: vi.fn(async () => ({} as unknown)),
      putUserSettings: vi.fn(),
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
};

function makeStore() {
  return configureStore({
    reducer: {
      exports: exportsSlice.reducer,
      account: accountSlice.reducer,
      ui:      uiSlice.reducer,
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
      ui:      uiSlice.reducer,
    },
    preloadedState: {
      exports: exportsSlice.getInitialState(),
      account: {
        ...accountSlice.getInitialState(),
        exportSyncFolder: folder,
      },
      ui:      uiSlice.getInitialState(),
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
      <ExportAudiobookModal {...props}/>
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

  it('starts a job on submit and renders progress until done', async () => {
    const ticks: BookExportJob[] = [
      makeJob({ status: 'in_progress', progress: 0.25 }),
      makeJob({ status: 'in_progress', progress: 0.7 }),
      makeJob({ status: 'done', progress: 1, sizeBytes: 4096, downloadUrl: 'blob:demo' }),
    ];
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));
    let pollCount = 0;
    mockedApi.getBookExport.mockImplementation(async () => {
      const next = ticks[Math.min(pollCount, ticks.length - 1)];
      pollCount += 1;
      return next;
    });

    renderModal();
    /* LAN URL hydrates async; the submit button only enables once it lands. */
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByTestId('export-active-job')).toBeInTheDocument();
    });
    /* Spin the poller until the final state surfaces. */
    await waitFor(() => {
      expect(screen.getByText(/done/i)).toBeInTheDocument();
    }, { timeout: 5000 });
    expect(mockedApi.createBookExport).toHaveBeenCalledWith(
      'demo__sa__test',
      expect.objectContaining({ format: 'm4b', destination: 'download' }),
    );
  });

  it('switches the export format to MP3.ZIP and submits with that format', async () => {
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));
    mockedApi.getBookExport.mockResolvedValue(makeJob({ status: 'done', progress: 1, sizeBytes: 1024, downloadUrl: 'blob:demo' }));

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
    mockedApi.createBookExport.mockRejectedValue(new ExportIncompleteError(['02-chapter-two', '07-epilogue']));
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
    mockedApi.createBookExport.mockResolvedValue(makeJob({ id: 'exp_run', status: 'in_progress', progress: 0 }));
    /* Poll keeps returning in_progress so Cancel is the only way out. */
    mockedApi.getBookExport.mockResolvedValue(makeJob({ id: 'exp_run', status: 'in_progress', progress: 0.3 }));

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
    /* First create resolves with a job that polls to failed; second
       create (from Retry) resolves with a fresh in_progress job. */
    mockedApi.createBookExport
      .mockResolvedValueOnce(makeJob({ id: 'exp_fail', status: 'in_progress', progress: 0 }))
      .mockResolvedValueOnce(makeJob({ id: 'exp_retry', status: 'in_progress', progress: 0 }));
    mockedApi.getBookExport
      .mockResolvedValueOnce(makeJob({ id: 'exp_fail', status: 'failed', errorReason: 'ffmpeg crashed', progress: 0.4 }))
      .mockResolvedValue(makeJob({ id: 'exp_retry', status: 'in_progress', progress: 0.2 }));

    renderModal();
    /* MP3.ZIP so the retried submit can be checked for format propagation. */
    fireEvent.click(screen.getByTestId('export-format-mp3-zip'));
    const submit = await waitFor(() => {
      const btn = screen.getByTestId('export-submit');
      if ((btn as HTMLButtonElement).disabled) throw new Error('still disabled');
      return btn;
    });
    fireEvent.click(submit);

    /* Wait for FAILED to surface the Retry button. */
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
    mockedApi.getBookExport.mockResolvedValue(makeJob({ status: 'done', progress: 1, sizeBytes: 4096, downloadUrl: 'blob:demo' }));

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
