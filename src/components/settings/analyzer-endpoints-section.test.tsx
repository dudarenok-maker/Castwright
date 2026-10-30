import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { accountSlice } from '../../store/account-slice';
import { uiSlice } from '../../store/ui-slice';
import { chaptersSlice } from '../../store/chapters-slice';
import { librarySlice } from '../../store/library-slice';
import { configSlice } from '../../store/config-slice';
import { AnalyzerEndpointsSection, slugifyEndpointId, splitEndpointIssues } from './analyzer-endpoints-section';
import { createAnalyzerEndpoint, deleteAnalyzerEndpoint } from '../../store/account-slice';
import { api, AnalyzerEndpointError, detectAnalyzerEndpointContext } from '../../lib/api';
import type { AnalyzerEndpoint } from '../../lib/types';

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return {
    AnalyzerEndpointError: actual.AnalyzerEndpointError,
    detectAnalyzerEndpointContext: vi.fn(),
    api: {
      getGpuDevices: vi.fn(),
      getAnalyzerModels: vi.fn(),
      previewAnalyzerEndpointModels: vi.fn(),
      createAnalyzerEndpoint: vi.fn(),
      updateAnalyzerEndpoint: vi.fn(),
      deleteAnalyzerEndpoint: vi.fn(),
      putAnalyzerEndpointKey: vi.fn(),
      putUserSettings: vi.fn(),
      testAnalyzerModel: vi.fn(),
    },
  };
});
vi.mock('../../store/queue-thunks', () => ({ haltActiveGeneration: vi.fn(() => ({ type: 'test/halt' })) }));

const LAB: AnalyzerEndpoint = {
  id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', concurrency: 1, requestCeilingMs: 1_800_000,
  structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default', maxOutputTokens: 0, contextTokens: 32768,
};

function renderSection(seed: { endpoints?: AnalyzerEndpoint[]; keyStatus?: Record<string, 'set' | 'unset' | 'origin-mismatch'> } = {}) {
  const store = configureStore({
    reducer: { account: accountSlice.reducer, ui: uiSlice.reducer, chapters: chaptersSlice.reducer, library: librarySlice.reducer, config: configSlice.reducer },
  });
  store.dispatch({ type: 'account/fetch/fulfilled', payload: { analyzerEndpoints: seed.endpoints ?? [], analyzerEndpointKeyStatus: seed.keyStatus ?? {} } });
  render(
    <Provider store={store}>
      <AnalyzerEndpointsSection />
    </Provider>,
  );
  return store;
}

const settingsWith = (endpoints: AnalyzerEndpoint[]) => ({ analyzerEndpoints: endpoints, analyzerEndpointKeyStatus: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getGpuDevices).mockResolvedValue({
    devices: [
      { uuid: 'GPU-0', idx: 0, name: 'RTX 4070 Laptop', total_mb: 8000, free_mb: 6000 },
      { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
    ],
    cpu: true,
  });
  vi.mocked(api.getAnalyzerModels).mockResolvedValue({ groups: [] });
});

describe('splitEndpointIssues (F5)', () => {
  it('splits a rejected thunk payload by path, and treats anything else as a plain message', () => {
    expect(
      splitEndpointIssues({ error: 'Invalid analyzer endpoint.', code: 'invalid', issues: [{ path: ['contextTokens'], message: 'Context size is required.' }, { path: [], message: 'Whole entry.' }] }),
    ).toEqual({ fieldErrors: { contextTokens: 'Context size is required.' }, rest: 'Invalid analyzer endpoint. Whole entry.' });
    expect(splitEndpointIssues(new Error('network down'))).toEqual({ fieldErrors: {}, rest: 'network down' });
  });
});

describe('slugifyEndpointId', () => {
  it('slugs the name and de-duplicates', () => {
    expect(slugifyEndpointId('Lab Server #2', [])).toBe('lab-server-2');
    expect(slugifyEndpointId('Lab', ['lab'])).toBe('lab-2');
    expect(slugifyEndpointId('!!!', [])).toBe('endpoint');
  });
});

