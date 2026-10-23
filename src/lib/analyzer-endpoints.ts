/* #3084 W3 — frontend view of analyzer endpoints for GPU coordination (spec §4): which
   saved endpoint a model id names, whether an analyzer run shares the TTS card, and the
   card tag captured on the analysis snapshot. Unknown always fails closed. */
import { engineForModelId, parseEndpointModelId, type AnalysisEngine } from './model-id';
import { engineForModelKey } from './tts-models';
import type { SidecarHealth } from './api';
import type { AnalyzerEndpoint, ConfigValues, TtsModelKey, UserSettings } from './types';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Mirror of the server's defaultGpuForBaseUrl: a loopback host shares every card. */
export function defaultGpuForBaseUrl(baseUrl: string): 'any' | 'none' {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase()) ? 'any' : 'none';
  } catch {
    return 'none';
  }
}

export function endpointForModelId(
  settings: Pick<UserSettings, 'analyzerEndpoints'>,
  id: string,
): AnalyzerEndpoint | undefined {
  const parsed = parseEndpointModelId(id);
  return parsed ? settings.analyzerEndpoints?.find((e) => e.id === parsed.endpointId) : undefined;
}

export function analyzerSharesTtsDevice(input: {
  engine: AnalysisEngine;
  /** 'none' | 'any' | 'cuda:N'; undefined = the endpoint is not in settings (fail closed). */
  endpointGpu: string | undefined;
  /** 'cuda:N' | 'cpu' | undefined (unknown → fail closed). */
  ttsDeviceKey: string | undefined;
}): boolean {
  if (input.engine === 'local') return true;
  if (input.engine === 'gemini') return false;
  const gpu = input.endpointGpu ?? 'any';
  if (gpu === 'none') return false;
  /* N5 — TTS on the CPU holds no card at all, so nothing shares it, `any` included. */
  if (input.ttsDeviceKey === 'cpu') return false;
  if (gpu === 'any' || input.ttsDeviceKey === undefined) return true;
  return gpu === input.ttsDeviceKey;
}

const DEVICE_KNOB: Partial<Record<ReturnType<typeof engineForModelKey>, string>> = {
  qwen: 'tts.qwen.device',
  kokoro: 'tts.kokoro.device',
  coqui: 'tts.coqui.device',
};

/** #3084 N5 — what the sidecar's last reachable /health said about where TTS runs:
    `qwenDeviceKey` is a concrete card (a resident Qwen only), `families` is per-engine and
    coarse ('cuda' | 'cpu' | …), which is all the sidecar reports for Kokoro and Coqui. */
export interface TtsReportedDevices {
  qwenDeviceKey: string | null;
  families: Partial<Record<ReturnType<typeof engineForModelKey>, string | null>>;
}

/** Reads a /health snapshot into that shape; null for no snapshot or an unreachable one. */
export function reportedTtsDevicesFrom(health: SidecarHealth | null): TtsReportedDevices | null {
  if (!health || health.status !== 'reachable') return null;
  return { qwenDeviceKey: health.qwenDeviceKey ?? null, families: { ...(health.devices ?? {}) } };
}

/** Where a TTS model runs: the pinned `tts.<engine>.device` value (`cuda:N` or `cpu`), else
    what the sidecar resolved for that engine (N5), else undefined = unknown (fail closed). */
export function ttsDeviceKeyFor(
  modelKey: TtsModelKey | undefined,
  values: ConfigValues | undefined,
  reported?: TtsReportedDevices | null,
): string | undefined {
  if (!modelKey) return undefined;
  const engine = engineForModelKey(modelKey);
  /* Gemini TTS is a cloud call: it holds no card, the same answer as a CPU engine. */
  if (engine === 'gemini') return 'cpu';
  const knob = DEVICE_KNOB[engine];
  const effective = knob && values ? values[knob]?.effective : undefined;
  if (typeof effective === 'string' && (/^cuda:\d+$/.test(effective) || effective === 'cpu')) return effective;
  /* `auto` (or a config slice that has not hydrated yet): ask what the sidecar resolved. */
  if (!reported) return undefined;
  if (reported.families[engine] === 'cpu') return 'cpu';
  /* Only Qwen's concrete card is reported; a 'cuda' family without an index stays unknown. */
  if (engine === 'qwen' && reported.qwenDeviceKey && /^cuda:\d+$/.test(reported.qwenDeviceKey)) return reported.qwenDeviceKey;
  return undefined;
}

/** The model key a per-character engine pin synthesises with (Qwen carries its own tier key). */
const PIN_MODEL_KEY: Record<string, TtsModelKey> = {
  kokoro: 'kokoro-v1',
  coqui: 'coqui-xtts-v2',
  qwen: 'qwen3-tts-0.6b',
  gemini: 'gemini-2.5-flash',
};

/** #3710 F4 — whether an analyzer run shares a card with the TTS generation will actually use:
    the SESSION picker's model (`ui.ttsModelKey`; the account default only when that is unset),
    plus every model a per-character pin could route a line to. A pin may name a different engine
    than the session model, so any of them sharing counts (fail closed). */
export function analyzerSharesGenerationDevice(input: {
  engine: AnalysisEngine;
  endpointGpu: string | undefined;
  sessionModelKey: TtsModelKey | undefined;
  characters?: ReadonlyArray<{ ttsEngine?: string | null; ttsModelKey?: string | null }> | null;
  values: ConfigValues | undefined;
  reported?: TtsReportedDevices | null;
}): boolean {
  const keys = new Set<TtsModelKey | undefined>([input.sessionModelKey]);
  for (const c of input.characters ?? []) {
    if (!c.ttsEngine) continue;
    /* An engine with no model key here (piper) is unknown, which ttsDeviceKeyFor fails closed on. */
    keys.add(c.ttsEngine === 'qwen' && c.ttsModelKey ? (c.ttsModelKey as TtsModelKey) : PIN_MODEL_KEY[c.ttsEngine]);
  }
  return [...keys].some((modelKey) =>
    analyzerSharesTtsDevice({
      engine: input.engine,
      endpointGpu: input.endpointGpu,
      ttsDeviceKey: ttsDeviceKeyFor(modelKey, input.values, input.reported),
    }),
  );
}

/** The one card tag for several endpoint cards: `none` only when none of them holds a card, the
    card itself when they all hold the same one, else `any`. Undefined entries (no endpoint) are skipped. */
export function combineSnapshotGpus(gpus: ReadonlyArray<string | undefined>): string | undefined {
  const held = gpus.filter((g): g is string => g !== undefined);
  if (held.length === 0) return undefined;
  const sharing = [...new Set(held.filter((g) => g !== 'none'))];
  if (sharing.length === 0) return 'none';
  return sharing.length === 1 ? sharing[0] : 'any';
}

/** The gpu tag an analysis snapshot carries for the run's model ids. */
export function snapshotGpuFor(
  modelIds: readonly string[],
  settings: Pick<UserSettings, 'analyzerEndpoints'>,
): string | undefined {
  return combineSnapshotGpus(
    modelIds.filter((id) => engineForModelId(id) === 'openai').map((id) => endpointForModelId(settings, id)?.gpu ?? 'any'),
  );
}
