/* #3084 W4 — seeds a hand-built test store so the design-start guard sees a rendering generation on
   cuda:0 and a persona engine that is an OpenAI-compatible endpoint on the same card. The store needs
   the chapters, account and config reducers (see use-local-analyzer-guard.test.tsx for the rule). */
import { fetchConfig } from '../store/config-slice';
import { chaptersSlice } from '../store/chapters-slice';

export const SAME_CARD_ENDPOINT = {
  id: 'same-card', name: 'Same card', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 8192,
};

export function seedSameCardPersona(
  store: { dispatch: (a: never) => unknown },
  opts: { streaming?: boolean; personaEngine?: string } = {},
): void {
  const d = store.dispatch as (a: unknown) => unknown;
  d({ type: 'account/fetch/fulfilled', payload: { analyzerEndpoints: [SAME_CARD_ENDPOINT] } });
  const entry = (key: string, effective: string) => ({ key, effective, source: 'override' as const, locked: false, overridden: true });
  d(
    fetchConfig.fulfilled(
      {
        groups: [], descriptors: [],
        values: {
          'tts.coqui.device': entry('tts.coqui.device', 'cuda:0'),
          'analyzer.personaGeneration.engine': entry('analyzer.personaGeneration.engine', opts.personaEngine ?? 'openai:same-card::m0'),
        },
        restartPending: false, cudaEnvShadow: false, envCleanupCandidates: [],
      },
      '',
      undefined,
    ),
  );
  if (opts.streaming !== false) {
    d(chaptersSlice.actions.setActiveStream({
      streamKey: 'b1::1', bookId: 'b1', chapterId: 1, modelKey: 'coqui-xtts-v2', done: 0, total: 3, inProgress: 1, lastTickAt: Date.now(), halted: false,
    }));
  }
}
