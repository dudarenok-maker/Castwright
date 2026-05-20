/* UI slice — stage modeled as a discriminated union; transitions are guarded.

   Transient overlays (handoffApp, regenChapter, currentTrack, etc.) stay flat
   at the slice top — they cut across stages and have their own lifecycles. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Stage, View, TtsModelKey } from '../lib/types';
import type { ListenerApp, Chapter } from '../lib/types';
import type { RegenScope } from '../modals/regenerate';
import { DEFAULT_MODEL } from '../lib/models';
import { DEFAULT_TTS_MODEL, TTS_MODEL_OPTIONS } from '../lib/tts-models';
import { fetchAccountSettings, saveAccountSettings } from './account-slice';
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
  /** Pre-selected scope for the chapter regenerate modal. Defaults to null so
      the modal falls back to its built-in default ('this'). Set to 'forward'
      when the user opens the modal from the post-generation header button so
      "this and all subsequent" — i.e. the whole book — is pre-selected. */
  regenInitialScope: RegenScope | null;
  regenCharacterCtx: RegenCharacterCtx | null;
  batchRegenIds: string[] | null;
  /** Session-only banner shown on the Cast view after a voice-edit Save
      reveals that one or more done chapters now hold audio that no longer
      matches the character's current voice/identity. Click "Regenerate
      now" dispatches the same chain the CharacterRegenerateModal does
      (regenerateCharacter + change-log + changeView('generate')) without
      the modal step — bypassing the 30s drift-poll wait. */
  staleAudio: {
    characterId: string;
    characterName: string;
    chapterIds: number[];
  } | null;
  showRevisionPlayer: boolean;
  /** Plan 55 — when truthy, the revision-history modal is mounted. The
      value carries `chapterId` (null = cross-chapter view) so the modal
      can scope its list. */
  revisionHistoryFor: { chapterId: number | null } | null;
  showDriftReport: boolean;
  previewMode: boolean;
  selectedModel: string;
  ttsModelKey: TtsModelKey;
  /** Whether the user has explicitly picked an analysis model this session.
      Until then, the slice tracks the account-level default and re-seeds
      from it when the account fetch lands. */
  selectedModelExplicit: boolean;
  /** Same as above for the TTS model selector. */
  ttsModelKeyExplicit: boolean;
  /** Plan 41 — device-local theme override, set via the top-bar
      quick toggle. `null` (the default) means "follow account
      default" — see `src/lib/use-theme.ts` for the resolution
      rule. `'system'` is a third explicit value that re-enables
      OS-driven auto-flip even when the account default is pinned
      to Light or Dark on this device. */
  themeOverride: 'light' | 'dark' | 'system' | null;
  /** Plan 74 — when set, the user clicked "Replace manuscript" on a
      ready-stage book and the upload view will treat the next
      successful import as a re-upload (route through the diff modal
      instead of through ConfirmMetadata + new analysis). Cleared on
      Apply / Discard or whenever the upload stage exits. Transient —
      not persisted. */
  reuploadingBookId: string | null;
}

const initialState: UiState = {
  stage: { kind: 'books' },
  currentTrack: null,
  matchDetailFor: null,
  handoffApp: null,
  regenChapter: null,
  regenInitialScope: null,
  regenCharacterCtx: null,
  batchRegenIds: null,
  staleAudio: null,
  showRevisionPlayer: false,
  revisionHistoryFor: null,
  showDriftReport: false,
  previewMode: false,
  selectedModel: DEFAULT_MODEL,
  ttsModelKey: DEFAULT_TTS_MODEL,
  selectedModelExplicit: false,
  ttsModelKeyExplicit: false,
  themeOverride: null,
  reuploadingBookId: null,
};

