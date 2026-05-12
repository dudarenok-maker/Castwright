import { useEffect, useState, type ReactNode } from 'react';
import { useAppDispatch, useAppSelector } from './store';
import { uiActions } from './store/ui-slice';
import { castActions } from './store/cast-slice';
import { chaptersActions } from './store/chapters-slice';
import { manuscriptActions } from './store/manuscript-slice';
import { revisionsActions } from './store/revisions-slice';
import { libraryActions } from './store/library-slice';
import { voicesActions } from './store/voices-slice';
import { api } from './lib/api';
import { engineForModelKey } from './lib/tts-models';
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
import { ConfirmMetadataView } from './views/confirm-metadata';
import { ChangeLogView } from './views/change-log';
import { RevisionDiffPlayer } from './views/revision-diff';
import { MatchDetailDrawer } from './modals/match-detail';
import { AppHandoffModal } from './modals/app-handoff';
import { RegenerateModal } from './modals/regenerate';
import { CharacterRegenerateModal } from './modals/character-regenerate';
import { BatchCharacterRegenerateModal } from './modals/batch-character-regenerate';
import { DriftReportModal } from './modals/drift-report';
import { ProfileDrawer } from './modals/profile-drawer';
import { ConfirmDialog } from './modals/confirm-dialog';
import { IconRefresh, IconWarning } from './lib/icons';
import { MODEL_OPTIONS } from './lib/models';
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
  const library    = useAppSelector(s => s.library);
  const voices     = useAppSelector(s => s.voices.voices);

  const stageKind   = stage.kind;
  const bookId      = (stage as { bookId?: string }).bookId ?? null;
  const view        = stage.kind === 'ready' ? stage.view : null;
  const currentChapterId = stage.kind === 'ready' ? stage.currentChapterId : null;
  const openProfileId    = stage.kind === 'ready' ? stage.openProfileId    : null;

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

  const setCharacters = (next: Character[] | ((prev: Character[]) => Character[])) =>
    dispatch(castActions.setCharacters(typeof next === 'function' ? next(characters) : next));

  /* App-level styled toast/dialog. Lifted up so any view can surface a
     post-action message in the same visual language as the regen / confirm
     dialogs (replaces window.alert calls). Body is ReactNode so callers can
     embed structured content (tables, lists). primaryLabel + onPrimary turn
     the info-mode button into a forward-navigation CTA (e.g. "Analyse now"
     after a re-parse) rather than a plain dismiss. */
  const [resultDialog, setResultDialog] = useState<{
    open: boolean;
    kind: 'info' | 'error';
    eyebrow?: string;
    title: string;
    body: ReactNode;
    primaryLabel?: string;
    onPrimary?: () => void;
  } | null>(null);
  const showInfo = (args: {
    title: string;
    body: ReactNode;
    eyebrow?: string;
    primaryLabel?: string;
    onPrimary?: () => void;
  }) => setResultDialog({ open: true, kind: 'info', ...args });
  const showError = (title: string, body: ReactNode, eyebrow?: string) =>
    setResultDialog({ open: true, kind: 'error', title, body, eyebrow });

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
     and seed each slice. Includes 'analysing' so the AnalysingView's size-
     aware ETA copy gets a real wordCount even when the user arrived via
     openBook (the upload-and-analyse path already populates the slice). The
     book-state route 404s for fresh uploads without disk state — the catch
     below swallows that silently, and hydrateFromBookState only overwrites
     fields when valid, so this is safe to run during analysis. */
  useEffect(() => {
    if (!bookId) return;
    if (stageKind !== 'analysing' && stageKind !== 'confirm' && stageKind !== 'ready') return;
    if (manuscript.manuscriptId && manuscript.title) return; // already populated
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
        }));
        dispatch(revisionsActions.applyPoll({
          pending: res.revisions?.pending ?? [],
          drift:   res.revisions?.drift   ?? [],
        }));
      })
      .catch(err => { console.warn('[book-state] hydrate skipped:', err.message); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, stageKind]);

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
        onOpenRevisions={() => dispatch(uiActions.setShowRevisionPlayer(true))}
        onOpenVoices={() => dispatch(uiActions.openVoices())}
        onOpenChangelog={() => dispatch(uiActions.openChangelog())}/>

      {stageKind === 'books' && (
        <BookLibraryView authors={library.authors} activeBookId={bookId}
          onOpenBook={(b) => dispatch(uiActions.openBook({ id: b.bookId, status: b.status, manuscriptId: b.manuscriptId }))}
          onDeleteBook={async (b) => {
            try {
              await api.deleteBook(b.bookId);
            } catch (err) {
              showError(`Couldn't delete "${b.title}"`, (err as Error).message, 'Delete');
              return;
            }
            const res = await api.getLibrary().catch(() => null);
            if (res) dispatch(libraryActions.hydrate(res));
            if (bookId === b.bookId) dispatch(uiActions.goHome());
          }}
          onReparseBook={async (b) => {
            let result;
            try {
              result = await api.reparseBook(b.bookId);
            } catch (err) {
              showError(`Couldn't re-parse "${b.title}"`, (err as Error).message, 'Re-parse');
              return;
            }
            /* Re-fetch the library so chapter counts / status update on the
               card. The book status flips back to 'cast_pending' on the
               next library scan (castConfirmed=false in state.json). */
            const res = await api.getLibrary().catch(() => null);
            if (res) dispatch(libraryActions.hydrate(res));
            /* If the user has this book open, drop the in-memory slices that
               keyed off the old chapter list. Easiest: bounce them home —
               next open re-hydrates from the fresh state.json. */
            if (bookId === b.bookId) dispatch(uiActions.goHome());

            const chapters = result.chapterTitles;
            const body = <ReparseResultBody bookTitle={b.title} chapters={chapters}/>;

            const updatedBook = res?.authors
              .flatMap(a => a.series.flatMap(s => s.books))
              .find(book => book.bookId === b.bookId);

            showInfo({
              eyebrow: 'Re-parse',
              title: 'Manuscript re-parsed',
              body,
              primaryLabel: 'Analyse now',
              onPrimary: () => {
                /* Send the user straight into analysis with the freshest
                   library record so openBook routes to the correct stage
                   based on the post-reparse status. */
                const target = updatedBook ?? b;
                dispatch(uiActions.openBook({
                  id: target.bookId,
                  status: 'analysing',
                  manuscriptId: target.manuscriptId,
                }));
              },
            });
          }}
          onStartNew={() => dispatch(uiActions.startNewBook())}/>
      )}
      {stageKind === 'upload' && (
        manuscript.importCandidate
          ? <ConfirmMetadataView/>
          : <UploadView/>
      )}
      {stageKind === 'analysing' && (
        <AnalysingView
          manuscriptId={stage.kind === 'analysing' ? stage.manuscriptId : null}
          title={manuscript.title || activeBook?.title || null}
          wordCount={manuscript.wordCount}
          model={ui.selectedModel}
          onComplete={(payload) => {
            dispatch(castActions.hydrateFromAnalysis(payload));
            dispatch(chaptersActions.hydrateFromAnalysis(payload));
            dispatch(manuscriptActions.hydrateFromAnalysis(payload));
            dispatch(uiActions.analysisComplete({ bookId: payload.bookId }));
          }}/>
      )}
      {stageKind === 'confirm' && (
        <ConfirmCastView characters={characters} library={voices}
          title={manuscript.title}
          onConfirm={() => dispatch(uiActions.confirmCast())}
          onReanalyse={() => dispatch(uiActions.reanalyse())}/>
      )}
      {stageKind === 'voices'    && <LibraryView library={voices}/>}
      {stageKind === 'changelog' && <ChangeLogView events={CHANGE_LOG_EVENTS}/>}{/* no title → "across your library" */}

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
            <CastView characters={characters} setCharacters={setCharacters} library={voices}
              title={projectTitle}
              onOpenProfile={(id) => dispatch(uiActions.setOpenProfileId(id))}
              onShowMatchDetail={(id) => dispatch(uiActions.setMatchDetailFor(id))}
              onBatchRegenerate={(ids) => dispatch(uiActions.setBatchRegenIds(ids))}
              driftEvents={drift}
              onShowDrift={() => dispatch(uiActions.setShowDriftReport(true))}/>
          )}
          {view === 'library'  && <LibraryView library={voices}/>}
          {view === 'generate' && stage.kind === 'ready' && (
            <GenerationView chapters={chapters} characters={characters}
              paused={paused}
              title={projectTitle}
              bookId={stage.bookId}
              modelKey={ui.ttsModelKey}
              setPaused={(p) => dispatch(chaptersActions.setPaused(p))}
              onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
              onRegenerateCharacterInChapter={(charId, chapterId) =>
                dispatch(uiActions.setRegenCharacterCtx({ characterId: charId, defaultChapterId: chapterId }))}/>
          )}
          {view === 'listen' && (
            <ListenView chapters={chapters} characters={characters} library={voices}
              currentTrack={ui.currentTrack}
              setCurrentTrack={(t) => dispatch(uiActions.setCurrentTrack(t))}
              onSendApp={(app) => dispatch(uiActions.setHandoffApp(app))}
              onRegenerate={(ch) => dispatch(uiActions.setRegenChapter(ch))}
              onEnterPreview={() => dispatch(uiActions.setPreviewMode(true))}/>
          )}
          {view === 'log' && <ChangeLogView events={CHANGE_LOG_EVENTS} title={projectTitle}/>}
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