describe('AnalyzerEndpointsSection (#3084)', () => {
  it('refuses to save without a context size', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByTestId('endpoint-context-error')).toBeInTheDocument();
    expect(api.createAnalyzerEndpoint).not.toHaveBeenCalled();
  });

  it('GPU defaults to any for a loopback host and none for a remote host; lists detected cards', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://localhost:8080/v1' } });
    expect(screen.getByTestId('endpoint-gpu')).toHaveValue('any');
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'https://openrouter.ai/api/v1' } });
    expect(screen.getByTestId('endpoint-gpu')).toHaveValue('none');
    await waitFor(() => expect(screen.getByRole('option', { name: /RTX 5070 Ti \(cuda:1\)/ })).toBeInTheDocument());
  });

  it('a card the user picked is kept when the base URL changes afterwards', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    await waitFor(() => expect(screen.getByRole('option', { name: /RTX 5070 Ti \(cuda:1\)/ })).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('endpoint-gpu'), { target: { value: 'cuda:1' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'https://openrouter.ai/api/v1' } });
    expect(screen.getByTestId('endpoint-gpu')).toHaveValue('cuda:1');
  });

  it('creates the endpoint, then writes the typed key bound to the saved base URL', async () => {
    vi.mocked(api.createAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    vi.mocked(api.putAnalyzerEndpointKey).mockResolvedValue(settingsWith([LAB]));
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-key'), { target: { value: 'sk-local' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.putAnalyzerEndpointKey).toHaveBeenCalledWith('lab', 'sk-local'));
    expect(vi.mocked(api.createAnalyzerEndpoint).mock.calls[0][0]).toMatchObject({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', contextTokens: 32768, gpu: 'any' });
    expect(vi.mocked(api.createAnalyzerEndpoint).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.putAnalyzerEndpointKey).mock.invocationCallOrder[0]);
  });

  it('#3710 M5 — when the key save fails after the endpoint was created, a retry updates it instead of creating lab-2', async () => {
    vi.mocked(api.createAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    vi.mocked(api.putAnalyzerEndpointKey).mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(settingsWith([LAB]));
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-key'), { target: { value: 'sk-local' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByTestId('endpoint-save-error')).toHaveTextContent('disk full');
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.putAnalyzerEndpointKey).toHaveBeenCalledTimes(2));
    expect(api.createAnalyzerEndpoint).toHaveBeenCalledTimes(1);
    expect(api.updateAnalyzerEndpoint).toHaveBeenCalledWith('lab', expect.objectContaining({ id: 'lab' }));
    expect(vi.mocked(api.putAnalyzerEndpointKey).mock.calls[1]).toEqual(['lab', 'sk-local']);
  });

  it('editing the host with a saved key prompts for the key and blocks Save until it is re-entered', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([{ ...LAB, baseUrl: 'http://10.0.0.5:8080/v1' }]));
    vi.mocked(api.putAnalyzerEndpointKey).mockResolvedValue(settingsWith([LAB]));
    renderSection({ endpoints: [LAB], keyStatus: { lab: 'set' } });
    fireEvent.click(screen.getByTestId('endpoint-edit-lab'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://10.0.0.5:8080/v1' } });
    expect(screen.getByTestId('endpoint-key-reentry')).toHaveTextContent(/re-enter the API key/i);
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(api.updateAnalyzerEndpoint).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('endpoint-key'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.putAnalyzerEndpointKey).toHaveBeenCalledWith('lab', 'sk-new'));
  });

  it('a changed host with no saved key needed saves without re-entering a key (noKey escape)', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([{ ...LAB, baseUrl: 'http://10.0.0.5:8080/v1' }]));
    vi.mocked(api.putAnalyzerEndpointKey).mockResolvedValue(settingsWith([LAB]));
    renderSection({ endpoints: [LAB], keyStatus: { lab: 'set' } });
    fireEvent.click(screen.getByTestId('endpoint-edit-lab'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://10.0.0.5:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-no-key'));
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.updateAnalyzerEndpoint).toHaveBeenCalledWith('lab', expect.objectContaining({ baseUrl: 'http://10.0.0.5:8080/v1' })));
    expect(api.putAnalyzerEndpointKey).toHaveBeenCalledWith('lab', null);
  });

  it('#3710 M6 — the Detect selects and the needs-no-key checkbox carry the 44px coarse-pointer target', () => {
    renderSection({ endpoints: [LAB], keyStatus: { lab: 'set' } });
    fireEvent.click(screen.getByTestId('endpoint-edit-lab'));
    for (const id of ['endpoint-detect-flavor', 'endpoint-detect-model']) {
      expect(screen.getByTestId(id).className, id).toContain('min-h-[44px] fine-pointer:min-h-0');
    }
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://10.0.0.5:8080/v1' } });
    const row = screen.getByTestId('endpoint-no-key').closest('label');
    expect(row?.className).toContain('min-h-[44px] fine-pointer:min-h-0');
  });

  it('refuses an unload URL on another origin', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-unload-url'), { target: { value: 'http://127.0.0.1:9999/api/models/unload/{model}' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByText(/must use the same host and port as the base URL/i)).toBeInTheDocument();
    expect(api.createAnalyzerEndpoint).not.toHaveBeenCalled();
  });

  it('an unload URL without {model} saves, with a warning that it unloads every model on that server (P12)', async () => {
    vi.mocked(api.createAnalyzerEndpoint).mockResolvedValue(settingsWith([{ ...LAB, unloadUrl: 'http://127.0.0.1:8080/api/models/unload' }]));
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-unload-url'), { target: { value: 'http://127.0.0.1:8080/api/models/unload/{model}' } });
    expect(screen.queryByTestId('endpoint-unload-all-warning')).toBeNull();
    fireEvent.change(screen.getByTestId('endpoint-unload-url'), { target: { value: 'http://127.0.0.1:8080/api/models/unload' } });
    expect(screen.getByTestId('endpoint-unload-all-warning')).toHaveTextContent(/every model on that server/i);
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.createAnalyzerEndpoint).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.createAnalyzerEndpoint).mock.calls[0][0]).toMatchObject({ unloadUrl: 'http://127.0.0.1:8080/api/models/unload' });
  });

  it('List models prefills the smallest served context only when the field is empty', async () => {
    vi.mocked(api.previewAnalyzerEndpointModels).mockResolvedValue({ status: 'ok', models: [{ model: 'a', contextTokens: 32768 }, { model: 'b', contextTokens: 8192 }], suggestedContextTokens: 8192 });
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-list-models'));
    await waitFor(() => expect(screen.getByTestId('endpoint-context-tokens')).toHaveValue(8192));
  });

  it('a llama-swap Detect for a model asks before it may load the model, then sends allowModelLoad', async () => {
    vi.mocked(api.previewAnalyzerEndpointModels).mockResolvedValue({ status: 'ok', models: [{ model: 'qwen3-30b' }] });
    vi.mocked(detectAnalyzerEndpointContext).mockResolvedValue({ contextTokens: 40960, source: 'llama-swap /props' });
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.click(screen.getByTestId('endpoint-list-models'));
    await screen.findByRole('option', { name: 'qwen3-30b' });
    fireEvent.change(screen.getByTestId('endpoint-detect-flavor'), { target: { value: 'llama-swap' } });
    fireEvent.change(screen.getByTestId('endpoint-detect-model'), { target: { value: 'qwen3-30b' } });
    fireEvent.click(screen.getByTestId('endpoint-detect'));
    expect(screen.getByText(/may load qwen3-30b on the server/i)).toBeInTheDocument();
    expect(detectAnalyzerEndpointContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Detect anyway' }));
    await waitFor(() =>
      expect(detectAnalyzerEndpointContext).toHaveBeenCalledWith(expect.objectContaining({ flavor: 'llama-swap', model: 'qwen3-30b', allowModelLoad: true })),
    );
    await waitFor(() => expect(screen.getByTestId('endpoint-context-tokens')).toHaveValue(40960));
  });

  /* The two refusal cases below fake only the HTTP client, whose own throw is AnalyzerEndpointError
     (3b Task 3b.9). The thunks are the real 3b thunks: each first dispatches its thunk and
     `.unwrap()`s it, pinning that the rejection reaching the component is the plain
     `{ error, code, issues }` payload, then drives the component, which reads only that payload. */
  it('a delete refused because settings still reference the endpoint shows the references', async () => {
    const refusal = { error: 'Analyzer endpoint "lab" is still used by 1 saved setting(s).', code: 'referenced', issues: [{ path: [], message: 'Account setting "defaultAnalysisModel"' }] };
    vi.mocked(api.deleteAnalyzerEndpoint).mockRejectedValue(new AnalyzerEndpointError(409, refusal.code, refusal.error, refusal.issues));
    const store = renderSection({ endpoints: [LAB] });
    const rejected = await store.dispatch(deleteAnalyzerEndpoint('lab')).unwrap().catch((e: unknown) => e);
    expect(rejected).toEqual(refusal);
    expect(rejected).not.toBeInstanceOf(AnalyzerEndpointError);
    fireEvent.click(screen.getByTestId('endpoint-delete-lab'));
    expect(await screen.findByTestId('endpoint-row-error-lab')).toHaveTextContent('Account setting "defaultAnalysisModel"');
  });

  /* The two field messages are the server's real strings, copied verbatim from 3b's exported
     `friendlyEndpointIssueMessage(path, issue)` (w3ab Task 3b.5): `baseUrl` + `invalid_format` (zod
     4.4.3's code for a `.url()` failure) and `concurrency` + `too_big` at the schema maximum 16. A
     frontend test cannot import server code, so a change to that map must be copied here too. */
  it('a 400 refusal shows each issue next to its field, the rest under Save, and writes no key (F5)', async () => {
    const refusal = {
      error: 'Invalid analyzer endpoint.',
      code: 'invalid',
      issues: [
        { path: ['baseUrl'], message: 'Base URL must be a valid URL, e.g. http://127.0.0.1:8080/v1.' },
        { path: ['concurrency'], message: 'Concurrency must be at most 16.' },
        { path: [], message: 'The entry could not be read as a whole.' },
      ],
    };
    vi.mocked(api.createAnalyzerEndpoint).mockRejectedValue(new AnalyzerEndpointError(400, refusal.code, refusal.error, refusal.issues));
    const store = renderSection();
    expect(await store.dispatch(createAnalyzerEndpoint({ ...LAB })).unwrap().catch((e: unknown) => e)).toEqual(refusal);
    vi.mocked(api.createAnalyzerEndpoint).mockClear();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    fireEvent.change(screen.getByTestId('endpoint-name'), { target: { value: 'Lab' } });
    fireEvent.change(screen.getByTestId('endpoint-base-url'), { target: { value: 'http://127.0.0.1:8080/v1' } });
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '32768' } });
    fireEvent.change(screen.getByTestId('endpoint-key'), { target: { value: 'sk-local' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    const baseUrlRow = screen.getByTestId('endpoint-base-url').closest('label')!;
    expect(await within(baseUrlRow).findByText('Base URL must be a valid URL, e.g. http://127.0.0.1:8080/v1.')).toBeInTheDocument();
    expect(within(screen.getByTestId('endpoint-concurrency').closest('label')!).getByText('Concurrency must be at most 16.')).toBeInTheDocument();
    expect(screen.getByTestId('endpoint-save-error')).toHaveTextContent('Invalid analyzer endpoint. The entry could not be read as a whole.');
    expect(screen.getByTestId('endpoint-save-error')).not.toHaveTextContent('http or https');
    expect(api.putAnalyzerEndpointKey).not.toHaveBeenCalled();
  });

  it('the context size and max input help say how they set the chunk size (P32), and neither field is disabled', () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    expect(screen.getByText(/input fraction \(Advanced Settings → Analyzer chunking\) × this × 2 characters per token, capped by the pass ceiling/)).toBeInTheDocument();
    expect(screen.getByText(/or this endpoint's TPM limit, whichever is smaller/)).toBeInTheDocument();
    expect(screen.getByTestId('endpoint-context-tokens')).toBeEnabled();
    expect(screen.getByTestId('endpoint-max-input-tokens')).toBeEnabled();
  });

  it('a free-text model id becomes the default analysis model', async () => {
    vi.mocked(api.putUserSettings).mockImplementation(async (patch) => patch as never);
    renderSection({ endpoints: [LAB] });
    fireEvent.change(screen.getByTestId('endpoint-free-model-lab'), { target: { value: 'qwen3-30b-a3b' } });
    fireEvent.click(screen.getByTestId('endpoint-use-free-model-lab'));
    await waitFor(() => expect(api.putUserSettings).toHaveBeenCalledWith({ defaultAnalysisModel: 'openai:lab::qwen3-30b-a3b', analysisEngine: 'openai' }));
  });

  it('shows the dropped entries banner above the endpoints (P31)', () => {
    const store = renderSection({ endpoints: [LAB] });
    store.dispatch({
      type: 'account/fetch/fulfilled',
      payload: { droppedEndpointEntries: [{ archiveId: 'a1', kind: 'endpoint', name: 'Old box', issues: ['analyzerEndpoints.1.baseUrl: invalid_format'], droppedAt: '2026-09-13T10:00:00.000Z' }] },
    });
    return waitFor(() => expect(screen.getByTestId('analyzer-endpoints-section').firstElementChild).toHaveAttribute('data-testid', 'dropped-endpoint-banner'));
  });

  it("a fix deep link opens that endpoint's editor with the field focused (P34)", async () => {
    const store = renderSection({ endpoints: [LAB] });
    store.dispatch(uiSlice.actions.openModelManager({ endpointId: 'lab', endpointField: 'contextTokens' }));
    expect(await screen.findByTestId('endpoint-editor')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('endpoint-context-tokens')).toHaveFocus());
    expect(screen.getByTestId('endpoint-context-tokens')).toHaveValue(32768);
  });

  it('a deep link is handled once: a later settings refresh does not reopen the editor over edits (P34)', async () => {
    const store = renderSection({ endpoints: [LAB] });
    store.dispatch(uiSlice.actions.openModelManager({ endpointId: 'lab', endpointField: 'contextTokens' }));
    await screen.findByTestId('endpoint-editor');
    fireEvent.change(screen.getByTestId('endpoint-context-tokens'), { target: { value: '16384' } });
    await act(async () => {
      store.dispatch({ type: 'account/fetch/fulfilled', payload: { analyzerEndpoints: [{ ...LAB }] } });
    });
    expect(screen.getByTestId('endpoint-context-tokens')).toHaveValue(16384);
  });

  it('a deep link to an endpoint that is not saved opens nothing (P34)', async () => {
    const store = renderSection({ endpoints: [LAB] });
    await act(async () => {
      store.dispatch(uiSlice.actions.openModelManager({ endpointId: 'gone', endpointField: 'contextTokens' }));
    });
    expect(screen.queryByTestId('endpoint-editor')).toBeNull();
  });

  it('links to the endpoints setup guide on the wiki (P33)', () => {
    renderSection();
    expect(screen.getByRole('link', { name: /Setup guide for each server/ })).toHaveAttribute(
      'href',
      'https://github.com/dudarenok-maker/Castwright/wiki/OpenAI-Compatible-Analyzer-Endpoints',
    );
  });
});

