/* UI slice — stage modeled as a discriminated union; transitions are guarded.

   Transient overlays (handoffApp, regenChapter, currentTrack, etc.) stay flat
   at the slice top — they cut across stages and have their own lifecycles. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Stage, View } from '../lib/types';
import type { ListenerApp, Chapter } from '../lib/types';
import type { RootState } from './index';

const READY_DEFAULTS = { currentChapterId: 3, openProfileId: null as string | null };

export interface RegenCharacterCtx {
  characterId: string;
  defaultChapterId?: number;
}

export interface UiState {
  stage: Stage;
  currentTrack: number | null;
  matchDetailFor: string | null;
  handoffApp: ListenerApp | null;
  regenChapter: Chapter | null;
  regenCharacterCtx: RegenCharacterCtx | null;
  batchRegenIds: string[] | null;
  showRevisionPlayer: boolean;
  showDriftReport: boolean;
  previewMode: boolean;
}

const initialState: UiState = {
  stage: { kind: 'books' },
  currentTrack: null,
  matchDetailFor: null,
  handoffApp: null,
  regenChapter: null,
  regenCharacterCtx: null,
  batchRegenIds: null,
  showRevisionPlayer: false,
  showDriftReport: false,
  previewMode: false,
};

export const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    /* ── Stage transitions ──────────────────────────────────────────── */
    goHome: (s) => { s.stage = { kind: 'books' }; },
    startNewBook: (s) => {
      if (s.stage.kind !== 'books') return;
      s.stage = { kind: 'upload' };
    },
    manuscriptUploaded: (s, a: PayloadAction<{ bookId?: string; manuscriptId?: string | null }>) => {
      if (s.stage.kind !== 'upload') return;
      s.stage = { kind: 'analysing', bookId: a.payload?.bookId, manuscriptId: a.payload?.manuscriptId ?? null };
    },
    analysisComplete: (s, a: PayloadAction<{ bookId?: string }>) => {
      if (s.stage.kind !== 'analysing') return;
      const bookId = a.payload?.bookId || s.stage.bookId || 'ns';
      s.stage = { kind: 'confirm', bookId };
    },
    confirmCast: (s) => {
      if (s.stage.kind !== 'confirm') return;
      s.stage = { kind: 'ready', bookId: s.stage.bookId, view: 'manuscript', ...READY_DEFAULTS };
    },
    reanalyse: (s) => {
      if (s.stage.kind !== 'confirm') return;
      s.stage = { kind: 'analysing', bookId: s.stage.bookId };
    },
    openBook: (s, a: PayloadAction<{ id: string; status: string }>) => {
      const { id, status } = a.payload;
      if (status === 'analysing')         s.stage = { kind: 'analysing', bookId: id };
      else if (status === 'cast_pending') s.stage = { kind: 'confirm',   bookId: id };
      else {
        const view: View = status === 'complete' ? 'listen'
                         : status === 'generating' ? 'generate'
                         : 'cast';
        s.stage = { kind: 'ready', bookId: id, view, ...READY_DEFAULTS };
      }
    },

    /* ── Ready-state mutations ──────────────────────────────────────── */
    changeView: (s, a: PayloadAction<View>) => {
      if (s.stage.kind !== 'ready') return;
      s.stage.view = a.payload;
    },
    setCurrentChapterId: (s, a: PayloadAction<number>) => {
      if (s.stage.kind !== 'ready') return;
      s.stage.currentChapterId = a.payload;
    },
    setOpenProfileId: (s, a: PayloadAction<string | null>) => {
      if (s.stage.kind !== 'ready') return;
      s.stage.openProfileId = a.payload;
    },

    /* ── URL hydration ──────────────────────────────────────────────── */
    hydrateFromUrl: (s, a: PayloadAction<Stage>) => {
      if (a.payload && a.payload.kind) s.stage = a.payload;
    },

    /* ── Cross-cutting overlays ─────────────────────────────────────── */
    setCurrentTrack:       (s, a: PayloadAction<number | null>) => { s.currentTrack = a.payload; },
    setMatchDetailFor:     (s, a: PayloadAction<string | null>) => { s.matchDetailFor = a.payload; },
    setHandoffApp:         (s, a: PayloadAction<ListenerApp | null>) => { s.handoffApp = a.payload; },
    setRegenChapter:       (s, a: PayloadAction<Chapter | null>) => { s.regenChapter = a.payload; },
    setRegenCharacterCtx:  (s, a: PayloadAction<RegenCharacterCtx | null>) => { s.regenCharacterCtx = a.payload; },
    setBatchRegenIds:      (s, a: PayloadAction<string[] | null>) => { s.batchRegenIds = a.payload; },
    setShowRevisionPlayer: (s, a: PayloadAction<boolean>) => { s.showRevisionPlayer = a.payload; },
    setShowDriftReport:    (s, a: PayloadAction<boolean>) => { s.showDriftReport = a.payload; },
    setPreviewMode:        (s, a: PayloadAction<boolean>) => { s.previewMode = a.payload; },
  },
});

export const uiActions = uiSlice.actions;

export const uiSelectors = {
  stageKind: (s: RootState) => s.ui.stage.kind,
  bookId:    (s: RootState) => (s.ui.stage as { bookId?: string }).bookId ?? null,
  view:      (s: RootState) => s.ui.stage.kind === 'ready' ? s.ui.stage.view : null,
  chapterId: (s: RootState) => s.ui.stage.kind === 'ready' ? s.ui.stage.currentChapterId : null,
  profileId: (s: RootState) => s.ui.stage.kind === 'ready' ? s.ui.stage.openProfileId : null,
};