/* Body shown inside the re-parse result dialog. Lives outside the parent's
   stale-closure scope so the model picker reads live redux state — the
   user's choice here lands in ui.selectedModel and the analysing view
   picks it up when "Analyse now" routes there. */
function ReparseResultBody({ bookTitle, chapters }: { bookTitle: string; chapters: string[] }) {
  const dispatch = useAppDispatch();
  const selectedModel = useAppSelector(s => s.ui.selectedModel);
  return (
    <div className="space-y-3">
      <p>
        <span className="font-semibold text-ink">{chapters.length}</span>{' '}
        chapter{chapters.length === 1 ? '' : 's'} detected in{' '}
        <span className="font-semibold text-ink">{bookTitle}</span>.
      </p>
      <div className="rounded-2xl border border-ink/10 overflow-hidden">
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-ink/[0.03] text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
              <tr>
                <th className="text-right tabular-nums px-3 py-2 w-12">#</th>
                <th className="text-left px-3 py-2">Chapter title</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {chapters.map((title, i) => (
                <tr key={i} className="hover:bg-ink/[0.02]">
                  <td className="text-right tabular-nums text-ink/50 px-3 py-2 w-12">{i + 1}</td>
                  <td className="text-ink px-3 py-2 font-medium">{title}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Model picker inline with the dialog. Writes to redux so the
          analysing view consumes the user's pick when "Analyse now" routes
          there. Defaults to whatever was last selected — common case is
          they want to switch off Gemma. */}
      <label className="flex items-center justify-between gap-3 rounded-2xl bg-canvas border border-ink/10 px-3 py-2.5">
        <span className="text-sm font-medium text-ink">Analyse with</span>
        <select
          value={selectedModel}
          onChange={(e) => dispatch(uiActions.setSelectedModel(e.target.value))}
          className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-medium text-ink focus:outline-none focus:ring-2 focus:ring-magenta/30"
        >
          {MODEL_OPTIONS.map(m => (
            <option key={m.id} value={m.id} title={m.hint}>{m.label}</option>
          ))}
        </select>
      </label>

      <p className="text-ink/55 text-xs">
        Cast and analysis cache were cleared. Hit "Analyse now" to run character detection + sentence attribution against the new chapter list. You can still switch models on the analysing screen if the run goes sideways.
      </p>
    </div>
  );
}