export const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    /* ── Stage transitions ──────────────────────────────────────────── */
    goHome: (s) => {
      s.stage = { kind: 'books' };
    },
    openVoices: (s) => {
      s.stage = { kind: 'voices' };
    },
    openChangelog: (s) => {
      s.stage = { kind: 'changelog' };
    },
    openAccount: (s) => {
      s.stage = { kind: 'account' };
    },
    startNewBook: (s) => {
      s.stage = { kind: 'upload' };
    },
    manuscriptUploaded: (
      s,
      a: PayloadAction<{ bookId?: string; manuscriptId?: string | null }>,
    ) => {
      if (s.stage.kind !== 'upload') return;
      s.stage = {
        kind: 'analysing',
        bookId: a.payload?.bookId,
        manuscriptId: a.payload?.manuscriptId ?? null,
      };
    },
    analysisComplete: (s, a: PayloadAction<{ bookId?: string }>) => {
      if (s.stage.kind !== 'analysing') return;
      const bookId = a.payload?.bookId || s.stage.bookId || 'ns';
      s.stage = { kind: 'confirm', bookId, openProfileId: null };
    },
    confirmCast: (s) => {
      if (s.stage.kind !== 'confirm') return;
      s.stage = { kind: 'ready', bookId: s.stage.bookId, view: 'manuscript', ...READY_DEFAULTS };
    },
    reanalyse: (s, a: PayloadAction<{ manuscriptId?: string | null } | undefined>) => {
      if (s.stage.kind !== 'confirm') return;
      s.stage = {
        kind: 'analysing',
        bookId: s.stage.bookId,
        manuscriptId: a.payload?.manuscriptId ?? null,
      };
    },
    openBook: (
      s,
      a: PayloadAction<{ id: string; status: string; manuscriptId?: string | null }>,
    ) => {
      const { id, status, manuscriptId } = a.payload;
      if (status === 'analysing')
        s.stage = { kind: 'analysing', bookId: id, manuscriptId: manuscriptId ?? null };
      else if (status === 'cast_pending')
        s.stage = { kind: 'confirm', bookId: id, openProfileId: null };
      else {
        const view: View =
          status === 'complete' ? 'listen' : status === 'generating' ? 'generate' : 'cast';
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
      /* Drawer is reachable from cast-confirmation too — clicking a card on
         the "Meet the cast" screen opens the same ProfileDrawer that
         hangs off the ready-stage cast view. */
      if (s.stage.kind !== 'ready' && s.stage.kind !== 'confirm') return;
      s.stage.openProfileId = a.payload;
    },

    /* ── URL hydration ──────────────────────────────────────────────── */
    hydrateFromUrl: (s, a: PayloadAction<Stage>) => {
      if (a.payload && a.payload.kind) s.stage = a.payload;
    },

    /* ── Cross-cutting overlays ─────────────────────────────────────── */
    setCurrentTrack: (s, a: PayloadAction<number | null>) => {
      s.currentTrack = a.payload;
    },
    setMatchDetailFor: (s, a: PayloadAction<string | null>) => {
      s.matchDetailFor = a.payload;
    },
    setHandoffApp: (s, a: PayloadAction<ListenerApp | null>) => {
      s.handoffApp = a.payload;
    },
    setRegenChapter: (s, a: PayloadAction<Chapter | null>) => {
      s.regenChapter = a.payload;
      /* Closing the modal (payload=null) clears any per-open scope override so
         the next per-chapter Regenerate falls back to the modal's default. */
      if (a.payload == null) s.regenInitialScope = null;
    },
    setRegenInitialScope: (s, a: PayloadAction<RegenScope | null>) => {
      s.regenInitialScope = a.payload;
    },
    setRegenCharacterCtx: (s, a: PayloadAction<RegenCharacterCtx | null>) => {
      s.regenCharacterCtx = a.payload;
    },
    setBatchRegenIds: (s, a: PayloadAction<string[] | null>) => {
      s.batchRegenIds = a.payload;
    },
    setStaleAudio: (s, a: PayloadAction<UiState['staleAudio']>) => {
      s.staleAudio = a.payload;
    },
    clearStaleAudio: (s) => {
      s.staleAudio = null;
    },
    setRevisionHistoryFor: (s, a: PayloadAction<{ chapterId: number | null } | null>) => {
      s.revisionHistoryFor = a.payload;
    },
    setShowRevisionPlayer: (s, a: PayloadAction<boolean>) => {
      s.showRevisionPlayer = a.payload;
    },
    setShowDriftReport: (s, a: PayloadAction<boolean>) => {
      s.showDriftReport = a.payload;
    },
    setPreviewMode: (s, a: PayloadAction<boolean>) => {
      s.previewMode = a.payload;
    },
    setSelectedModel: (s, a: PayloadAction<string>) => {
      s.selectedModel = a.payload;
      s.selectedModelExplicit = true;
    },
    setTtsModelKey: (s, a: PayloadAction<TtsModelKey>) => {
      s.ttsModelKey = a.payload;
      s.ttsModelKeyExplicit = true;
    },
    setThemeOverride: (s, a: PayloadAction<'light' | 'dark' | 'system'>) => {
      s.themeOverride = a.payload;
    },
    clearThemeOverride: (s) => {
      s.themeOverride = null;
    },

    /* Plan 74 — flip into re-upload mode and navigate to the upload
       view in one shot. The upload view reads `reuploadingBookId` on
       successful import and routes through the diff modal instead of
       through ConfirmMetadata. */
    startReupload: (s, a: PayloadAction<{ bookId: string }>) => {
      s.reuploadingBookId = a.payload.bookId;
      s.stage = { kind: 'upload' };
    },
    /* Plan 74 — clear the re-upload flag. Fired by the diff modal's
       Apply / Discard paths and on any non-upload stage transition. */
    clearReupload: (s) => {
      s.reuploadingBookId = null;
    },
  },
  extraReducers: (builder) => {
    /* Seed-on-new-book: when the account settings hydrate (boot or save),
       and the user has not explicitly picked a per-session model, seed
       the UI's model selectors from the account defaults. Once the user
       changes a picker, the `…Explicit` flag flips and these reducers
       leave the value alone for the rest of the session. */
    const applyAccountDefaults = (
      s: UiState,
      payload: { defaultAnalysisModel: string; defaultTtsModelKey: TtsModelKey },
    ) => {
      if (!s.selectedModelExplicit && payload.defaultAnalysisModel) {
        s.selectedModel = payload.defaultAnalysisModel;
      }
      const validKey = TTS_MODEL_OPTIONS.some((m) => m.id === payload.defaultTtsModelKey);
      if (!s.ttsModelKeyExplicit && validKey) {
        s.ttsModelKey = payload.defaultTtsModelKey;
      }
    };
    builder
      .addCase(fetchAccountSettings.fulfilled, (s, a) => {
        applyAccountDefaults(s, a.payload);
      })
      .addCase(saveAccountSettings.fulfilled, (s, a) => {
        applyAccountDefaults(s, a.payload);
      });
  },
});

export const uiActions = uiSlice.actions;

export const uiSelectors = {
  stageKind: (s: RootState) => s.ui.stage.kind,
  bookId: (s: RootState) => (s.ui.stage as { bookId?: string }).bookId ?? null,
  view: (s: RootState) => (s.ui.stage.kind === 'ready' ? s.ui.stage.view : null),
  chapterId: (s: RootState) => (s.ui.stage.kind === 'ready' ? s.ui.stage.currentChapterId : null),
  profileId: (s: RootState) =>
    s.ui.stage.kind === 'ready' || s.ui.stage.kind === 'confirm' ? s.ui.stage.openProfileId : null,
};
