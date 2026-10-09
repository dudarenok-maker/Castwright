/* Per-model capability records written by the Test action (#3084 decision 2b).
   PR 3b ships the types only, because structuredOutputLabel reads a record.
   PR 3c adds capabilityRecordFor, assertConfiguredCapabilitiesAllowed,
   runModelTest and plannedTestRequestCount to this file. */
import type { StructuredOutputMode } from './runner/transport.js';

export type ProbeOutcome = 'enforced' | 'ignored' | 'rejected' | 'accepted';

export interface ModelCapabilityRecord {
  /** endpoint baseUrl, Ollama URL, or 'gemini' */
  serverUrl: string;
  /** ISO timestamp */
  testedAt: string;
  /** control request; `error` is redacted */
  control: { ok: true } | { ok: false; error: string };
  /** mode → (reasoning level or 'configured') → outcome */
  structuredOutput: Partial<Record<StructuredOutputMode, Record<string, ProbeOutcome>>>;
  /** reasoning level → outcome. Keyed by `string`: ReasoningLevel is born in wave 5
      (Task 5.1), which narrows this key. PR 3b/3c records `{}`. */
  reasoning: Partial<Record<string, 'accepted' | 'rejected'>>;
}
