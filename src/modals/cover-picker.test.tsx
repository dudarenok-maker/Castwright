/* CoverPicker modal — opens on demand from the library card "..." menu
   and the Listen-view "Change cover" button.

   Asserts: the four search-tab states (loading → ready / empty / error),
   the pick-success round-trip, the Remove-cover destructive button, AND
   (plan 40) the three-tab UI, upload happy/sad paths, framing PATCH,
   and the account-default-tab seam. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { CoverPicker } from './cover-picker';
import { accountSlice } from '../store/account-slice';
import type { CoverCandidate } from '../lib/types';

/* Each test customises the mock return value before importing the
   component (which then resolves api.* via the module-level mock). */
const findCoverCandidates = vi.fn();
const setCover = vi.fn();
const removeCover = vi.fn();
const uploadCover = vi.fn();
const patchCoverFraming = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    findCoverCandidates: (...args: unknown[]) => findCoverCandidates(...args),
    setCover: (...args: unknown[]) => setCover(...args),
    removeCover: (...args: unknown[]) => removeCover(...args),
    uploadCover: (...args: unknown[]) => uploadCover(...args),
    patchCoverFraming: (...args: unknown[]) => patchCoverFraming(...args),
  },
  UploadCoverError: class extends Error {
    constructor(
      public kind: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const TWO_CANDIDATES: CoverCandidate[] = [
  { id: 'openlibrary:11', source: 'openlibrary', coverUrl: 'https://covers/11-L.jpg', edition: 'Alpha · 2020' },
  { id: 'apple:22', source: 'apple', coverUrl: 'https://covers/22-L.jpg', edition: 'Beta · 2021' },
];

beforeEach(() => {
  findCoverCandidates.mockReset();
  setCover.mockReset();
  removeCover.mockReset();
  uploadCover.mockReset();
  patchCoverFraming.mockReset();
});

type RenderOpts = {
  defaultTab?: 'search' | 'upload';
} & Partial<React.ComponentProps<typeof CoverPicker>>;

function makeStore(defaultTab: 'search' | 'upload' = 'search') {
  return configureStore({
    reducer: { account: accountSlice.reducer },
    preloadedState: {
      account: {
        ...accountSlice.getInitialState(),
        coverPickerDefaultTab: defaultTab,
      },
    },
  });
}

function renderPicker({ defaultTab = 'search', ...overrides }: RenderOpts = {}) {
  const onClose = vi.fn();
  const onPicked = vi.fn();
  const onFramingChanged = vi.fn();
  const store = makeStore(defaultTab);
  const utils = render(
    <Provider store={store}>
      <CoverPicker
        open
        bookId="bk_test"
        bookTitle="the Coalfall Commission"
        bookAuthor="Della Renwick"
        onClose={onClose}
        onPicked={onPicked}
        onFramingChanged={onFramingChanged}
        {...overrides}
      />
    </Provider>,
  );
  return { onClose, onPicked, onFramingChanged, store, ...utils };
}

describe('CoverPicker — rendering states (Search tab)', () => {
  it('renders the candidate grid once the request resolves', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    renderPicker();

    expect(findCoverCandidates).toHaveBeenCalledWith('bk_test');

    await waitFor(() => expect(screen.getByTestId('cover-grid')).toBeInTheDocument());
    expect(screen.getByTestId('cover-candidate-openlibrary:11')).toBeInTheDocument();
    expect(screen.getByTestId('cover-candidate-apple:22')).toBeInTheDocument();
  });

  it('renders the empty-state copy naming all three sources', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker();
    await screen.findByText(/across openlibrary, apple books, and google books/i);
    expect(screen.queryByTestId('cover-grid')).not.toBeInTheDocument();
  });

  it('renders a source badge on each candidate', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    renderPicker();
    await screen.findByTestId('cover-grid');
    expect(screen.getByTestId('cover-source-openlibrary:11')).toHaveTextContent(/openlibrary/i);
    expect(screen.getByTestId('cover-source-apple:22')).toHaveTextContent(/apple/i);
  });

  it('renders an error state with a retry button when the fetch fails', async () => {
    findCoverCandidates.mockRejectedValueOnce(new Error('upstream offline'));
    findCoverCandidates.mockResolvedValueOnce({ candidates: TWO_CANDIDATES });
    renderPicker();

    await screen.findByText(/upstream offline/i);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByTestId('cover-grid');
    expect(findCoverCandidates).toHaveBeenCalledTimes(2);
  });
});

