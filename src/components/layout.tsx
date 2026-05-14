import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { castActions } from '../store/cast-slice';
import { fetchAccountSettings } from '../store/account-slice';
import { chaptersActions, STALL_THRESHOLD_MS } from '../store/chapters-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { revisionsActions } from '../store/revisions-slice';
import { libraryActions } from '../store/library-slice';
import { voicesActions } from '../store/voices-slice';
import { changeLogActions } from '../store/change-log-slice';
import { bookMetaActions, narratorNameFromCast } from '../store/book-meta-slice';
import {
  buildChapterRegenEvent,
  buildCharacterRegenEvent,
  buildBatchCharacterRegenEvent,
  buildVoiceTuneEvent,
  buildVoiceLockEvent,
} from '../lib/change-log';
import { overallProgress, sentencesPerChapter } from '../lib/generation-progress';
import { api } from '../lib/api';
import { engineForModelKey } from '../lib/tts-models';
import { stageToHash } from '../lib/router';
import { TopBar, type GenerationPillData } from './top-bar';
import { MiniPlayer } from './mini-player';
import { PreviewListenerView } from '../views/preview-listener';
import { MatchDetailDrawer } from '../modals/match-detail';
import { AppHandoffModal } from '../modals/app-handoff';
import { RegenerateModal } from '../modals/regenerate';
import { CharacterRegenerateModal } from '../modals/character-regenerate';
import { BatchCharacterRegenerateModal } from '../modals/batch-character-regenerate';
import { DriftReportModal } from '../modals/drift-report';
import { ProfileDrawer } from '../modals/profile-drawer';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { RevisionDiffPlayer } from '../views/revision-diff';
import { IconRefresh, IconWarning } from '../lib/icons';

/* Lifted from App.tsx's resultDialog state. Routes that need to surface a
   styled post-action dialog (e.g. BooksRoute after delete/reparse) pull
   showInfo/showError from outlet context. */
export interface LayoutContext {
  showInfo: (args: {
    title: string;
    body: ReactNode;
    eyebrow?: string;
    primaryLabel?: string;
    onPrimary?: () => void;
  }) => void;
  showError: (title: string, body: ReactNode, eyebrow?: string) => void;
}

