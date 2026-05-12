import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from './store';
import { uiActions } from './store/ui-slice';
import { castActions } from './store/cast-slice';
import { chaptersActions } from './store/chapters-slice';
import { manuscriptActions } from './store/manuscript-slice';
import { revisionsActions } from './store/revisions-slice';
import { api } from './lib/api';
import { BOOKS } from './data/books';
import { VOICE_LIBRARY } from './data/voice-library';
import { CHANGE_LOG_EVENTS } from './data/change-log';
import { TopBar } from './components/top-bar';
import { MiniPlayer } from './components/mini-player';
import { UploadView } from './views/upload';
import { AnalysingView } from './views/analysing';
import { ConfirmCastView } from './views/confirm-cast';
import { ManuscriptView } from './views/manuscript';
import { CastView } from './views/cast';
import { LibraryView } from './views/voices';
import { GenerationView } from './views/generation';
import { ListenView } from './views/listen';
import { PreviewListenerView } from './views/preview-listener';
import { BookLibraryView } from './views/book-library';
import { ChangeLogView } from './views/change-log';
import { RevisionDiffPlayer } from './views/revision-diff';
import { MatchDetailDrawer } from './modals/match-detail';
import { AppHandoffModal } from './modals/app-handoff';
import { RegenerateModal } from './modals/regenerate';
import { CharacterRegenerateModal } from './modals/character-regenerate';
import { BatchCharacterRegenerateModal } from './modals/batch-character-regenerate';
import { DriftReportModal } from './modals/drift-report';
import { ProfileDrawer } from './modals/profile-drawer';
import type { Character } from './lib/types';