describe('CoverPicker — pick flow (Search tab)', () => {
  it('calls api.setCover with the chosen candidateId, fires onPicked, and closes', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    setCover.mockResolvedValue({ coverImageUrl: '/api/books/bk_test/cover' });

    const { onClose, onPicked } = renderPicker();
    const tile = await screen.findByTestId('cover-candidate-apple:22');
    fireEvent.click(tile);

    await waitFor(() => expect(setCover).toHaveBeenCalledWith('bk_test', 'apple:22'));
    expect(onPicked).toHaveBeenCalledWith('/api/books/bk_test/cover');
    expect(onClose).toHaveBeenCalled();
  });

  it('surfaces a save error without closing so the user can retry', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    setCover.mockRejectedValue(new Error('download blew up'));

    const { onClose, onPicked } = renderPicker();
    const tile = await screen.findByTestId('cover-candidate-openlibrary:11');
    fireEvent.click(tile);

    await screen.findByText(/download blew up/i);
    expect(onPicked).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('CoverPicker — remove flow', () => {
  it('renders the Remove cover button only when currentCoverUrl is set', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    renderPicker();
    await screen.findByTestId('cover-grid');
    expect(screen.queryByRole('button', { name: /remove cover/i })).not.toBeInTheDocument();
  });

  it('renders Remove cover when currentCoverUrl is set, calls api.removeCover and emits empty string on click', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    removeCover.mockResolvedValue(undefined);

    const { onClose, onPicked } = renderPicker({ currentCoverUrl: '/api/books/bk_test/cover' });
    await screen.findByTestId('cover-grid');
    fireEvent.click(screen.getByRole('button', { name: /remove cover/i }));

    await waitFor(() => expect(removeCover).toHaveBeenCalledWith('bk_test'));
    expect(onPicked).toHaveBeenCalledWith('');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CoverPicker — closed state', () => {
  it('renders nothing when open=false and never calls the API', () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    render(
      <Provider store={makeStore()}>
        <CoverPicker
          open={false}
          bookId="bk_test"
          bookTitle="the Coalfall Commission"
          bookAuthor="Della Renwick"
          onClose={() => {}}
          onPicked={() => {}}
        />
      </Provider>,
    );
    expect(screen.queryByTestId('cover-picker')).not.toBeInTheDocument();
    expect(findCoverCandidates).not.toHaveBeenCalled();
  });
});

/* ---------- Plan 40 — tabs + upload + framing ---------- */

describe('CoverPicker — tabs (plan 40)', () => {
  it('renders all three tabs; Frame is disabled until a cover is pinned', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker();
    await screen.findByTestId('tab-search');
    expect(screen.getByTestId('tab-search')).toBeInTheDocument();
    expect(screen.getByTestId('tab-upload')).toBeInTheDocument();
    expect(screen.getByTestId('tab-frame')).toBeDisabled();
  });

  it('Frame tab is enabled when currentCoverUrl is set', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker({ currentCoverUrl: '/api/books/bk_test/cover' });
    await screen.findByTestId('tab-frame');
    expect(screen.getByTestId('tab-frame')).not.toBeDisabled();
  });

  it("honours the account's coverPickerDefaultTab='upload' setting on open", async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker({ defaultTab: 'upload' });
    /* Upload panel renders the dropzone; Search panel would render the
       grid or empty-state. */
    await screen.findByTestId('upload-dropzone');
    expect(screen.queryByTestId('cover-grid')).not.toBeInTheDocument();
  });

  it("defaults to Search when coverPickerDefaultTab is unset or 'search'", async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    renderPicker({ defaultTab: 'search' });
    await screen.findByTestId('cover-grid');
    expect(screen.queryByTestId('upload-dropzone')).not.toBeInTheDocument();
  });
});

