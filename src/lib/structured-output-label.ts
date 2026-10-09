/* #3084 — frontend twin of server/src/analyzer/runner/schema-adapters.ts
   structuredOutputLabel, used by the mock catalog. Driven by the same case table
   (server/src/analyzer/__fixtures__/structured-output-label-cases.json). */
import type { ModelCapabilityRecord, StructuredOutputMode } from './types';

export function structuredOutputLabel(
  mode: StructuredOutputMode,
  dropped: readonly string[],
  record: ModelCapabilityRecord | undefined,
  reasoningKey: string,
): string {
  if (mode !== 'schema') return mode;
  if (record?.structuredOutput.schema?.[reasoningKey] === 'ignored') return 'schema (not enforced)';
  return dropped.length > 0 ? 'schema (partial)' : 'schema';
}