export function App() {
  const dispatch = useAppDispatch();
  const stage      = useAppSelector(s => s.ui.stage);
  const ui         = useAppSelector(s => s.ui);
  const characters = useAppSelector(s => s.cast.characters);
  const chapters   = useAppSelector(s => s.chapters.chapters);
  const paused     = useAppSelector(s => s.chapters.paused);
  const drift      = useAppSelector(s => s.revisions.drift);
  const pending    = useAppSelector(s => s.revisions.pending);
  const manuscript = useAppSelector(s => s.manuscript);

  const stageKind   = stage.kind;
  const bookId      = (stage as { bookId?: string }).bookId ?? null;
  const view        = stage.kind === 'ready' ? stage.view : null;
  const currentChapterId = stage.kind === 'ready' ? stage.currentChapterId : null;
  const openProfileId    = stage.kind === 'ready' ? stage.openProfileId    : null;

  const matchCharacter = ui.matchDetailFor ? characters.find(c => c.id === ui.matchDetailFor) ?? null : null;
  const matchVoice     = matchCharacter ? VOICE_LIBRARY.find(v => v.id === matchCharacter.voiceId) ?? null : null;
  const profileCharacter = openProfileId ? characters.find(c => c.id === openProfileId) ?? null : null;
  const profileVoice     = profileCharacter ? VOICE_LIBRARY.find(v => v.id === profileCharacter.voiceId) ?? null : null;
  const regenCharacter = ui.regenCharacterCtx ? characters.find(c => c.id === ui.regenCharacterCtx!.characterId) ?? null : null;
  const activeBook     = BOOKS.find(b => b.id === bookId);
  const projectTitle   = (stageKind === 'upload' || stageKind === 'books')
    ? null
    : (manuscript.title || activeBook?.title || null);
  const trackChapter   = ui.currentTrack != null ? chapters.find(c => c.id === ui.currentTrack) ?? null : null;
  const trackIdx       = trackChapter ? chapters.indexOf(trackChapter) : -1;
  const prevTrackAvailable = trackIdx > 0;
  const nextTrackAvailable = trackIdx >= 0 && trackIdx < chapters.length - 1;

  const setCharacters = (next: Character[] | ((prev: Character[]) => Character[])) =>
    dispatch(castActions.setCharacters(typeof next === 'function' ? next(characters) : next));

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

  return (
    <div className={`min-h-screen ${trackChapter ? 'pb-24' : 'pb-20'}`}>
      <TopBar stage={stageKind} view={view}
        setView={(v) => dispatch(uiActions.changeView(v))}
        projectTitle={projectTitle}
        onHome={() => dispatch(uiActions.goHome())}
        onTitleClick={stageKind === 'confirm' ? () => dispatch(uiActions.reanalyse()) : undefined}
        pendingRevisionsCount={pending.length}
        onOpenRevisions={() => dispatch(uiActions.setShowRevisionPlayer(true))}/>

      {stageKind === 'books' && (
        <BookLibraryView books={BOOKS} activeBookId={bookId}
          onOpenBook={(b) => dispatch(uiActions.openBook({ id: b.id, status: b.status }))}
          onStartNew={() => dispatch(uiActions.startNewBook())}/>
      )}
      {stageKind === 'upload' && (
        <UploadView onUploaded={(res) => {
          dispatch(manuscriptActions.uploadComplete(res));
          dispatch(uiActions.manuscriptUploaded({ manuscriptId: res.manuscriptId }));
        }}/>
      )}
      {stageKind === 'analysing' && (
        <AnalysingView
          manuscriptId={stage.kind === 'analysing' ? stage.manuscriptId : null}
          title={manuscript.title}
          model={ui.selectedModel}
          onComplete={(payload) => {
            dispatch(castActions.hydrateFromAnalysis(payload));
            dispatch(chaptersActions.hydrateFromAnalysis(payload));
            dispatch(manuscriptActions.hydrateFromAnalysis(payload));
            dispatch(uiActions.analysisComplete({ bookId: payload.bookId }));
          }}/>
      )}
      {stageKind === 'confirm' && (
        <ConfirmCastView characters={characters} library={VOICE_LIBRARY}
          title={manuscript.title}
          onConfirm={() => dispatch(uiActions.confirmCast())}
          onReanalyse={() => dispatch(uiActions.reanalyse())}/>
      )}

      {stageKind === 'ready' && (
        <>
          {view === 'manuscript' && (
            <ManuscriptView characters={characters} chapters={chapters}
              currentChapterId={currentChapterId}
              setCurrentChapterId={(id) => dispatch(uiActions.setCurrentChapterId(id))}
              sentencesFromStore={manuscript.sentences}
              onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
              onStartGenerating={() => dispatch(uiActions.changeView('generate'))}/>
          )}
          {view === 'cast' && (
            <CastView characters={characters} setCharacters={setCharacters} library={VOICE_LIBRARY}
              onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
              onShowMatchDetail={(id) => dispatch(uiActions.setMatchDetailFor(id))}
              onBatchRegenerate={(ids) => dispatch(uiActions.setBatchRegenIds(ids))}
              driftEvents={drift}
              onShowDrift={() => dispatch(uiActions.setShowDriftReport(true))}/>
          )}
          {view === 'library'  && <LibraryView library={VOICE_LIBRARY}/>}
          {view === 'generate' && (
            <GenerationView chapters={chapters} characters={characters}
              paused={paused}
              setPaused={(p) => dispatch(chaptersActions.setPaused(p))}
              onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
              onRegenerateCharacterInChapter={(charId, chapterId) =>
                dispatch(uiActions.setRegenCharacterCtx({ characterId: charId, defaultChapterId: chapterId }))}/>
          )}
          {view === 'listen' && (
            <ListenView chapters={chapters} characters={characters} library={VOICE_LIBRARY}
              currentTrack={ui.currentTrack}
              setCurrentTrack={(t) => dispatch(uiActions.setCurrentTrack(t))}
              onSendApp={(app) => dispatch(uiActions.setHandoffApp(app))}
              onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
              onEnterPreview={() => dispatch(uiActions.setPreviewMode(true))}/>
          )}
          {view === 'log' && <ChangeLogView events={CHANGE_LOG_EVENTS}/>}
        </>
      )}

      {stageKind === 'ready' && (
        <MiniPlayer chapter={trackChapter}
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
          onClose={() => dispatch(uiActions.setRegenChapter(null))}
          onConfirm={({ scope }) => {
            if (ui.regenChapter) {
              dispatch(chaptersActions.regenerateChapter({ chapterId: ui.regenChapter.id, scope }));
            }
            dispatch(uiActions.setRegenChapter(null));
            dispatch(uiActions.changeView('generate'));
          }}/>
      )}
      {ui.regenCharacterCtx && (
        <CharacterRegenerateModal character={regenCharacter} chapters={chapters}
          defaultChapterId={ui.regenCharacterCtx.defaultChapterId}
          onClose={() => dispatch(uiActions.setRegenCharacterCtx(null))}
          onConfirm={({ characterId, chapterIds }) => {
            dispatch(chaptersActions.regenerateCharacter({ characterId, chapterIds }));
            dispatch(uiActions.setRegenCharacterCtx(null));
            dispatch(uiActions.changeView('generate'));
          }}/>
      )}
      {ui.batchRegenIds && (
        <BatchCharacterRegenerateModal characterIds={ui.batchRegenIds} characters={characters} chapters={chapters}
          onClose={() => dispatch(uiActions.setBatchRegenIds(null))}
          onConfirm={({ characterIds, chapterIds }) => {
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
          onClose={() => dispatch(uiActions.setOpenProfileId(null))}
          onSave={(updated) => {
            setCharacters(prev => prev.map(c => c.id === updated.id ? updated : c));
            dispatch(uiActions.setOpenProfileId(null));
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
    </div>
  );
}
