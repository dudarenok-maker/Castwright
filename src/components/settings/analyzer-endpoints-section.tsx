/* #3084 W3d — Model Manager → Analyzer endpoints. Named OpenAI Chat Completions-
   compatible servers (llama.cpp / llama-swap, LM Studio, vLLM, LiteLLM, OpenRouter…).
   Context size is required and only prefilled from served values; keys bind to the base
   URL's origin; the GPU card drives guards and TTS eviction; nothing probes on its own. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  createAnalyzerEndpoint,
  deleteAnalyzerEndpoint,
  fetchAnalyzerCatalog,
  saveAccountSettings,
  saveAnalyzerEndpointKey,
  updateAnalyzerEndpoint,
  type AnalyzerEndpointRejection,
} from '../../store/account-slice';
import { api, detectAnalyzerEndpointContext, AnalyzerEndpointError } from '../../lib/api';
import { defaultGpuForBaseUrl } from '../../lib/analyzer-endpoints';
import { endpointModelId, engineForModelId } from '../../lib/model-id';
import { modelLabel } from '../../lib/model-label';
import type { AnalyzerEndpoint, AnalyzerEndpointInput, AnalyzerEndpointModelsPreview, GpuDevice } from '../../lib/types';
import { ConfirmDialog } from '../../modals/confirm-dialog';
import { FieldRow } from '../account-forms';
import { REASONING_HELP, REASONING_LEVEL_LABELS, REASONING_STYLE_LABELS, levelsForEndpointStyle, type ReasoningLevel, type ReasoningStyle } from '../../lib/reasoning-levels';
import { WikiLink } from '../wiki-link';
import { ADMIN_WIKI } from '../../lib/wiki-links';
import { DroppedEndpointEntriesBanner } from './dropped-endpoint-entries-banner';
import { ModelTestButton } from './model-test-button';

type Mode = AnalyzerEndpoint['structuredOutput'];

export interface EndpointDraft {
  id: string;
  name: string;
  baseUrl: string;
  gpu: string;
  gpuTouched: boolean;
  unloadUrl: string;
  concurrency: string;
  ceilingMinutes: string;
  structuredOutput: Mode;
  reasoningStyle: ReasoningStyle;
  reasoning: ReasoningLevel;
  maxOutputTokens: string;
  contextTokens: string;
  maxInputTokensPerRequest: string;
  key: string;
  noKey: boolean;
}

/** Form fields a save refusal's `issues[].path[0]` can name (the endpoint schema's editable fields). */
const ISSUE_FIELDS = ['name', 'baseUrl', 'gpu', 'unloadUrl', 'concurrency', 'requestCeilingMs', 'structuredOutput', 'reasoningStyle', 'reasoning', 'maxOutputTokens', 'contextTokens', 'maxInputTokensPerRequest'] as const;
type IssueField = (typeof ISSUE_FIELDS)[number];
type DraftErrors = Partial<Record<IssueField | 'key', string>>;

/** The control each endpoint field renders as. Task 3d.8b focuses it from a fix deep link (P34). */
export const ENDPOINT_FIELD_TEST_IDS: Record<IssueField, string> = {
  name: 'endpoint-name',
  baseUrl: 'endpoint-base-url',
  gpu: 'endpoint-gpu',
  unloadUrl: 'endpoint-unload-url',
  concurrency: 'endpoint-concurrency',
  requestCeilingMs: 'endpoint-ceiling-minutes',
  structuredOutput: 'endpoint-structured-output',
  reasoningStyle: 'endpoint-reasoning-style',
  reasoning: 'endpoint-reasoning',
  maxOutputTokens: 'endpoint-max-output-tokens',
  contextTokens: 'endpoint-context-tokens',
  maxInputTokensPerRequest: 'endpoint-max-input-tokens',
};

const INPUT = 'w-full px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30 min-h-[44px] fine-pointer:min-h-0';

