/* #3787 — openapi.yaml documents AnalysisState / ActiveAnalysisSummary, but the server keeps its own
   TS unions and never imports the generated types. The key-name check in test-utils/openapi-analysis-state.ts
   cannot see an enum drift (AnalysisEngine already widened once, 3bfebeba). Same idiom as
   openapi-setup-parity.test.ts: each map is `satisfies Record<ServerUnion, 1>` (typecheck catches a union
   change), and the runtime assertion carries the same set over to openapi.yaml. */
import { describe, it, expect } from 'vitest';
import type { AnalysisStateFile } from '../store/analysis-state.js';
import type { ActiveAnalysisSummary } from '../workspace/active-analyses.js';
import { schemaPropertyEnum } from '../test-utils/openapi-analysis-state.js';

const ANALYSIS_STATES = { running: 1, paused: 1, halted: 1 } satisfies Record<AnalysisStateFile['state'], 1>;
const SUMMARY_STATES = { paused: 1, halted: 1 } satisfies Record<ActiveAnalysisSummary['state'], 1>;
const ENGINES = { local: 1, openai: 1, gemini: 1 } satisfies Record<NonNullable<AnalysisStateFile['engine']>, 1>;
const SUMMARY_ENGINES = { local: 1, openai: 1, gemini: 1 } satisfies Record<NonNullable<ActiveAnalysisSummary['engine']>, 1>;
const KINDS = { main: 1, subset: 1 } satisfies Record<NonNullable<AnalysisStateFile['kind']>, 1>;
const SUMMARY_KINDS = { main: 1, subset: 1 } satisfies Record<NonNullable<ActiveAnalysisSummary['kind']>, 1>;
const SUBSET_ORIGINS = { include: 1, reanalyse: 1 } satisfies Record<NonNullable<AnalysisStateFile['subsetOrigin']>, 1>;

const sorted = (m: Record<string, 1>) => Object.keys(m).sort();

describe('openapi analysis-state enums match the server unions (#3787)', () => {
  it.each([
    ['AnalysisState', 'state', ANALYSIS_STATES],
    ['AnalysisState', 'engine', ENGINES],
    ['AnalysisState', 'kind', KINDS],
    ['AnalysisState', 'subsetOrigin', SUBSET_ORIGINS],
    ['ActiveAnalysisSummary', 'state', SUMMARY_STATES],
    ['ActiveAnalysisSummary', 'engine', SUMMARY_ENGINES],
    ['ActiveAnalysisSummary', 'kind', SUMMARY_KINDS],
  ] as const)('%s.%s', (schema, prop, map) => {
    expect(schemaPropertyEnum(schema, prop)).toEqual(sorted(map));
  });
});