describe('endpoint form — reasoning fields', () => {
  it('offers only the selected control style levels and resets an orphaned level', async () => {
    renderSection();
    fireEvent.click(screen.getByTestId('add-endpoint'));
    const style = screen.getByTestId('endpoint-reasoning-style');
    fireEvent.change(style, { target: { value: 'enable_thinking' } });
    const reasoning = screen.getByTestId('endpoint-reasoning') as HTMLSelectElement;
    expect([...reasoning.options].map((o) => o.value)).toEqual(['model-default', 'off', 'on']);
    fireEvent.change(reasoning, { target: { value: 'on' } });
    fireEvent.change(style, { target: { value: 'reasoning_effort' } });
    expect((screen.getByTestId('endpoint-reasoning') as HTMLSelectElement).value).toBe('model-default');
    expect([...(screen.getByTestId('endpoint-reasoning') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['model-default', 'none', 'minimal', 'low', 'medium', 'high']);
    expect(screen.getByText(/A server may accept a level and still ignore it/)).toBeInTheDocument();
    /* Back to the first style: an orphaned `on` would resurface here (a select with no matching option only displays its first one). */
    fireEvent.change(style, { target: { value: 'enable_thinking' } });
    expect((screen.getByTestId('endpoint-reasoning') as HTMLSelectElement).value).toBe('model-default');
  });

  it('a stored level the control style does not offer is shown and can be changed to Model default', async () => {
    renderSection({ endpoints: [{ ...LAB, reasoningStyle: 'enable_thinking', reasoning: 'high' }] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    const reasoning = screen.getByTestId('endpoint-reasoning') as HTMLSelectElement;
    expect(reasoning.value).toBe('high');
    expect([...reasoning.options].map((o) => o.value)).toEqual(['model-default', 'off', 'on', 'high']);
    fireEvent.change(reasoning, { target: { value: 'model-default' } });
    expect(reasoning.value).toBe('model-default');
  });

  it('a reasoning-overflow fix deep link focuses the endpoint reasoning field (#3084 wave 5a)', async () => {
    const store = renderSection({ endpoints: [LAB] });
    store.dispatch(uiSlice.actions.openModelManager({ endpointId: 'lab', endpointField: 'reasoning' }));
    expect(await screen.findByTestId('endpoint-editor')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('endpoint-reasoning')).toHaveFocus());
  });

  it('a refusal at path reasoning shows under the Reasoning field, not the general error', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockRejectedValue(
      new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', [{ path: ['reasoning'], message: 'Level "high" is not offered for this control style.' }]),
    );
    renderSection({ endpoints: [LAB] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByText('Level "high" is not offered for this control style.')).toBeInTheDocument();
    expect(screen.queryByTestId('endpoint-save-error')?.textContent ?? '').not.toContain('not offered');
  });
});

describe('endpoint form — touch targets', () => {
  it.each(['endpoint-name', 'endpoint-context-tokens', 'endpoint-reasoning-style', 'endpoint-reasoning', 'endpoint-extra-params'])(
    '%s meets the 44px touch target on touch devices (CLAUDE.md mobile protocol)',
    (testId) => {
      renderSection();
      fireEvent.click(screen.getByTestId('add-endpoint'));
      expect(screen.getByTestId(testId)).toHaveClass('min-h-[44px]', 'fine-pointer:min-h-0');
    },
  );
});

describe('endpoint form — custom payload (#3084 wave 5b)', () => {
  it('shows a JSON error under the field and refuses the save while it is invalid; says it is not a place for credentials', async () => {
    renderSection({ endpoints: [LAB] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    fireEvent.change(screen.getByTestId('endpoint-extra-params'), { target: { value: '{bad' } });
    expect(screen.getByTestId('endpoint-extra-params-error')).toHaveTextContent('Not valid JSON.');
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(api.updateAnalyzerEndpoint).not.toHaveBeenCalled();
    expect(screen.getByText(/Not a place for credentials: put this endpoint key in the API key field/)).toBeInTheDocument(); // P29
  });

  it('sends the parsed payload, never the draft text; an untouched edit re-sends the saved payload', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    renderSection({ endpoints: [{ ...LAB, extraParams: { top_k: 20 } }] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    expect(screen.getByTestId('endpoint-extra-params')).toHaveValue(JSON.stringify({ top_k: 20 }, null, 2));
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.updateAnalyzerEndpoint).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(api.updateAnalyzerEndpoint).mock.calls[0][1];
    expect(sent).toMatchObject({ extraParams: { top_k: 20 } });
    expect(sent).not.toHaveProperty('extraParamsText');
  });

  it('a blank field sends no payload, so the saved one is cleared', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    renderSection({ endpoints: [{ ...LAB, extraParams: { top_k: 20 } }] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    fireEvent.change(screen.getByTestId('endpoint-extra-params'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.updateAnalyzerEndpoint).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateAnalyzerEndpoint).mock.calls[0][1]).not.toHaveProperty('extraParams');
  });

  it('sits full width, outside the two-column grid (5b-D6)', async () => {
    renderSection({ endpoints: [LAB] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    expect(screen.getByTestId('endpoint-extra-params').closest('.grid')).toBeNull();
    expect(screen.getByTestId('endpoint-max-output-tokens').closest('.grid')).not.toBeNull();
  });

  it("a payload-fix deep link focuses the endpoint's Custom parameters field", async () => {
    const store = renderSection({ endpoints: [LAB] });
    store.dispatch(uiSlice.actions.openModelManager({ endpointId: 'lab', endpointField: 'extraParams' }));
    expect(await screen.findByTestId('endpoint-editor')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('endpoint-extra-params')).toHaveFocus());
  });

  it('a refusal at path extraParams shows under the Custom parameters field, not the general error', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockRejectedValue(
      new AnalyzerEndpointError(400, 'invalid', 'Invalid analyzer endpoint.', [
        { path: ['extraParams'], message: 'These keys are controlled by Castwright and cannot be set here: response_format.' },
      ]),
    );
    renderSection({ endpoints: [LAB] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    fireEvent.click(screen.getByTestId('endpoint-save'));
    expect(await screen.findByTestId('endpoint-extra-params-error')).toHaveTextContent('cannot be set here: response_format');
    expect(screen.queryByTestId('endpoint-save-error')?.textContent ?? '').not.toContain('cannot be set here');
  });

  it("a refused save's JSON error clears once the field is edited to valid JSON", async () => {
    renderSection({ endpoints: [LAB] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    const field = screen.getByTestId('endpoint-extra-params');
    fireEvent.change(field, { target: { value: '{bad' } });
    fireEvent.click(screen.getByTestId('endpoint-save')); // save() sets errors.extraParams from validateEndpointDraft
    expect(screen.getByTestId('endpoint-extra-params-error')).toHaveTextContent('Not valid JSON.');
    fireEvent.change(field, { target: { value: '{"top_k": 20}' } });
    expect(screen.queryByTestId('endpoint-extra-params-error')).toBeNull();
  });

  it('a payload that sets the cap makes Max output tokens read-only with a note, and its saved value is still sent (5b-D5)', async () => {
    vi.mocked(api.updateAnalyzerEndpoint).mockResolvedValue(settingsWith([LAB]));
    renderSection({ endpoints: [{ ...LAB, maxOutputTokens: 8192 }] });
    fireEvent.click(await screen.findByTestId('endpoint-edit-lab'));
    const maxOutput = screen.getByTestId('endpoint-max-output-tokens');
    const payload = screen.getByTestId('endpoint-extra-params');
    fireEvent.change(payload, { target: { value: '{"top_k": 40}' } });
    expect(maxOutput).not.toHaveAttribute('readonly');
    expect(screen.queryByTestId('endpoint-max-output-controlled')).toBeNull();
    fireEvent.change(payload, { target: { value: '{"max_completion_tokens": 4096}' } });
    expect(maxOutput).toHaveAttribute('readonly');
    expect(maxOutput).toHaveValue(8192);
    expect(maxOutput).toHaveClass('min-h-[44px]', 'fine-pointer:min-h-0');
    expect(screen.getByTestId('endpoint-max-output-controlled')).toHaveTextContent('Ignored while custom parameters set the output cap.');
    fireEvent.click(screen.getByTestId('endpoint-save'));
    await waitFor(() => expect(api.updateAnalyzerEndpoint).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.updateAnalyzerEndpoint).mock.calls[0][1]).toMatchObject({ maxOutputTokens: 8192, extraParams: { max_completion_tokens: 4096 } });
  });
});