export function slugifyEndpointId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'endpoint';
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function draftFrom(e: AnalyzerEndpoint | null): EndpointDraft {
  return {
    id: e?.id ?? '',
    name: e?.name ?? '',
    baseUrl: e?.baseUrl ?? '',
    gpu: e?.gpu ?? 'none',
    gpuTouched: e !== null,
    unloadUrl: e?.unloadUrl ?? '',
    concurrency: String(e?.concurrency ?? 1),
    ceilingMinutes: String(Math.round((e?.requestCeilingMs ?? 1_800_000) / 60_000)),
    structuredOutput: e?.structuredOutput ?? 'schema',
    reasoningStyle: e?.reasoningStyle ?? 'not_controllable',
    reasoning: (e?.reasoning as ReasoningLevel | undefined) ?? 'model-default',
    maxOutputTokens: String(e?.maxOutputTokens ?? 0),
    contextTokens: e ? String(e.contextTokens) : '',
    maxInputTokensPerRequest: e?.maxInputTokensPerRequest ? String(e.maxInputTokensPerRequest) : '',
    key: '',
    noKey: false,
  };
}

export function validateEndpointDraft(
  d: EndpointDraft,
  original: AnalyzerEndpoint | null,
  keyStatus: 'set' | 'unset' | 'origin-mismatch' | undefined,
): { errors: DraftErrors; input: AnalyzerEndpointInput | null; hostChanged: boolean } {
  const errors: DraftErrors = {};
  if (d.name.trim() === '') errors.name = 'Give the endpoint a name.';
  const origin = originOf(d.baseUrl.trim());
  if (!origin) errors.baseUrl = 'Enter the server base URL, e.g. http://127.0.0.1:8080/v1.';
  const context = Number.parseInt(d.contextTokens, 10);
  if (!Number.isInteger(context) || context < 512) {
    errors.contextTokens = 'Enter the context size your server actually serves (tokens). Use List models or Detect to fill it.';
  }
  if (d.unloadUrl.trim() !== '' && originOf(d.unloadUrl.trim()) !== origin) {
    errors.unloadUrl = 'The unload URL must use the same host and port as the base URL.';
  }
  const hostChanged = original !== null && origin !== null && originOf(original.baseUrl) !== origin && keyStatus !== undefined && keyStatus !== 'unset';
  if (hostChanged && d.key.trim() === '' && !d.noKey) {
    errors.key = `The host changed — re-enter the API key for ${original?.name}. The saved key is only sent to ${originOf(original?.baseUrl ?? '')}.`;
  }
  if (Object.keys(errors).length > 0) return { errors, input: null, hostChanged };
  const maxInput = Number.parseInt(d.maxInputTokensPerRequest, 10);
  const input: AnalyzerEndpointInput = {
    id: d.id,
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim(),
    gpu: d.gpu,
    ...(d.unloadUrl.trim() !== '' ? { unloadUrl: d.unloadUrl.trim() } : {}),
    concurrency: Math.min(16, Math.max(1, Number.parseInt(d.concurrency, 10) || 1)),
    requestCeilingMs: Math.min(240, Math.max(1, Number.parseInt(d.ceilingMinutes, 10) || 30)) * 60_000,
    structuredOutput: d.structuredOutput,
    reasoningStyle: d.reasoningStyle,
    reasoning: d.reasoning,
    maxOutputTokens: Math.max(0, Number.parseInt(d.maxOutputTokens, 10) || 0),
    contextTokens: context,
    ...(Number.isInteger(maxInput) && maxInput >= 256 ? { maxInputTokensPerRequest: maxInput } : {}),
    ...(original?.extraParams ? { extraParams: original.extraParams } : {}),
  };
  return { errors, input, hostChanged };
}

/** 3b's endpoint thunks are typed `{ rejectValue: AnalyzerEndpointRejection }`, so this is what
    `.unwrap()` throws. The guard stays because a thunk can still reject with a serialised error. */
function isRefusalPayload(v: unknown): v is AnalyzerEndpointRejection {
  return typeof v === 'object' && v !== null && typeof (v as { error?: unknown }).error === 'string' && Array.isArray((v as { issues?: unknown }).issues);
}

function refusalText(err: unknown): string {
  if (isRefusalPayload(err)) return [err.error, ...err.issues.map((i) => i.message)].join(' ');
  /* Detect calls the client directly (no thunk), so it still surfaces the class. */
  if (err instanceof AnalyzerEndpointError) return [err.message, ...err.issues.map((i) => i.message)].join(' ');
  return (err as { message?: string }).message ?? 'The request failed.';
}

/** F5 — a rejected save's issues (`AnalyzerEndpointRejection`): those naming a form field go next
    to it, the rest under Save. Accepts `unknown`, since a `catch` binding is untyped. */