export function Layout() {
  const dispatch = useAppDispatch();
  const stage      = useAppSelector(s => s.ui.stage);
  const ui         = useAppSelector(s => s.ui);
  const userDisplayName = useAppSelector(s => s.account.displayName);
  const characters = useAppSelector(s => s.cast.characters);
  const chapters   = useAppSelector(s => s.chapters.chapters);
  const paused     = useAppSelector(s => s.chapters.paused);
  const lastError  = useAppSelector(s => s.chapters.lastError);
  const lastTickAt = useAppSelector(s => s.chapters.lastTickAt);
  const sentences  = useAppSelector(s => s.manuscript.sentences);
  const drift      = useAppSelector(s => s.revisions.drift);
  const pending    = useAppSelector(s => s.revisions.pending);
  const manuscript = useAppSelector(s => s.manuscript);
  const library    = useAppSelector(s => s.library);
  const voices     = useAppSelector(s => s.voices.voices);

  const stageKind   = stage.kind;
  const bookId      = (stage as { bookId?: string }).bookId ?? null;
  const view        = stage.kind === 'ready' ? stage.view : null;
  const openProfileId = stage.kind === 'ready' ? stage.openProfileId : null;

  const matchCharacter = ui.matchDetailFor ? characters.find(c => c.id === ui.matchDetailFor) ?? null : null;
  const matchVoice     = matchCharacter ? voices.find(v => v.id === matchCharacter.voiceId) ?? null : null;
  const profileCharacter = openProfileId ? characters.find(c => c.id === openProfileId) ?? null : null;
  const profileVoice     = profileCharacter ? voices.find(v => v.id === profileCharacter.voiceId) ?? null : null;
  const regenCharacter = ui.regenCharacterCtx ? characters.find(c => c.id === ui.regenCharacterCtx!.characterId) ?? null : null;
  const activeBook     = library.books.find(b => b.bookId === bookId);
  const projectTitle   = (stageKind === 'upload' || stageKind === 'books')
    ? null
    : (manuscript.title || activeBook?.title || null);
  const trackChapter   = ui.currentTrack != null ? chapters.find(c => c.id === ui.currentTrack) ?? null : null;
  const trackIdx       = trackChapter ? chapters.indexOf(trackChapter) : -1;
  const prevTrackAvailable = trackIdx > 0;
  const nextTrackAvailable = trackIdx >= 0 && trackIdx < chapters.length - 1;

  const [resultDialog, setResultDialog] = useState<{
    open: boolean;
    kind: 'info' | 'error';
    eyebrow?: string;
    title: string;
    body: ReactNode;
    primaryLabel?: string;
    onPrimary?: () => void;
  } | null>(null);
  const showInfo: LayoutContext['showInfo'] = (args) =>
    setResultDialog({ open: true, kind: 'info', ...args });
  const showError: LayoutContext['showError'] = (title, body, eyebrow) =>
    setResultDialog({ open: true, kind: 'error', title, body, eyebrow });

  /* Redux → URL sync. Skip the first effect run so a deep-link mount
     (e.g. user opens #/books/abc/cast?chapter=5) doesn't race the route
     element's URL → Redux hydration and clobber back to '/'. After that,
     any dispatch that changes ui.stage gets pushed to the URL via
     react-router's navigate (replace semantics to match the old behavior). */
  const navigate = useNavigate();
  const location = useLocation();
  const skipFirst = useRef(true);
  useEffect(() => {
    if (skipFirst.current) { skipFirst.current = false; return; }
    const target = stageToHash(stage).slice(1);
    const current = location.pathname + location.search;
    if (current !== target) navigate(target, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  /* Account hydration — fetch user-level account settings once on mount so
     the avatar can show the persisted display name and book hydration can
     read defaults from the account slice. Fires once per app boot. */
  useEffect(() => {
    void dispatch(fetchAccountSettings());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Library hydration — fetch the on-disk workspace whenever the user
     returns to the books stage, and once at mount. */
  useEffect(() => {
    if (stageKind !== 'books' && library.loaded) return;
    let cancelled = false;
    api.getLibrary()
      .then(res => { if (!cancelled) dispatch(libraryActions.hydrate(res)); })
      .catch(err => { console.error('[library] hydrate failed', err); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKind]);

  /* Voice library hydration — derived from every confirmed cast on disk.
     Re-fires when the active book or selected TTS engine changes so
     `source: 'current'` and the engine-specific ttsVoice labels are correct
     for the current UI state. */
  const ttsEngine = useAppSelector(s => engineForModelKey(s.ui.ttsModelKey));
  useEffect(() => {
    let cancelled = false;
    api.getVoices({ currentBookId: bookId ?? undefined, engine: ttsEngine })
      .then(res => { if (!cancelled) dispatch(voicesActions.hydrate(res)); })
      .catch(err => { console.error('[voices] hydrate failed', err); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind, ttsEngine]);

  /* Per-book hydration. When the user opens a book whose redux state isn't
     populated (page refresh, library click on a previously analysed book, or
     library click on a book mid-analysis), fetch the on-disk .audiobook/*.json
     and seed each slice. */
  useEffect(() => {
    if (!bookId) return;
    if (stageKind !== 'analysing' && stageKind !== 'confirm' && stageKind !== 'ready') return;
    if (manuscript.manuscriptId && manuscript.title) return;
    let cancelled = false;
    api.getBookState(bookId)
      .then(res => {
        if (cancelled) return;
        dispatch(manuscriptActions.hydrateFromBookState({
          state: res.state,
          sentences: res.manuscriptEdits?.sentences ?? null,
          wordCount: res.manuscript?.wordCount ?? null,
          format: res.manuscript?.format ?? null,
        }));
        if (res.cast?.characters?.length) {
          dispatch(castActions.setCharacters(res.cast.characters));
        }
        dispatch(chaptersActions.hydrateFromBookState({
          chapters: res.state.chapters,
          completedSlugs: res.completedSlugs ?? [],
          characters: res.cast?.characters ?? [],
          chapterCharacters: res.chapterCharacters,
        }));
        dispatch(revisionsActions.hydrateFromBookState(res.revisions ?? null));
        dispatch(changeLogActions.hydrateFromBookState(res.changeLog ?? null));
        /* Editable Listen-view metadata: seed from state.json's editorial
           fields, falling back to the cast narrator's name when the book
           predates the narratorCredit field. */
        dispatch(bookMetaActions.hydrateFromBookState({
          bookId,
          state: {
            title:           res.state.title,
            author:          res.state.author,
            series:          res.state.series,
            narratorCredit:  res.state.narratorCredit ?? null,
            genre:           res.state.genre ?? null,
            publicationDate: res.state.publicationDate ?? null,
          },
          narratorFallback: narratorNameFromCast(res.cast?.characters ?? []),
        }));
      })
      .catch(err => { console.warn('[book-state] hydrate skipped:', err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind]);

  /* Book-meta fallback hydration — covers the mock-mode path where
     getBookState rejects (no disk workspace) and the realer flow where the
     library lands before the per-book state fetch. Seeds saved[bookId] from
     the library entry the first time the user opens a book; the on-disk
     fetch above overwrites it with the authoritative state.json values when
     it lands. */
  const libraryBooks = useAppSelector(s => s.library.books);
  const bookMetaSavedKeys = useAppSelector(s => Object.keys(s.bookMeta.saved).join('|'));
  useEffect(() => {
    if (!bookId || stageKind !== 'ready') return;
    if (bookMetaSavedKeys.split('|').includes(bookId)) return;
    const entry = libraryBooks.find(b => b.bookId === bookId);
    if (!entry) return;
    dispatch(bookMetaActions.hydrateFromBookState({
      bookId,
      state: { title: entry.title, author: entry.author, series: entry.series },
      narratorFallback: narratorNameFromCast(characters),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind, libraryBooks, bookMetaSavedKeys]);

  /* Voice matching — fires once when analysis completes (stage becomes
     'confirm'). Real backend: POST /api/books/:bookId/voice-match. */
  useEffect(() => {
    if (stageKind !== 'confirm' || !bookId) return;
    let cancelled = false;
    api.matchVoices({ bookId, characters }).then(res => {
      if (!cancelled) dispatch(castActions.applyVoiceMatches(res));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageKind, bookId]);

  /* Revisions + drift poll — runs while the book is open ('ready'). */
  useEffect(() => {
    if (stageKind !== 'ready' || !bookId) return;
    let cancelled = false;
    const fetchOnce = () => api.pollRevisions({ bookId }).then(res => {
      if (!cancelled) dispatch(revisionsActions.applyPoll(res));
    });
    fetchOnce();
    const t = setInterval(fetchOnce, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, [stageKind, bookId, dispatch]);

  if (ui.previewMode) {
    return <PreviewListenerView chapters={chapters} characters={characters}
      onExit={() => dispatch(uiActions.setPreviewMode(false))}
      currentTrack={ui.currentTrack}
      setCurrentTrack={(t) => dispatch(uiActions.setCurrentTrack(t))}/>;
  }

  const ctx: LayoutContext = { showInfo, showError };

  /* Re-render once per second while a generation run is alive so the global
     pill's "stalled" computation has a clock to react against. The middleware
     keeps the SSE open across view navigation; this is purely a UI tick to
     surface elapsed-since-last-tick. */
  const [, forceClockTick] = useState(0);
  const hasGenerationWork = chapters.some(c => c.state === 'in_progress' || c.state === 'queued') || lastError != null;
  useEffect(() => {
    if (!hasGenerationWork) return;
    const id = setInterval(() => forceClockTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [hasGenerationWork]);

  /* Computed inline (not memoised) because the stalled check reads Date.now();
     the surrounding component re-renders once per second via forceClockTick
     while a run is alive, so this stays in sync without manual deps. */
  const generationPill: GenerationPillData | null = (() => {
    if (!hasGenerationWork) return null;
    const bookForPill = bookId ?? null;
    if (!bookForPill && !lastError) return null;

    const done = chapters.filter(c => c.state === 'done').length;
    const total = chapters.length;
    const counts = sentencesPerChapter(sentences);
    const percent = Math.round(overallProgress(chapters, counts) * 100);
    const inProgressCount = chapters.filter(c => c.state === 'in_progress').length;
    const stalled = !paused && inProgressCount > 0 && lastTickAt != null
      && (Date.now() - lastTickAt) > STALL_THRESHOLD_MS;
    const state: GenerationPillData['state'] = lastError ? 'halted' : stalled ? 'stalled' : 'running';
    return {
      state,
      done,
      total,
      percent,
      onClick: () => {
        if (bookForPill) navigate(`/books/${bookForPill}/generate`);
      },
    };
  })();

  return (
    <div className={`min-h-screen ${trackChapter ? 'pb-24' : 'pb-20'}`}>
      <TopBar stage={stageKind} view={view}
        setView={(v) => dispatch(uiActions.changeView(v))}
        projectTitle={projectTitle}
        onHome={() => dispatch(uiActions.goHome())}
        onTitleClick={stageKind === 'confirm' ? () => dispatch(uiActions.reanalyse()) : undefined}
        pendingRevisionsCount={pending.length}
        generationPill={generationPill}
        onOpenRevisions={() => dispatch(uiActions.setShowRevisionPlayer(true))}
        onOpenVoices={() => dispatch(uiActions.openVoices())}
        onOpenChangelog={() => dispatch(uiActions.openChangelog())}
        onOpenAccount={() => dispatch(uiActions.openAccount())}
        userDisplayName={userDisplayName}/>

      <Outlet context={ctx}/>

      {stageKind === 'ready' && bookId && (
        <MiniPlayer chapter={trackChapter} bookId={bookId}
          onClose={() => dispatch(uiActions.setCurrentTrack(null))}
          onPrev={() => prevTrackAvailable && dispatch(uiActions.setCurrentTrack(chapters[trackIdx - 1].id))}
          onNext={() => nextTrackAvailable && dispatch(uiActions.setCurrentTrack(chapters[trackIdx + 1].id))}
          prevAvailable={prevTrackAvailable} nextAvailable={nextTrackAvailable}/>
      )}

      {ui.matchDetailFor && (
        <MatchDetailDrawer character={matchCharacter} voice={matchVoice}
          onClose={() => dispatch(uiActions.setMatchDetailFor(null))}
          onConfirm={() => dispatch(uiActions.setMatchDetailFor(null))}
          onDecline={() => {
            if (ui.matchDetailFor) dispatch(castActions.declineMatch(ui.matchDetailFor));
            dispatch(uiActions.setMatchDetailFor(null));
          }}/>
      )}
      {ui.handoffApp && (
        <AppHandoffModal app={ui.handoffApp}
          onClose={() => dispatch(uiActions.setHandoffApp(null))}
          onComplete={() => dispatch(uiActions.setHandoffApp(null))}/>
      )}
      {ui.regenChapter && (
        <RegenerateModal chapter={ui.regenChapter}
          defaultScope={ui.regenInitialScope ?? 'this'}
          onClose={() => dispatch(uiActions.setRegenChapter(null))}
          onConfirm={({ reason, scope, note }) => {
            const chapter = ui.regenChapter;
            if (chapter) {
              const affectedCount = scope === 'forward'
                ? chapters.filter(c => c.id >= chapter.id).length
                : 1;
              dispatch(changeLogActions.appendLogEvent(
                buildChapterRegenEvent({ chapter, scope, reason, note, affectedChapterCount: affectedCount }),
              ));
              dispatch(chaptersActions.regenerateChapter({ chapterId: chapter.id, scope }));
            }
            dispatch(uiActions.setRegenChapter(null));
            dispatch(uiActions.changeView('generate'));
          }}/>
      )}
      {ui.regenCharacterCtx && (
        <CharacterRegenerateModal character={regenCharacter} chapters={chapters}
          defaultChapterId={ui.regenCharacterCtx.defaultChapterId}
          onClose={() => dispatch(uiActions.setRegenCharacterCtx(null))}
          onConfirm={({ characterId, chapterIds, reason, note }) => {
            if (regenCharacter) {
              dispatch(changeLogActions.appendLogEvent(
                buildCharacterRegenEvent({ character: regenCharacter, chapterIds, reason, note }),
              ));
            }
            dispatch(chaptersActions.regenerateCharacter({ characterId, chapterIds }));
            dispatch(uiActions.setRegenCharacterCtx(null));
            dispatch(uiActions.changeView('generate'));
          }}/>
      )}
      {ui.batchRegenIds && (
        <BatchCharacterRegenerateModal characterIds={ui.batchRegenIds} characters={characters} chapters={chapters}
          onClose={() => dispatch(uiActions.setBatchRegenIds(null))}
          onConfirm={({ characterIds, chapterIds, reason, note }) => {
            const targets = characters.filter(c => characterIds.includes(c.id));
            if (targets.length) {
              dispatch(changeLogActions.appendLogEvent(
                buildBatchCharacterRegenEvent({ characters: targets, chapterIds, reason, note }),
              ));
            }
            dispatch(chaptersActions.batchRegenerateCharacters({ characterIds, chapterIds }));
            dispatch(uiActions.setBatchRegenIds(null));
            dispatch(uiActions.changeView('generate'));
          }}/>
      )}
      {ui.showDriftReport && (
        <DriftReportModal events={drift} characters={characters}
          onClose={() => dispatch(uiActions.setShowDriftReport(false))}
          onRegenerateChapter={(charId, chapterId) => {
            dispatch(uiActions.setShowDriftReport(false));
            dispatch(uiActions.setRegenCharacterCtx({ characterId: charId, defaultChapterId: chapterId }));
          }}
          onDismiss={(eventId) => dispatch(revisionsActions.dismissDrift(eventId))}/>
      )}
      {profileCharacter && (
        <ProfileDrawer
          character={profileCharacter}
          voice={profileVoice ?? undefined}
          mergeCandidates={bookId ? characters.filter(c => c.id !== profileCharacter.id) : undefined}
          onMerge={bookId ? async (sourceId, targetId) => {
            const res = await api.mergeCharacters({ bookId, sourceId, targetId });
            dispatch(castActions.applyMerge({ characters: res.characters }));
            /* Source character has just disappeared from the cast — drop the
               drawer so React doesn't try to render a profile for a missing
               id on the next pass. */
            dispatch(uiActions.setOpenProfileId(null));
          } : undefined}
          onClose={() => dispatch(uiActions.setOpenProfileId(null))}
          onSave={(updated, meta) => {
            dispatch(castActions.setCharacters(characters.map(c => c.id === updated.id ? updated : c)));
            /* Only log a tune event when the drawer actually saved a tuned
               voice — the drawer also fires onSave from the "Discard"-less
               identity edits via the same path, and we don't want to spam
               the audit trail when no real tuning happened. */
            if (updated.voiceState === 'tuned') {
              dispatch(changeLogActions.appendLogEvent(buildVoiceTuneEvent({
                character: updated,
                hadConflict: meta.hadConflict,
              })));
            }
            dispatch(uiActions.setOpenProfileId(null));
          }}
          onLock={(character) => {
            /* Idempotent: clicking Lock when already locked is a no-op for
               the slice but still useful as a manual re-acknowledge — but
               the change-log entry would be redundant, so skip it. */
            if (character.voiceState === 'locked') return;
            dispatch(castActions.lockVoice(character.id));
            dispatch(changeLogActions.appendLogEvent(buildVoiceLockEvent({ character })));
          }}
          onShowMatchDetail={(id) => dispatch(uiActions.setMatchDetailFor(id))}
          onRegenerateCharacter={(charId) => dispatch(uiActions.setRegenCharacterCtx({ characterId: charId }))}/>
      )}
      {ui.showRevisionPlayer && pending[0] && (
        <RevisionDiffPlayer revision={pending[0]}
          chapter={chapters.find(c => c.id === pending[0].chapterId)}
          character={characters.find(c => c.id === pending[0].characterId)}
          onClose={() => dispatch(uiActions.setShowRevisionPlayer(false))}
          onAccept={() => { dispatch(revisionsActions.acceptAllPending()); dispatch(uiActions.setShowRevisionPlayer(false)); }}
          onReject={() => { dispatch(revisionsActions.rejectAllPending()); dispatch(uiActions.setShowRevisionPlayer(false)); }}/>
      )}
      {resultDialog && (
        <ConfirmDialog
          open={resultDialog.open}
          eyebrow={resultDialog.eyebrow}
          title={resultDialog.title}
          icon={resultDialog.kind === 'error' ? <IconWarning className="w-4 h-4"/> : <IconRefresh className="w-4 h-4"/>}
          variant={resultDialog.kind === 'error' ? 'danger' : 'default'}
          body={resultDialog.body}
          primaryLabel={resultDialog.kind === 'info' ? resultDialog.primaryLabel : undefined}
          onPrimaryAction={resultDialog.kind === 'info' ? resultDialog.onPrimary : undefined}
          onClose={() => setResultDialog(null)}
        />
      )}
    </div>
  );
}