describe('CoverPicker — Upload tab (plan 40)', () => {
  function makeFile(name: string, type: string, sizeBytes = 100): File {
    const blob = new Blob([new Uint8Array(sizeBytes)], { type });
    return new File([blob], name, { type });
  }

  it('uploads a JPEG and auto-switches to the Frame tab on success', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    uploadCover.mockResolvedValue({
      coverImageUrl: '/api/books/bk_test/cover',
      originalFilename: 'mine.jpg',
    });

    const { onPicked } = renderPicker({ defaultTab: 'upload' });
    const input = await screen.findByTestId('upload-input');

    const file = makeFile('mine.jpg', 'image/jpeg');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => expect(uploadCover).toHaveBeenCalledWith('bk_test', file));
    expect(onPicked).toHaveBeenCalledWith('/api/books/bk_test/cover');
    /* Auto-switch to Frame — preview should be in the DOM. */
    await screen.findByTestId('frame-preview');
  });

  it('rejects an unsupported MIME without firing api.uploadCover', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker({ defaultTab: 'upload' });
    const input = await screen.findByTestId('upload-input');

    const file = makeFile('x.gif', 'image/gif');
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(uploadCover).not.toHaveBeenCalled();
    expect(await screen.findByTestId('upload-error')).toHaveTextContent(/jpeg and png/i);
  });

  it('rejects oversize uploads (> 10 MB) client-side', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker({ defaultTab: 'upload' });
    const input = await screen.findByTestId('upload-input');

    const file = makeFile('big.jpg', 'image/jpeg', 11 * 1024 * 1024);
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    expect(uploadCover).not.toHaveBeenCalled();
    expect(await screen.findByTestId('upload-error')).toHaveTextContent(/10 mb/i);
  });
});

describe('CoverPicker — Frame tab (plan 40)', () => {
  /* Uses real timers + waitFor so we don't fight Testing Library's
     own polling. The 300 ms debounce + 1 s waitFor headroom is plenty. */
  it('fires debounced PATCH on zoom change with the new zoom value', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    patchCoverFraming.mockResolvedValue(undefined);

    const { onFramingChanged } = renderPicker({
      currentCoverUrl: '/api/books/bk_test/cover',
      currentFraming: { offsetX: 0, offsetY: 0, zoom: 1 },
    });

    fireEvent.click(screen.getByTestId('tab-frame'));
    const zoom = await screen.findByTestId('frame-zoom');
    fireEvent.change(zoom, { target: { value: '1.5' } });

    await waitFor(() => expect(patchCoverFraming).toHaveBeenCalled(), { timeout: 1500 });
    expect(patchCoverFraming).toHaveBeenCalledWith(
      'bk_test',
      expect.objectContaining({ zoom: 1.5 }),
    );
    await waitFor(() => expect(onFramingChanged).toHaveBeenCalled());
  });

  it('Reset framing button restores defaults via the same PATCH path', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    patchCoverFraming.mockResolvedValue(undefined);

    renderPicker({
      currentCoverUrl: '/api/books/bk_test/cover',
      currentFraming: { offsetX: 40, offsetY: -20, zoom: 1.8 },
    });

    fireEvent.click(screen.getByTestId('tab-frame'));
    fireEvent.click(await screen.findByTestId('frame-reset'));

    await waitFor(
      () =>
        expect(patchCoverFraming).toHaveBeenCalledWith('bk_test', {
          offsetX: 0,
          offsetY: 0,
          zoom: 1,
        }),
      { timeout: 1500 },
    );
  });
});
