/* Analysis-stream middleware — fires the server-side /analysis/pause
   endpoint when the slice flips to paused, keeping the per-view abort
   logic and the cross-tab pause signal in lockstep.

   Mirrors the pause limb of generation-stream-middleware:
     - View's Pause button dispatches `analysis/setPaused`.
     - Middleware reacts: fires `api.pauseAnalysis({ manuscriptId })`
       so the server-side controller aborts; the analyzer loop's
       AnalysisAbortedError catch surfaces a final
       `{kind:'error', code:'aborted'}` event to every attached
       subscriber and endJob() deregisters the entry from
       inFlightAnalysisByManuscript.
     - The view's existing SSE abort still tears down the per-tab
       fetch consumer (clean local close) — that path stays in place
       since the server-side abort + per-tab abort happen
       independently.

   B2 scope intentionally narrow: this middleware does NOT own its own
   SSE for the cross-navigation pill. The view still owns the SSE; this
   middleware is the bridge between the slice's `setPaused` action and
   the server endpoint. B3 may opt to extend it with its own SSE if the
   pill needs live ticks across navigation, but for now the snapshot
   freezes at whatever was last ticked-through-the-view, which the pill
   renders as "last known" — acceptable until B3 lands. */

import type { Middleware } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { analysisActions } from './analysis-slice';

const PAUSE_TYPE = analysisActions.setPaused.type;

export const analysisStreamMiddleware: Middleware = (_store) => (next) => (action) => {
  const result = next(action);
  const a = action as { type?: string; payload?: { manuscriptId?: string } };
  if (a?.type !== PAUSE_TYPE) return result;
  const manuscriptId = a.payload?.manuscriptId;
  if (typeof manuscriptId !== 'string' || !manuscriptId) return result;
  /* Fire-and-forget — if the request fails the worst case is the run
     keeps going for an extra few seconds until the SSE finishes
     naturally (the view's local abort path is independent). The user
     can hit Pause again; the endpoint is idempotent. */
  void api.pauseAnalysis({ manuscriptId });
  return result;
};
