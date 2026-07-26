/* fe-29 — maps the shared fs-19 remediation copy (server/src/routes/
   failure-remediations.ts, bundled statically by Vite so Help works offline)
   into ordered, titled entries for the Help view's troubleshooting section.
   The `satisfies Record<FailureCode, string>` pin means a new FailureCode
   without a Help title fails `npm run typecheck` — the contract the spec
   calls "pinned on both ends". */
import {
  FAILURE_REMEDIATIONS,
  type FailureRemediationCopy,
} from '../../server/src/routes/failure-remediations';
import type { components } from '../lib/api-types';

export type FailureCode = components['schemas']['FailureCode'];

export type CategoryId =
  | 'setup'
  | 'engines'
  | 'analysis'
  | 'voices'
  | 'quality'
  | 'cast'
  | 'performance'
  | 'files'
  | 'other';

/* Topical bucket per failure code — pinned total so a new FailureCode without a
   category fails typecheck (mirrors the TITLES pin). */
const CATEGORIES = {
  'vram-spill': 'performance',
  'recycle-storm': 'engines',
  'sidecar-unreachable': 'engines',
  'analyzer-rate-limit': 'analysis',
  'analyzer-daily-quota': 'analysis',
  'analyzer-truncated': 'analysis',
  'analyzer-unreachable': 'analysis',
  'analyzer-content-blocked': 'analysis',
  'attribution-incomplete': 'analysis',
  oom: 'performance',
  'disk-full': 'files',
  'model-not-loaded': 'engines',
  'synth-timeout': 'engines',
  'xtts-speaker-desync': 'engines',
  'cuda-poisoned': 'performance',
  'gpu-acceleration-unavailable': 'performance',
  'voice-not-designed': 'voices',
  'cloned-voice-broken': 'voices',
  auth: 'analysis',
  unknown: 'other',
} satisfies Record<FailureCode, CategoryId>;

const TITLES = {
  'vram-spill': 'GPU out of memory (VRAM)',
  'recycle-storm': 'Voice engine keeps restarting',
  'sidecar-unreachable': 'Voice engine not running',
  'analyzer-rate-limit': 'Analyzer rate-limited',
  'analyzer-daily-quota': 'Analyzer daily quota exhausted',
  'analyzer-truncated': 'Analyzer reply cut short',
  'analyzer-unreachable': 'Analyzer not reachable',
  'analyzer-content-blocked': 'Gemini blocked the chapter (copyright filter)',
  'attribution-incomplete': 'Chapter attribution incomplete',
  oom: 'Computer ran out of memory',
  'disk-full': 'Disk full',
  'model-not-loaded': 'Voice engine not loaded yet',
  'synth-timeout': 'Chapter synthesis timed out',
  'xtts-speaker-desync': 'Voice catalog out of sync',
  'cuda-poisoned': 'GPU error (auto-recovering)',
  'gpu-acceleration-unavailable': 'Running on CPU (GPU acceleration unavailable)',
  'voice-not-designed': 'Non-English chapter missing a designed voice',
  'cloned-voice-broken': "Cloned voice can't render as itself",
  auth: 'Gemini API key problem',
  unknown: 'Unrecognised error',
} satisfies Record<FailureCode, string>;

export interface HelpFailureEntry extends FailureRemediationCopy {
  code: FailureCode;
  title: string;
  category: CategoryId;
}

export const HELP_FAILURE_ENTRIES: HelpFailureEntry[] = (
  Object.keys(TITLES) as FailureCode[]
).map((code) => ({
  code,
  title: TITLES[code],
  category: CATEGORIES[code],
  ...FAILURE_REMEDIATIONS[code],
}));