export function splitEndpointIssues(err: AnalyzerEndpointRejection | unknown): { fieldErrors: DraftErrors; rest: string } {
  if (!isRefusalPayload(err)) return { fieldErrors: {}, rest: refusalText(err) };
  const fieldErrors: DraftErrors = {};
  const other: string[] = [];
  for (const issue of err.issues) {
    const field = issue.path[0];
    if (field !== undefined && (ISSUE_FIELDS as readonly string[]).includes(field)) {
      const key = field as IssueField;
      fieldErrors[key] = fieldErrors[key] ? `${fieldErrors[key]} ${issue.message}` : issue.message;
    } else {
      other.push(issue.message);
    }
  }
  return { fieldErrors, rest: [err.error, ...other].join(' ') };
}

/* A stable fallback, so a missing slice field does not hand useMemo a new object every render. */
const NO_ENDPOINTS: AnalyzerEndpoint[] = [];
const NO_KEY_STATUS: Record<string, 'set' | 'unset' | 'origin-mismatch'> = {};

export function AnalyzerEndpointsSection() {
  const dispatch = useAppDispatch();
  const endpoints = useAppSelector((s) => s.account.analyzerEndpoints) ?? NO_ENDPOINTS;
  const keyStatus = useAppSelector((s) => s.account.analyzerEndpointKeyStatus) ?? NO_KEY_STATUS;
  const catalog = useAppSelector((s) => s.account.analyzerCatalog);
  const [devices, setDevices] = useState<GpuDevice[]>([]);
  const [editing, setEditing] = useState<AnalyzerEndpoint | null | undefined>(undefined); // undefined = closed, null = new
  const [draft, setDraft] = useState<EndpointDraft>(draftFrom(null));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AnalyzerEndpointModelsPreview | null>(null);
  const [detectFlavor, setDetectFlavor] = useState<'llama.cpp' | 'llama-swap'>('llama.cpp');
  const [detectModel, setDetectModel] = useState('');
  const [confirmLoad, setConfirmLoad] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [freeModels, setFreeModels] = useState<Record<string, string>>({});

  useEffect(() => {
    void api.getGpuDevices().then((r) => setDevices(r.devices)).catch(() => setDevices([]));
  }, []);

  const hostChanged = useMemo(
    () => editing != null && originOf(editing.baseUrl) !== originOf(draft.baseUrl) && (keyStatus[editing.id] ?? 'unset') !== 'unset',
    [editing, draft.baseUrl, keyStatus],
  );

  const open = (endpoint: AnalyzerEndpoint | null) => {
    setEditing(endpoint);
    setDraft(draftFrom(endpoint));
    setErrors({});
    setSaveError(null);
    setPreview(null);
    setDetectNote(null);
  };

  /* #3084 P34 — a "How to fix" link opens #/models?endpoint=<id>&field=<field>: open that editor
     once the endpoint is loaded and focus the field. Each link is handled once, so a later
     settings refresh never reopens the editor over the user's edits. */
  const stage = useAppSelector((s) => s.ui.stage);
  const focusEndpointId = stage.kind === 'model-manager' ? stage.endpointId : undefined;
  const focusField = stage.kind === 'model-manager' ? stage.endpointField : undefined;
  const handledFocus = useRef('');
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  useEffect(() => {
    const key = focusEndpointId ? `${focusEndpointId}|${focusField ?? ''}` : '';
    if (!key || handledFocus.current === key) return;
    const endpoint = endpoints.find((e) => e.id === focusEndpointId);
    if (!endpoint) return;
    handledFocus.current = key;
    open(endpoint);
    setPendingFocus(focusField && focusField in ENDPOINT_FIELD_TEST_IDS ? ENDPOINT_FIELD_TEST_IDS[focusField as IssueField] : null);
  }, [focusEndpointId, focusField, endpoints]);
  useEffect(() => {
    if (!pendingFocus || editing === undefined) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="${pendingFocus}"]`);
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
    setPendingFocus(null);
  }, [pendingFocus, editing]);

  const set = <K extends keyof EndpointDraft>(key: K, value: EndpointDraft[K]) =>
    setDraft((d) => {
      const next = { ...d, [key]: value };
      if (key === 'baseUrl' && !d.gpuTouched) next.gpu = defaultGpuForBaseUrl(String(value));
      if (key === 'gpu') next.gpuTouched = true;
      return next;
    });

  const save = async () => {
    const withId = editing ? draft : { ...draft, id: slugifyEndpointId(draft.name, endpoints.map((e) => e.id)) };
    const result = validateEndpointDraft(withId, editing ?? null, editing ? keyStatus[editing.id] : undefined);
    setErrors(result.errors);
    if (!result.input) return;
    setSaveError(null);
    let created: AnalyzerEndpoint | undefined;
    try {
      if (editing) await dispatch(updateAnalyzerEndpoint({ endpointId: editing.id, input: result.input })).unwrap();
      else {
        const settings = await dispatch(createAnalyzerEndpoint(result.input)).unwrap();
        created = settings.analyzerEndpoints?.find((e) => e.id === withId.id);
      }
      if (withId.key.trim() !== '') {
        await dispatch(saveAnalyzerEndpointKey({ endpointId: result.input.id, key: withId.key.trim() })).unwrap();
      } else if (result.hostChanged && withId.noKey) {
        await dispatch(saveAnalyzerEndpointKey({ endpointId: result.input.id, key: null })).unwrap();
      }
      setEditing(undefined);
      void dispatch(fetchAnalyzerCatalog({ refresh: true }));
    } catch (err) {
      /* #3710 M5 — the endpoint exists now: a retry must update it, not slug a second one (lab-2). */
      if (created) {
        const madeId = created.id;
        setEditing(created);
        setDraft((d) => ({ ...d, id: madeId }));
      }
      const { fieldErrors, rest } = splitEndpointIssues(err);
      setErrors(fieldErrors);
      setSaveError(rest);
    }
  };

  const listModels = async () => {
    const out = await api.previewAnalyzerEndpointModels({
      baseUrl: draft.baseUrl.trim(),
      ...(editing ? { endpointId: editing.id } : {}),
      ...(draft.key.trim() !== '' ? { apiKey: draft.key.trim() } : {}),
    });
    setPreview(out);
    if (out.suggestedContextTokens && draft.contextTokens.trim() === '') set('contextTokens', String(out.suggestedContextTokens));
  };

  const runDetect = async (allowModelLoad: boolean) => {
    setDetectNote(null);
    try {
      const out = await detectAnalyzerEndpointContext({
        baseUrl: draft.baseUrl.trim(),
        flavor: detectFlavor,
        ...(detectModel ? { model: detectModel } : {}),
        ...(editing ? { endpointId: editing.id } : {}),
        ...(draft.key.trim() !== '' ? { apiKey: draft.key.trim() } : {}),
        ...(allowModelLoad ? { allowModelLoad: true } : {}),
      });
      set('contextTokens', String(out.contextTokens));
      setDetectNote(`Detected ${out.contextTokens.toLocaleString()} tokens from ${out.source}.`);
    } catch (err) {
      setDetectNote(refusalText(err));
    }
  };

  const onDetect = () => {
    if (detectFlavor === 'llama-swap' && detectModel) setConfirmLoad(true);
    else void runDetect(false);
  };

  const remove = async (id: string) => {
    setRowErrors((r) => ({ ...r, [id]: '' }));
    try {
      await dispatch(deleteAnalyzerEndpoint(id)).unwrap();
    } catch (err) {
      setRowErrors((r) => ({ ...r, [id]: refusalText(err) }));
    }
  };

  const useFreeModel = (id: string) => {
    const model = (freeModels[id] ?? '').trim();
    if (model === '') return;
    const modelId = endpointModelId(id, model);
    void dispatch(saveAccountSettings({ defaultAnalysisModel: modelId, analysisEngine: engineForModelId(modelId) }));
  };

  return (
    <div data-testid="analyzer-endpoints-section" className="space-y-4">
      <DroppedEndpointEntriesBanner />
      <WikiLink page={ADMIN_WIKI.analyzerEndpoints} label="Setup guide for each server" />
      {endpoints.map((e) => {
        const group = catalog?.groups.find((g) => g.kind === 'endpoint' && g.id === e.id);
        return (
          <div key={e.id} data-testid={`endpoint-row-${e.id}`} className="rounded-xl border border-ink/10 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink flex-1">{e.name}</span>
              <span className="text-xs text-ink/55">{e.baseUrl} · {e.gpu} · {e.contextTokens.toLocaleString()} ctx · key {keyStatus[e.id] ?? 'unset'}</span>
              <button type="button" data-testid={`endpoint-edit-${e.id}`} onClick={() => open(e)} className="px-3 py-1 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">Edit</button>
              <button type="button" data-testid={`endpoint-delete-${e.id}`} onClick={() => void remove(e.id)} className="px-3 py-1 rounded-full border border-rose-300 text-xs text-rose-700 min-h-[44px] fine-pointer:min-h-0">Delete</button>
            </div>
            {rowErrors[e.id] && <p data-testid={`endpoint-row-error-${e.id}`} className="text-xs text-rose-700">{rowErrors[e.id]}</p>}
            {group?.status === 'error' && <p className="text-xs text-amber-800">Could not list models: {group.error}</p>}
            {(group?.models ?? []).map((m) => (
              <div key={m.id} className="flex flex-wrap items-center gap-2 pl-2">
                <span className="text-xs text-ink flex-1">{modelLabel(m.id, catalog)}</span>
                <ModelTestButton entry={m} label={modelLabel(m.id, catalog)} />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pl-2">
              <input
                data-testid={`endpoint-free-model-${e.id}`}
                placeholder="model id (if the list is empty)"
                value={freeModels[e.id] ?? ''}
                onChange={(ev) => setFreeModels((f) => ({ ...f, [e.id]: ev.target.value }))}
                className="px-3 py-1.5 rounded-xl border border-ink/15 bg-white text-xs text-ink min-h-[44px] fine-pointer:min-h-0"
              />
              <button type="button" data-testid={`endpoint-use-free-model-${e.id}`} onClick={() => useFreeModel(e.id)} className="px-3 py-1 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">Use as default analysis model</button>
            </div>
          </div>
        );
      })}

      {editing === undefined ? (
        <button type="button" data-testid="add-endpoint" onClick={() => open(null)} className="px-4 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0">
          Add endpoint
        </button>
      ) : (
        <div data-testid="endpoint-editor" className="rounded-xl border border-ink/15 p-4 space-y-3">
          <FieldRow label="Name">
            <input data-testid="endpoint-name" value={draft.name} onChange={(e) => set('name', e.target.value)} className={INPUT} />
            {errors.name && <p className="mt-1 text-xs text-rose-700">{errors.name}</p>}
          </FieldRow>
          <FieldRow label="Base URL" sublabel="The OpenAI-compatible root, ending in /v1 for most servers.">
            <input data-testid="endpoint-base-url" value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="http://127.0.0.1:8080/v1" className={INPUT} />
            {errors.baseUrl && <p className="mt-1 text-xs text-rose-700">{errors.baseUrl}</p>}
          </FieldRow>
          <FieldRow label="API key" sublabel="Optional. Stored for this host only and never shown again; sent only to this base URL's host.">
            <input data-testid="endpoint-key" type="password" autoComplete="off" value={draft.key} onChange={(e) => set('key', e.target.value)} className={INPUT} />
            {hostChanged && (
              <div data-testid="endpoint-key-reentry" className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                The host changed — re-enter the API key for {editing?.name}. The saved key is only sent to {originOf(editing?.baseUrl ?? '')}.
                <label className="mt-1 flex items-center gap-2 min-h-[44px] fine-pointer:min-h-0">
                  <input type="checkbox" data-testid="endpoint-no-key" checked={draft.noKey} onChange={(e) => set('noKey', e.target.checked)} />
                  This server needs no key
                </label>
              </div>
            )}
            {errors.key && <p className="mt-1 text-xs text-rose-700">{errors.key}</p>}
          </FieldRow>
          <FieldRow label="Context size (tokens)" sublabel="Required: what the server actually serves per request, not the model's training context. List models fills it from served values; Detect reads llama.cpp / llama-swap. It sets the chunk size: each stage's chunks are at most its input fraction (Advanced Settings → Analyzer chunking) × this × 2 characters per token, capped by the pass ceiling.">
            <div className="flex flex-wrap items-center gap-2">
              <input data-testid="endpoint-context-tokens" type="number" min={512} value={draft.contextTokens} onChange={(e) => set('contextTokens', e.target.value)} className="w-40 px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm min-h-[44px] fine-pointer:min-h-0" />
              <button type="button" data-testid="endpoint-list-models" onClick={() => void listModels()} className="px-3 py-1.5 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">List models</button>
              <select data-testid="endpoint-detect-flavor" value={detectFlavor} onChange={(e) => setDetectFlavor(e.target.value as 'llama.cpp' | 'llama-swap')} className="px-2 py-1.5 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">
                <option value="llama.cpp">llama.cpp</option>
                <option value="llama-swap">llama-swap</option>
              </select>
              <select data-testid="endpoint-detect-model" value={detectModel} onChange={(e) => setDetectModel(e.target.value)} className="px-2 py-1.5 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">
                <option value="">(no model)</option>
                {(preview?.models ?? []).map((m) => (
                  <option key={m.model} value={m.model}>{m.model}</option>
                ))}
              </select>
              <button type="button" data-testid="endpoint-detect" onClick={onDetect} className="px-3 py-1.5 rounded-full border border-ink/15 text-xs min-h-[44px] fine-pointer:min-h-0">Detect</button>
            </div>
            {preview?.status === 'failed' && <p className="mt-1 text-xs text-amber-800">Could not list models: {preview.error}</p>}
            {detectNote && <p className="mt-1 text-xs text-ink/60">{detectNote}</p>}
            {errors.contextTokens && <p data-testid="endpoint-context-error" className="mt-1 text-xs text-rose-700">{errors.contextTokens}</p>}
          </FieldRow>
          <FieldRow label="GPU" sublabel="The card this server runs on. Castwright asks before analysing on the voice engine's card and unloads it there when a voice model needs the memory. Use None for a remote or CPU server; Any treats it as sharing every card.">
            <select data-testid="endpoint-gpu" value={draft.gpu} onChange={(e) => set('gpu', e.target.value)} className={INPUT}>
              <option value="none">None (remote or CPU)</option>
              <option value="any">Any card</option>
              {devices.map((d) => (
                <option key={d.idx} value={`cuda:${d.idx}`}>{`${d.name} (cuda:${d.idx})`}</option>
              ))}
            </select>
            {errors.gpu && <p className="mt-1 text-xs text-rose-700">{errors.gpu}</p>}
          </FieldRow>
          <FieldRow label="Unload URL" sublabel="Optional, same host as the base URL. Castwright POSTs it to free the card for a voice model, once for each model that has answered a request from this endpoint since the server started; {model} is replaced by that model, e.g. http://127.0.0.1:8080/api/models/unload/{model} for llama-swap.">
            <input data-testid="endpoint-unload-url" value={draft.unloadUrl} onChange={(e) => set('unloadUrl', e.target.value)} className={INPUT} />
            {errors.unloadUrl && <p className="mt-1 text-xs text-rose-700">{errors.unloadUrl}</p>}
            {draft.unloadUrl.trim() !== '' && !draft.unloadUrl.includes('{model}') && (
              <p data-testid="endpoint-unload-all-warning" className="mt-1 text-xs text-amber-800">
                Without {'{model}'} this URL unloads every model on that server, including one that another card or another app is using. That is fine for a single-model server; on a shared llama-swap, add {'{model}'}.
              </p>
            )}
          </FieldRow>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FieldRow label="Concurrent requests" sublabel="1–16. Match your server's parallel slots.">
              <input data-testid="endpoint-concurrency" type="number" min={1} max={16} value={draft.concurrency} onChange={(e) => set('concurrency', e.target.value)} className={INPUT} />
              {errors.concurrency && <p className="mt-1 text-xs text-rose-700">{errors.concurrency}</p>}
            </FieldRow>
            <FieldRow label="Request ceiling (minutes)" sublabel="Longest one request may run, counted after it leaves the queue. Default 30.">
              <input data-testid="endpoint-ceiling-minutes" type="number" min={1} max={240} value={draft.ceilingMinutes} onChange={(e) => set('ceilingMinutes', e.target.value)} className={INPUT} />
              {errors.requestCeilingMs && <p className="mt-1 text-xs text-rose-700">{errors.requestCeilingMs}</p>}
            </FieldRow>
            <FieldRow label="Structured output" sublabel="schema sends the output schema; json asks for any JSON object (some servers, e.g. LM Studio, reject it); off sends neither. llama.cpp ignores the schema while a model is thinking — use Test to see what this model does.">
              <select data-testid="endpoint-structured-output" value={draft.structuredOutput} onChange={(e) => set('structuredOutput', e.target.value as Mode)} className={INPUT}>
                <option value="schema">schema</option>
                <option value="json">json</option>
                <option value="off">off</option>
              </select>
              {errors.structuredOutput && <p className="mt-1 text-xs text-rose-700">{errors.structuredOutput}</p>}
            </FieldRow>
            <FieldRow label="Reasoning control" sublabel="How this server is told to reason. Pick the field your server reads; if it reads neither, choose Not controllable.">
              <select
                data-testid="endpoint-reasoning-style"
                value={draft.reasoningStyle}
                onChange={(e) => {
                  const reasoningStyle = e.target.value as ReasoningStyle;
                  setDraft((d) => ({
                    ...d,
                    reasoningStyle,
                    reasoning: levelsForEndpointStyle(reasoningStyle).includes(d.reasoning) ? d.reasoning : 'model-default',
                  }));
                }}
                className={INPUT}
              >
                {(Object.keys(REASONING_STYLE_LABELS) as ReasoningStyle[]).map((s) => (
                  <option key={s} value={s}>{REASONING_STYLE_LABELS[s]}</option>
                ))}
              </select>
              {errors.reasoningStyle && <p className="mt-1 text-xs text-rose-700">{errors.reasoningStyle}</p>}
            </FieldRow>
            <FieldRow label="Reasoning" sublabel={REASONING_HELP}>
              <select
                data-testid="endpoint-reasoning"
                value={draft.reasoning}
                onChange={(e) => set('reasoning', e.target.value as ReasoningLevel)}
                className={INPUT}
              >
                {/* A stored level this style doesn't offer stays visible, so it can be changed (mirrors the Ollama rows). */}
                {[
                  ...levelsForEndpointStyle(draft.reasoningStyle),
                  ...(levelsForEndpointStyle(draft.reasoningStyle).includes(draft.reasoning) ? [] : [draft.reasoning]),
                ].map((l) => (
                  <option key={l} value={l}>{REASONING_LEVEL_LABELS[l] ?? l}</option>
                ))}
              </select>
              {errors.reasoning && <p className="mt-1 text-xs text-rose-700">{errors.reasoning}</p>}
            </FieldRow>
            <FieldRow label="Max output tokens" sublabel="0 = Auto (the model's limit, or context minus input).">
              <input data-testid="endpoint-max-output-tokens" type="number" min={0} value={draft.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value)} className={INPUT} />
              {errors.maxOutputTokens && <p className="mt-1 text-xs text-rose-700">{errors.maxOutputTokens}</p>}
            </FieldRow>
            <FieldRow label="Max input tokens per request" sublabel="Optional cap. When set, it (or this endpoint's TPM limit, whichever is smaller) lowers the chunk size below the Context size bound.">
              <input data-testid="endpoint-max-input-tokens" type="number" min={256} value={draft.maxInputTokensPerRequest} onChange={(e) => set('maxInputTokensPerRequest', e.target.value)} className={INPUT} />
              {errors.maxInputTokensPerRequest && <p className="mt-1 text-xs text-rose-700">{errors.maxInputTokensPerRequest}</p>}
            </FieldRow>
          </div>
          {saveError && <p data-testid="endpoint-save-error" className="text-xs text-rose-700">{saveError}</p>}
          <div className="flex items-center gap-3">
            <button type="button" data-testid="endpoint-save" onClick={() => void save()} className="px-4 py-2 rounded-xl bg-ink text-white text-sm min-h-[44px] fine-pointer:min-h-0">Save endpoint</button>
            <button type="button" data-testid="endpoint-cancel" onClick={() => setEditing(undefined)} className="px-4 py-2 rounded-xl border border-ink/15 text-sm min-h-[44px] fine-pointer:min-h-0">Cancel</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmLoad}
        eyebrow="Detect context size"
        title="Load the model to read its context?"
        body={<p>Detecting may load {detectModel} on the server (llama-swap starts it to answer). That can take a while and uses its GPU memory.</p>}
        confirmLabel="Detect anyway"
        cancelLabel="Cancel"
        onConfirm={() => {
          setConfirmLoad(false);
          void runDetect(true);
        }}
        onClose={() => setConfirmLoad(false)}
      />
    </div>
  );
}
