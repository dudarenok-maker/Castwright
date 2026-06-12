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

const TITLES = {
  'vram-spill': 'GPU out of memory (VRAM)',
  'recycle-storm': 'TTS engine keeps restarting',
  'sidecar-unreachable': 'TTS sidecar not running',
  'analyzer-rate-limit': 'Analyzer rate-limited',
  'analyzer-daily-quota': 'Analyzer daily quota exhausted',
  'analyzer-truncated': 'Analyzer reply cut short',
  'analyzer-unreachable': 'Analyzer not reachable',
  'attribution-incomplete': 'Chapter attribution incomplete',
  oom: 'Computer ran out of memory',
  'disk-full': 'Disk full',
  'model-not-loaded': 'TTS model not loaded yet',
  'synth-timeout': 'Chapter synthesis timed out',
  'xtts-speaker-desync': 'Voice catalog out of sync',
  'cuda-poisoned': 'GPU error (auto-recovering)',
  auth: 'Gemini API key problem',
  unknown: 'Unrecognised error',
} satisfies Record<FailureCode, string>;

export interface HelpFailureEntry extends FailureRemediationCopy {
  code: FailureCode;
  title: string;
}

export const HELP_FAILURE_ENTRIES: HelpFailureEntry[] = (
  Object.keys(TITLES) as FailureCode[]
).map((code) => ({
  code,
  title: TITLES[code],
  ...FAILURE_REMEDIATIONS[code],
}));
