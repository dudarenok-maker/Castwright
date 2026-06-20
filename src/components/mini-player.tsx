import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { StatsAccumulator } from '../lib/listen-stats-reporter';
import { Waveform } from './waveform';
import { useKeyBinding } from '../lib/keybindings';
import {
  IconBook,
  IconClock,
  IconClose,
  IconForward,
  IconPause,
  IconPlay,
  IconRewind,
  IconVolume,
  IconWaveform,
} from '../lib/icons';
import { api } from '../lib/api';
import { deriveIssues } from '../lib/chapter-issues';
import { parseDuration, formatTime } from '../lib/time';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import type { Chapter, ChapterAudio } from '../lib/types';
import { useAppDispatch, useAppSelector } from '../store';
import { settingsActions } from '../store/settings-slice';
import {
  getPlaybackRate,
  listenProgressActions,
  selectListenProgress,
  selectPendingSeek,
  type ListenMarker,
} from '../store/listen-progress-slice';
import {
  IDLE,
  SLEEP_TIMER_PRESETS_MIN,
  cancel as sleepCancel,
  isFired as sleepIsFired,
  notifyChapterEnded as sleepNotifyChapterEnded,
  remainingMs as sleepRemainingMs,
  startCountdown as sleepStartCountdown,
  startEndOfChapter as sleepStartEndOfChapter,
  tick as sleepTick,
  type SleepTimerState,
} from '../lib/sleep-timer';

interface MiniPlayerProps {
  chapter: Chapter | null;
  bookId: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  prevAvailable: boolean;
  nextAvailable: boolean;
  /** fs-15 / Task 4 — called exactly once per chapter load when the
   *  playhead enters the final 10 s (or on chapter end). Layout uses
   *  this to fire the auto-finish signal for the FINAL listenable chapter. */
  onCrossedFinish?: () => void;
  autoSeekToIssues?: boolean;
}

/* Plan 53 — playback-rate picker presets. Exposed at module scope so
   the e2e spec can assert against the same list without importing the
   component. */
export const PLAYBACK_RATE_OPTIONS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

/* Format a playbackRate as the picker label ("1.5×"). Single digit
   fractions get a trailing × to mirror standalone-app conventions
   (Voice / BookPlayer / Smart AudioBook Player). */
function formatRate(rate: number): string {
  return `${Number.isInteger(rate) ? rate.toFixed(1) : rate}×`;
}

/* fs-16 — mint a stable session id without Math.random (CodeQL
   js/insecure-randomness). Prefers crypto.randomUUID, then
   getRandomValues; the final fallback is non-random but
   collision-resistant enough for a per-tab dedup key. */
export function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    return 'ss_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return 'ss_' + Date.now().toString(36); // final fallback: NO Math.random
}

export function MiniPlayer({
  chapter,
  bookId,
  onClose,
  onPrev,
  onNext,
  prevAvailable,
  nextAvailable,
  onCrossedFinish,
  autoSeekToIssues = false,
}: MiniPlayerProps) {
  const [audio, setAudio] = useState<ChapterAudio>({ durationSec: 0, peaks: [], url: null });
  const issues = useMemo(() => deriveIssues(audio), [audio]);
  /* Ref so the onLoadedMetadata handler can read the latest issues list
     even if it runs before the first render with non-empty issues. */
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /* Plan 47 — resume seek + debounced save state.
     pendingSeekRef carries the resume point from the on-mount
     api.getListenProgress fetch into the onLoadedMetadata handler,
     where the seek can actually stick (setting el.currentTime before
     metadata loads is unreliable across browsers).
     currentSecRef mirrors currentSec for the flush-on-unmount cleanup
     so the cleanup closure doesn't capture a stale value.
     lastSavedAtRef gates the onTimeUpdate save to once-per-5 s so a
     debounced PUT doesn't fire 60× per minute. */
  const pendingSeekRef = useRef<number | null>(null);
  const currentSecRef = useRef(0);
  const lastSavedAtRef = useRef(0);
  /* Plan 125 — separate, faster throttle for the in-memory live-playhead
     dispatch (the Listen-view row mirrors it). Independent of the 5 s
     disk-save gate above: this only churns Redux, never the disk. */
  const lastLiveDispatchRef = useRef(0);
  /* fs-15 / Task 4 — dedup guard so onCrossedFinish fires at most ONCE
     per chapter load (either from the 10 s tail or from onEnded).
     Reset to false in an effect keyed on chapter.id so switching to a
     new chapter re-arms it. */
  const crossedFinishRef = useRef(false);

  /* fs-16 — wall-clock listening stats. A stable session id minted once
     per page load; shared across book switches in the same tab so the
     server can deduplicate within a session. The accumulator measures real
     elapsed time between play/pause using Date.now(), independent of
     playback rate or seeks. */
  const sessionId = useRef(makeSessionId()).current;
  const accRef = useRef(
    new StatsAccumulator(
      bookId,
      () => Date.now(),
      () => new Date().toLocaleDateString('en-CA'),
    ),
  );

  const flushStats = useCallback(
    (targetBookId: string, days: { date: string; seconds: number }[]) => {
      const nz = days.filter((d) => d.seconds > 0);
      if (!nz.length) return;
      void api.putListenStats(targetBookId, { sessionId, days: nz }).catch(() => {});
    },
    [sessionId],
  );

  /* Plan 53 — playback rate + markers + sleep timer.

     The slice is read once at chapter mount so the rate sticks
     across reload (per-book persistence). Local component state
     drives the picker UI immediately; the same handler then dispatches
     the slice update AND the optional PUT to keep on-disk in sync. */
  const dispatch = useAppDispatch();
  const persisted = useAppSelector(selectListenProgress(bookId));
  /* fe-2 — user-rebindable play/pause key (default Space). Bound below via the
     same window-keydown path as the marker `M` shortcut. Optional-chained so a
     minimal test store that omits the settings slice still renders (the real
     store always wires it — store/index.ts). */
  const playPauseKey = useAppSelector((s) => s.settings?.keybindings?.['play-pause'] ?? 'Space');
  /* fe-23 — auto-advance to the next chapter when one finishes. Default on
     (the slice's initialState), optional-chained so a minimal test store that
     omits the settings slice still defaults sensibly. */
  const autoAdvance = useAppSelector((s) => s.settings?.autoAdvance ?? true);
  /* fe-24 — skip-back/forward deltas + their rebindable keys (default J / L). */
  const skipForwardSec = useAppSelector((s) => s.settings?.skipForwardSec ?? 30);
  const skipBackSec = useAppSelector((s) => s.settings?.skipBackSec ?? 15);
  const skipForwardKey = useAppSelector((s) => s.settings?.keybindings?.['skip-forward'] ?? 'L');
  const skipBackKey = useAppSelector((s) => s.settings?.keybindings?.['skip-back'] ?? 'J');
  const [playbackRate, setPlaybackRate] = useState<number>(() => getPlaybackRate(persisted));
  /* Ref so onLoadedMetadata + the audio.url effect can set
     el.playbackRate without re-running on every rate change. */
  const playbackRateRef = useRef(playbackRate);
  playbackRateRef.current = playbackRate;
  /* fe-25 — device-local output volume (0..1), persisted in the settings slice.
     A ref mirrors it so the audio.url effect can re-apply it on every src/load
     cycle (el.volume snaps back to 1.0 on a fresh load, same as playbackRate). */
  const playerVolume = useAppSelector((s) => s.settings?.playerVolume ?? 1);
  const playerVolumeRef = useRef(playerVolume);
  playerVolumeRef.current = playerVolume;
  /* (Marker list itself is read in the Listen view sidebar via the
     same selector — the mini-player only owns the add-marker entry
     point.) */
  /* Sleep timer — per-session, NOT persisted to listen-progress.json
     (matches every standalone audiobook player). State lives in the
     mini-player so closing it cancels the timer. */
  const [sleepTimer, setSleepTimer] = useState<SleepTimerState>(IDLE);
  /* Hover-driven popovers for the two RHS toolbar buttons. */
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [sleepMenuOpen, setSleepMenuOpen] = useState(false);
  const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
  /* Marker-add inline form — opens under the player when the user
     drops a marker so they can type a label without leaving listen. */
  const [markerDraft, setMarkerDraft] = useState<{ chapterId: number; sec: number } | null>(null);

  /* Fetch the audio meta (url, durationSec, segments) whenever the chapter
     changes. We don't store the chapter id on the audio element because the
     <audio> src swap is driven separately — this effect just owns the
     metadata for the scrubber + duration display.
     Also (plan 47) fetches the resume bookmark in parallel and stashes
     it in pendingSeekRef for onLoadedMetadata to apply; flushes one
     final save on cleanup if currentSecRef > 5 s. */
  useEffect(() => {
    if (!chapter) return;
    setCurrentSec(0);
    currentSecRef.current = 0;
    pendingSeekRef.current = null;
    lastSavedAtRef.current = 0;
    setError(null);
    /* Drop the previous chapter's URL synchronously so the <audio> element
       stops its current playback immediately. Without this reset, src
       continues pointing at chapter A until B's metadata fetch resolves —
       which feels like a stalled click if the network is slow or the fetch
       fails (the old chapter just keeps playing under the new chapter's UI). */
    setAudio({ durationSec: 0, peaks: [], url: null });
    let cancelled = false;
    const chapterId = chapter.id;
    api
      .getChapterAudio({ bookId, chapterId, duration: chapter.duration })
      .then((meta) => {
        if (cancelled) return;
        /* fs-26 — cache-bust the audio URL with the chapter's render stamp so a
           splice that rewrote the bytes in place (gain remix keeps the same URL
           AND duration) still reloads fresh audio rather than the browser's
           cached copy. No-op when audioRenderedAt is absent (legacy chapters). */
        const stamp = chapter.audioRenderedAt;
        const url =
          meta.url && stamp
            ? `${meta.url}${meta.url.includes('?') ? '&' : '?'}v=${encodeURIComponent(stamp)}`
            : meta.url;
        setAudio({ ...meta, url });
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    /* Resume bookmark fetch fires in parallel with the audio meta
       fetch. Stash in a ref instead of calling setCurrentSec right
       now — the audio element's currentTime would just snap back to
       0 inside the audio.url effect below until the metadata lands.
       The actual seek happens in onLoadedMetadata. */
    api
      .getListenProgress(bookId)
      .then((progress) => {
        if (cancelled) return;
        if (progress && progress.chapterId === chapterId) {
          pendingSeekRef.current = progress.currentSec;
        }
      })
      .catch((e) => {
        /* Non-fatal — playback still works without a resume point. */
        console.warn('[mini-player] listen-progress GET failed', (e as Error).message);
      });
    return () => {
      cancelled = true;
      /* Plan 125 — drop the live playhead for the chapter we're leaving so
         a stale entry can't linger past this chapter (or past the player
         closing). The next chapter's first onTimeUpdate re-publishes. */
      dispatch(listenProgressActions.clearLivePlayback());
      /* Flush-on-unmount: persist the latest position if the user got
         past the first 5 s. Skipping when <= 5 s avoids polluting the
         resume point with accidental click-and-close noise. */
      if (currentSecRef.current > 5) {
        void api
          .putListenProgress(bookId, {
            chapterId,
            currentSec: currentSecRef.current,
          })
          .catch((e) => {
            console.warn('[mini-player] listen-progress flush failed', (e as Error).message);
          });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapter?.id, chapter?.duration, chapter?.audioRenderedAt]);

  /* fs-15 / Task 4 — reset the finish-signal dedup ref whenever the
     chapter changes so each new chapter can fire onCrossedFinish once. */
  useEffect(() => {
    crossedFinishRef.current = false;
  }, [chapter?.id]);

  /* When the URL lands, point the audio element at it. Resetting src + load
     also clears any prior playback state from the previous chapter.
     Plan 53: re-apply the persisted playbackRate every time the
     element reloads — el.playbackRate snaps back to 1.0 on every
     new src/load cycle, which would silently undo a 1.5× selection
     across chapter switches without this. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (audio.url) {
      el.src = audio.url;
      el.load();
      el.currentTime = 0;
      el.playbackRate = playbackRateRef.current;
      el.volume = playerVolumeRef.current;
      if (playing)
        void el.play().catch(() => {
          /* user-gesture errors surface via <audio onerror> */
        });
    } else {
      el.removeAttribute('src');
      el.load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.url]);

  /* Plan 53 — reflect the picker selection onto the live element.
     Separate effect (vs. folding into the url effect) so the user can
     change rate mid-playback without forcing a re-load. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = playbackRate;
  }, [playbackRate]);

  /* fe-25 — reflect the volume selection onto the live element. Separate effect
     (like playbackRate) so dragging the slider mid-playback doesn't re-load. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = playerVolume;
  }, [playerVolume]);

  /* Plan 53 — rehydrate the local playbackRate from the slice when
     the persisted record lands (Layout's per-book hydrate effect
     resolves asynchronously, so on first paint persisted=null and
     the local state defaulted to 1.0; once the slice has a value we
     adopt it). Guard on chapter so we don't re-stomp on every render. */
  const persistedRate = persisted?.playbackRate;
  useEffect(() => {
    if (persistedRate !== undefined && persistedRate !== playbackRate) {
      setPlaybackRate(persistedRate);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedRate]);

  /* Plan 53 — one-shot seek requested by the listen-view marker
     click. When the request targets the currently-playing chapter,
     the mini-player's own chapter-mount path doesn't fire (chapter
     id unchanged), so this effect carries the seek through. When the
     request targets a DIFFERENT chapter, setCurrentTrack in the
     listen view has already fired and the mini-player will remount
     with a fresh pendingSeekRef path; the request still gets
     consumed here so it doesn't re-fire on the next pass. */
  const pendingSeek = useAppSelector(selectPendingSeek(bookId));
  useEffect(() => {
    if (!pendingSeek || !chapter) return;
    if (pendingSeek.chapterId !== chapter.id) {
      /* Chapter-switch case — let the chapter-mount effect's
         listen-progress fetch carry the seek through pendingSeekRef.
         Stamp the same value into pendingSeekRef directly so the
         next onLoadedMetadata fires it (the fetch resolves async). */
      pendingSeekRef.current = pendingSeek.sec;
      dispatch(listenProgressActions.consumeSeek({ requestId: pendingSeek.requestId }));
      return;
    }
    const el = audioRef.current;
    if (el && Number.isFinite(el.duration) && el.duration > 0) {
      el.currentTime = pendingSeek.sec;
      setCurrentSec(pendingSeek.sec);
      currentSecRef.current = pendingSeek.sec;
    } else {
      /* Audio not yet loaded for this chapter — stash for the next
         onLoadedMetadata to consume (same path as the resume seek). */
      pendingSeekRef.current = pendingSeek.sec;
    }
    dispatch(listenProgressActions.consumeSeek({ requestId: pendingSeek.requestId }));
  }, [pendingSeek, chapter, dispatch]);

  /* Reflect the React `playing` flag onto the element. Browsers may also flip
     `playing` externally (ended → false) — those paths use setPlaying directly
     so this effect won't trigger spurious play()/pause() calls. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audio.url) return;
    if (playing) {
      void el.play().catch(() => {
        /* swallow; <audio onerror> covers real failures */
      });
    } else {
      el.pause();
    }
  }, [playing, audio.url]);

  /* fs-16 — keep the accumulator in sync with the play/pause state.
     Intentionally separate from the element-reflect effect above so it
     fires even before audio.url resolves (the user may have started
     "playing" before the fetch returns). onPlay/onPause are idempotent
     (no-op if already in the target state). */
  useEffect(() => {
    if (playing) {
      accRef.current.onPlay();
    } else {
      accRef.current.onPause();
    }
  }, [playing]);

  /* fs-16 — flush the prior book's tally when bookId changes (book switch).
     The isMounted guard skips the initial render so we only flush on real
     switches. switchBook() returns the prior book's data and re-targets the
     accumulator to the new bookId. */
  const bookSwitchMountedRef = useRef(false);
  useEffect(() => {
    if (!bookSwitchMountedRef.current) {
      bookSwitchMountedRef.current = true;
      return;
    }
    const prior = accRef.current.switchBook(bookId);
    flushStats(prior.bookId, prior.days);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  /* Plan 53 — playback-rate picker handler. Three fan-outs:
     - local state for instant UI feedback
     - slice update so other surfaces (sidebar pill, future surfaces)
       see the same rate without re-fetching
     - PUT to disk so the rate survives reload. Position-only PUTs
       from onTimeUpdate stay light (no rate echo) because the slice
       remembers the rate locally; this single rate PUT keeps disk
       authoritative. */
  const onChangePlaybackRate = useCallback(
    (rate: number) => {
      setPlaybackRate(rate);
      setSpeedMenuOpen(false);
      dispatch(listenProgressActions.setPlaybackRate({ bookId, playbackRate: rate }));
      if (!chapter) return;
      const chapterId = chapter.id;
      const sec = currentSecRef.current;
      void api
        .putListenProgress(bookId, {
          chapterId,
          currentSec: sec,
          playbackRate: rate,
        })
        .catch((err) => {
          console.warn('[mini-player] playback-rate save failed', (err as Error).message);
        });
    },
    [bookId, chapter, dispatch],
  );

  /* Plan 53 — marker-add. Captures current chapter + position, opens
     the inline label form. The actual slice + disk write fires on
     form submit (or implicit submit when the user closes without
     typing — empty label is allowed). */
  const startMarkerDraft = useCallback(() => {
    if (!chapter) return;
    setMarkerDraft({ chapterId: chapter.id, sec: currentSecRef.current });
  }, [chapter]);

  const commitMarkerDraft = useCallback(
    (label: string) => {
      if (!markerDraft) return;
      /* crypto.randomUUID exists in Chromium 92+ / Safari 15.4+; both
         our e2e + production browsers are well past that. Fall back
         to a timestamp-id so a stub environment (jsdom < 21) doesn't
         null-deref. */
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `mk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const marker: ListenMarker = {
        id,
        chapterId: markerDraft.chapterId,
        sec: markerDraft.sec,
        label,
        kind: 'note',
        createdAt: new Date().toISOString(),
      };
      dispatch(listenProgressActions.addMarker({ bookId, marker }));
      setMarkerDraft(null);
      /* Persist the new full marker list. Read the slice for the
         freshest list rather than appending here — Immer + the
         dispatch above are synchronous so the next selector call
         would land the new marker, but we already have it in scope. */
      const nextMarkers = [...(persisted?.markers ?? []), marker];
      const chapterId = chapter?.id ?? markerDraft.chapterId;
      void api
        .putListenProgress(bookId, {
          chapterId,
          currentSec: currentSecRef.current,
          markers: nextMarkers,
        })
        .catch((err) => {
          console.warn('[mini-player] marker save failed', (err as Error).message);
        });
    },
    [bookId, chapter?.id, dispatch, markerDraft, persisted?.markers],
  );

  const cancelMarkerDraft = useCallback(() => setMarkerDraft(null), []);

  /* Jump to the previous (dir = -1) or next (dir = 1) issue relative to
     the live playhead. A 0.25 s deadband prevents getting "stuck" on the
     issue the scrubber is already sitting on. */
  const jumpToIssue = useCallback(
    (dir: 1 | -1) => {
      const t = currentSecRef.current;
      const target =
        dir > 0
          ? issues.find((r) => r.seekSec > t + 0.25)
          : [...issues].reverse().find((r) => r.seekSec < t - 0.25);
      if (!target) return;
      const el = audioRef.current;
      if (el) el.currentTime = target.seekSec;
      setCurrentSec(target.seekSec);
      currentSecRef.current = target.seekSec;
    },
    [issues],
  );

  /* Plan 53 — `M` keyboard shortcut. Bound to window so the user can
     drop a marker without focusing the mini-player. Inputs / textareas
     get a pass so typing M inside the marker-label field doesn't trip
     a recursive marker-drop. */
  useEffect(() => {
    if (!chapter) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'm' && e.key !== 'M') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      startMarkerDraft();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chapter, startMarkerDraft]);

  /* fe-2 — play/pause shortcut (default Space, rebindable in Account →
     Advanced). Toggles the same local `playing` state as the on-screen button;
     gated on a loaded chapter so it's inert when the player is closed. */
  const togglePlay = useCallback(() => setPlaying((v) => !v), []);
  useKeyBinding(playPauseKey, togglePlay, Boolean(chapter));

  /* fe-24 — seek the playhead by `delta` seconds (negative = back), clamped to
     [0, duration]. Duration comes from the live element when finite, else the
     server-provided durationSec (the browser estimate is unreliable for legacy
     Xing-less MP3s — see the plan 109 note). Mirrors the local currentSec +
     currentSecRef so the scrubber + flush-on-unmount stay accurate. */
  const seekBy = useCallback(
    (delta: number) => {
      const el = audioRef.current;
      if (!el) return;
      const dur =
        Number.isFinite(el.duration) && el.duration > 0 ? el.duration : audio.durationSec;
      const base = Number.isFinite(el.currentTime) ? el.currentTime : currentSecRef.current;
      const next = Math.max(0, Math.min(dur > 0 ? dur : base + delta, base + delta));
      el.currentTime = next;
      setCurrentSec(next);
      currentSecRef.current = next;
    },
    [audio.durationSec],
  );
  const skipForward = useCallback(() => seekBy(skipForwardSec), [seekBy, skipForwardSec]);
  const skipBack = useCallback(() => seekBy(-skipBackSec), [seekBy, skipBackSec]);
  useKeyBinding(skipForwardKey, skipForward, Boolean(chapter));
  useKeyBinding(skipBackKey, skipBack, Boolean(chapter));

  /* Plan 53 — sleep-timer countdown tick. Only mounted while the
     timer is in the countdown state; ticks once per second. End-of-
     chapter mode is driven by the audio onEnded handler below. */
  useEffect(() => {
    if (sleepTimer.kind !== 'countdown') return;
    const id = setInterval(() => {
      setSleepTimer((prev) => sleepTick(prev));
    }, 1000);
    return () => clearInterval(id);
  }, [sleepTimer.kind]);

  /* Plan 53 — react to the timer firing. Pauses the player + clears
     the timer back to idle so the user's next play click isn't
     instantly re-paused. The existing onTimeUpdate flush will catch
     the resulting position on the next render. */
  useEffect(() => {
    if (!sleepIsFired(sleepTimer)) return;
    setPlaying(false);
    setSleepTimer(IDLE);
  }, [sleepTimer]);

  /* fs-16 — keepalive flush on tab hide / page unload. Uses the raw fetch
     keepalive flag so the request survives navigation. Bypasses the mock
     api intentionally — the keepalive path is a safety net, not the primary
     flush; the 5-s periodic flush via api.putListenStats is what matters
     (and is tested). */
  useEffect(() => {
    const onHide = () => {
      const { days } = accRef.current.drain();
      const nz = days.filter((d) => d.seconds > 0);
      if (!nz.length) return;
      void fetch(`/api/books/${encodeURIComponent(bookId)}/listen-stats`, {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, days: nz }),
      }).catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [bookId, sessionId]);

  if (!chapter) return null;
  const totalSec = audio.durationSec || parseDuration(chapter.duration);
  const progress = totalSec ? currentSec / totalSec : 0;

  const onScrub = (e: MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const next = pct * totalSec;
    setCurrentSec(next);
    if (el && Number.isFinite(el.duration)) el.currentTime = next;
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 fade-in">
      <div className="bg-ink text-canvas border-t border-canvas/10 backdrop-blur-md">
        {/* Plan 81 wave 2 — responsive mini-player. Tighter padding + gap
            on `<sm:` viewports (Pixel 7 is 412 px wide); ≥44 px touch
            targets on prev/play/next (WCAG 2.5.5). The 5-column grid still
            works on mobile because cols 1's inner text + col 5's marker /
            sleep-time labels already `hidden md:block` away, leaving
            waveform icon + play controls + scrubber + speed pill +
            close — fits 412 px. */}
        <div className="max-w-[1500px] mx-auto px-3 sm:px-6 py-3 grid grid-cols-[auto_minmax(0,2fr)_auto_minmax(0,3fr)_auto] items-center gap-2 sm:gap-5">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-11 h-11 rounded-xl bg-gradient-cta shrink-0 grid place-items-center">
              <IconWaveform className="w-4 h-4 text-white/70" />
            </span>
            <div className="min-w-0 hidden md:block">
              <p className="text-sm font-semibold truncate">
                CH {String(chapter.id).padStart(2, '0')} · {stripChapterPrefix(chapter.title)}
              </p>
              <p className="text-[11px] text-canvas/60 truncate">
                {error ? <span className="text-rose-300">{error}</span> : 'Preview'}
              </p>
            </div>
          </div>
          <span />
          <div className="flex items-center gap-2">
            <button
              onClick={onPrev}
              disabled={!prevAvailable}
              aria-label="Previous chapter"
              className="p-2 min-w-[44px] min-h-[44px] rounded-full hover:bg-canvas/10 disabled:opacity-30 grid place-items-center"
            >
              <IconRewind className="w-4 h-4" />
            </button>
            {/* fe-24 — skip back N seconds (default 15). Smaller icon than the
                prev/next chapter buttons so the transport group still fits the
                412 px mobile layout; touch target stays ≥44 px. */}
            <button
              onClick={skipBack}
              aria-label={`Skip back ${skipBackSec} seconds`}
              data-testid="mini-player-skip-back"
              title={`Skip back ${skipBackSec}s (${skipBackKey})`}
              className="relative p-2 min-w-[44px] min-h-[44px] rounded-full hover:bg-canvas/10 grid place-items-center"
            >
              <IconRewind className="w-3.5 h-3.5" />
              <span className="absolute bottom-0.5 right-0.5 text-[8px] font-semibold tabular-nums text-canvas/70">
                {skipBackSec}
              </span>
            </button>
            <button
              onClick={() => setPlaying(!playing)}
              aria-label={playing ? 'Pause' : 'Play'}
              className="w-11 h-11 sm:w-10 sm:h-10 rounded-full bg-canvas text-ink grid place-items-center hover:bg-white"
            >
              {playing ? (
                <IconPause className="w-4 h-4" />
              ) : (
                <IconPlay className="w-4 h-4 ml-0.5" />
              )}
            </button>
            {/* fe-24 — skip forward N seconds (default 30). */}
            <button
              onClick={skipForward}
              aria-label={`Skip forward ${skipForwardSec} seconds`}
              data-testid="mini-player-skip-forward"
              title={`Skip forward ${skipForwardSec}s (${skipForwardKey})`}
              className="relative p-2 min-w-[44px] min-h-[44px] rounded-full hover:bg-canvas/10 grid place-items-center"
            >
              <IconForward className="w-3.5 h-3.5" />
              <span className="absolute bottom-0.5 right-0.5 text-[8px] font-semibold tabular-nums text-canvas/70">
                {skipForwardSec}
              </span>
            </button>
            <button
              onClick={onNext}
              disabled={!nextAvailable}
              aria-label="Next chapter"
              className="p-2 min-w-[44px] min-h-[44px] rounded-full hover:bg-canvas/10 disabled:opacity-30 grid place-items-center"
            >
              <IconForward className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[11px] tabular-nums text-canvas/60 w-10 text-right">
              {formatTime(currentSec)}
            </span>
            <div
              onClick={onScrub}
              data-testid="mini-player-scrubber"
              className="flex-1 relative cursor-pointer group h-7"
            >
              <Waveform progress={progress} active peaks={audio.peaks} issues={audio.peaks?.length ? issues : undefined} />
              <div
                className="absolute bottom-0 left-0 h-[2px] rounded-full bg-gradient-progress pointer-events-none"
                style={{ width: `${progress * 100}%` }}
              />
              <span
                data-testid="scrubber-thumb"
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-canvas opacity-0 group-hover:opacity-100 coarse-pointer:opacity-100 transition-opacity pointer-events-none"
                style={{ left: `${progress * 100}%` }}
              />
            </div>
            <span className="text-[11px] tabular-nums text-canvas/60 w-10">
              {formatTime(totalSec)}
            </span>
          </div>
          <div className="flex items-center gap-2 relative">
            {/* Plan 53 — playback-speed picker. Click toggles a popover
                with the six preset rates; the current rate sits in
                the button label so the user can see it at a glance
                without opening the menu. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setSpeedMenuOpen((v) => !v);
                  setSleepMenuOpen(false);
                }}
                aria-label="Playback speed"
                data-testid="mini-player-speed-toggle"
                aria-expanded={speedMenuOpen}
                aria-haspopup="menu"
                className="px-2.5 py-1 rounded-full hover:bg-canvas/10 text-[11px] tabular-nums font-semibold text-canvas/80"
              >
                {formatRate(playbackRate)}
              </button>
              {speedMenuOpen && (
                <div
                  role="menu"
                  data-testid="mini-player-speed-menu"
                  className="absolute bottom-full right-0 mb-2 min-w-[100px] rounded-xl bg-ink-soft border border-canvas/10 shadow-float py-1 z-10"
                >
                  {PLAYBACK_RATE_OPTIONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      role="menuitemradio"
                      aria-checked={playbackRate === r}
                      data-testid={`mini-player-speed-option-${r}`}
                      onClick={() => onChangePlaybackRate(r)}
                      className={`block w-full text-left px-3 py-1.5 text-xs tabular-nums hover:bg-canvas/10 ${
                        playbackRate === r ? 'text-canvas font-semibold' : 'text-canvas/70'
                      }`}
                    >
                      {formatRate(r)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Jump-to-issue: prev (desktop only) + next (phone ≥44px). */}
            {issues.length > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => jumpToIssue(-1)}
                  aria-label="Previous issue"
                  title="Previous issue"
                  className="hidden md:grid place-items-center p-2 rounded-full hover:bg-canvas/10 text-amber-300"
                >
                  <span aria-hidden>‹⚠</span>
                </button>
                <button
                  type="button"
                  onClick={() => jumpToIssue(1)}
                  aria-label="Next issue"
                  title="Next issue"
                  data-testid="mini-player-next-issue"
                  className="grid place-items-center min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 md:p-2 rounded-full hover:bg-canvas/10 text-amber-300"
                >
                  <span aria-hidden>⚠›</span>
                </button>
              </div>
            )}
            {/* Plan 53 — drop-marker button. Captures chapterId +
                currentSec into a draft, which the inline form below
                the player commits. `M` shortcut hits the same path. */}
            <button
              type="button"
              onClick={startMarkerDraft}
              aria-label="Add marker (M)"
              data-testid="mini-player-add-marker"
              title="Add marker (M)"
              className="p-2 rounded-full hover:bg-canvas/10 hidden md:grid place-items-center"
            >
              <IconBook className="w-4 h-4" />
            </button>
            {/* Plan 53 — sleep timer. Clock icon toggles a popover with
                the four preset countdowns + end-of-chapter mode. When
                a timer is armed the button surfaces the remaining
                time. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setSleepMenuOpen((v) => !v);
                  setSpeedMenuOpen(false);
                }}
                aria-label="Sleep timer"
                data-testid="mini-player-sleep-toggle"
                aria-expanded={sleepMenuOpen}
                aria-haspopup="menu"
                title="Sleep timer"
                className="p-2 rounded-full hover:bg-canvas/10 hidden md:grid place-items-center"
              >
                <IconClock className="w-4 h-4" />
              </button>
              {sleepMenuOpen && (
                <div
                  role="menu"
                  data-testid="mini-player-sleep-menu"
                  className="absolute bottom-full right-0 mb-2 min-w-[160px] rounded-xl bg-ink-soft border border-canvas/10 shadow-float py-1 z-10"
                >
                  {SLEEP_TIMER_PRESETS_MIN.map((min) => (
                    <button
                      key={min}
                      type="button"
                      role="menuitem"
                      data-testid={`mini-player-sleep-option-${min}`}
                      onClick={() => {
                        setSleepTimer(sleepStartCountdown(min * 60_000));
                        setSleepMenuOpen(false);
                      }}
                      className="block w-full text-left px-3 py-1.5 text-xs tabular-nums hover:bg-canvas/10 text-canvas/80"
                    >
                      {min} min
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="mini-player-sleep-option-end-of-chapter"
                    onClick={() => {
                      setSleepTimer(sleepStartEndOfChapter());
                      setSleepMenuOpen(false);
                    }}
                    className="block w-full text-left px-3 py-1.5 text-xs hover:bg-canvas/10 text-canvas/80"
                  >
                    End of chapter
                  </button>
                  {sleepTimer.kind !== 'idle' && (
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="mini-player-sleep-cancel"
                      onClick={() => {
                        setSleepTimer(sleepCancel());
                        setSleepMenuOpen(false);
                      }}
                      className="block w-full text-left px-3 py-1.5 text-xs hover:bg-canvas/10 text-rose-300 border-t border-canvas/10 mt-1 pt-1.5"
                    >
                      Cancel timer
                    </button>
                  )}
                </div>
              )}
            </div>
            {sleepTimer.kind === 'countdown' && (
              <span
                data-testid="mini-player-sleep-pill"
                className="text-[10px] tabular-nums text-canvas/60 hidden md:inline"
              >
                {formatTime(Math.ceil((sleepRemainingMs(sleepTimer) ?? 0) / 1000))}
              </span>
            )}
            {sleepTimer.kind === 'end-of-chapter' && (
              <span
                data-testid="mini-player-sleep-pill"
                className="text-[10px] uppercase tracking-widest text-canvas/60 hidden md:inline"
              >
                End of ch
              </span>
            )}
            {/* fe-25 — output volume. The button toggles a slider popover;
                the icon dims at low/zero level so muting reads at a glance. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setVolumeMenuOpen((v) => !v);
                  setSpeedMenuOpen(false);
                  setSleepMenuOpen(false);
                }}
                aria-label="Volume"
                data-testid="mini-player-volume-toggle"
                aria-expanded={volumeMenuOpen}
                aria-haspopup="menu"
                title={`Volume ${Math.round(playerVolume * 100)}%`}
                className={`p-2 rounded-full hover:bg-canvas/10 hidden md:grid place-items-center min-h-[44px] sm:min-h-0 ${
                  playerVolume === 0 ? 'text-canvas/40' : 'text-canvas/80'
                }`}
              >
                <IconVolume className="w-4 h-4" />
              </button>
              {volumeMenuOpen && (
                <div
                  role="menu"
                  data-testid="mini-player-volume-menu"
                  className="absolute bottom-full right-0 mb-2 px-3 py-2 rounded-xl bg-ink-soft border border-canvas/10 shadow-float z-10 flex items-center gap-2"
                >
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={playerVolume}
                    onChange={(e) =>
                      dispatch(settingsActions.setPlayerVolume(Number(e.target.value)))
                    }
                    aria-label="Volume level"
                    data-testid="mini-player-volume-slider"
                    className="w-28 accent-magenta"
                  />
                  <span className="text-[11px] tabular-nums text-canvas/70 w-9 text-right">
                    {Math.round(playerVolume * 100)}%
                  </span>
                </div>
              )}
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-canvas/10">
              <IconClose className="w-4 h-4" />
            </button>
          </div>
        </div>
        {markerDraft && (
          <MarkerDraftForm
            chapterId={markerDraft.chapterId}
            sec={markerDraft.sec}
            onCommit={commitMarkerDraft}
            onCancel={cancelMarkerDraft}
          />
        )}
        <audio
          ref={audioRef}
          preload="metadata"
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            setCurrentSec(t);
            currentSecRef.current = t;
            /* Plan 125 — publish the live playhead (throttled, ~2 Hz) so
               the Listen-view chapter row mirrors elapsed + waveform
               instead of running a decorative animation. No noise floor
               (the row tracks from 0:00) and independent of the disk-save
               gate below. `totalSec` is the same resolved value the player
               displays, so the row matches its total to the second. */
            if (chapter) {
              const liveNow = Date.now();
              if (liveNow - lastLiveDispatchRef.current >= 500) {
                lastLiveDispatchRef.current = liveNow;
                dispatch(
                  listenProgressActions.setLivePlayback({
                    bookId,
                    chapterId: chapter.id,
                    currentSec: t,
                    durationSec: totalSec,
                  }),
                );
              }
            }
            /* fs-15 / Task 4 — auto-finish signal. Fire once when the
               playhead enters the final 10 s of a chapter with
               duration > 10 s. The dedup ref prevents double-fire on
               subsequent ticks or when onEnded also runs. Uses the live
               audio element duration (e.currentTarget.duration) so the
               threshold is accurate even for chapters where the server's
               durationSec differs from the browser's estimate. */
            {
              const duration = e.currentTarget.duration;
              const remaining = duration - t;
              if (
                duration > 10 &&
                remaining <= 10 &&
                !crossedFinishRef.current
              ) {
                crossedFinishRef.current = true;
                onCrossedFinish?.();
              }
            }
            /* Plan 47 — debounced save. Once per 5 s of wall-clock,
               post the position so a refresh / close / app crash
               loses at most ~5 s of resume accuracy. Don't dispatch
               through Redux for this — slice churn on every tick
               would re-render too much; the listen-progress slice
               hydrates on book load + on chapter mount, both of
               which already cover the read path. */
            if (!chapter) return;
            const now = Date.now();
            if (now - lastSavedAtRef.current < 5000) return;
            if (t <= 5) return;
            lastSavedAtRef.current = now;
            const chapterId = chapter.id;
            void api.putListenProgress(bookId, { chapterId, currentSec: t }).catch((err) => {
              console.warn('[mini-player] listen-progress save failed', (err as Error).message);
            });
            /* fs-16 — periodic listen-stats flush (same 5 s gate, no extra
               tick overhead). tick() attributes elapsed wall-clock since the
               last checkpoint, then drain() returns the accumulated seconds
               (without clearing) for the flush helper to post. */
            accRef.current.tick();
            flushStats(bookId, accRef.current.drain().days);
          }}
          onLoadedMetadata={(e) => {
            const target = e.currentTarget;
            const d = target.duration;
            if (Number.isFinite(d) && d > 0) {
              /* Plan 109 — the server's durationSec (from segments.json, PCM-
                 exact) is authoritative; don't clobber it with the browser's
                 estimate, which is wildly inflated for any legacy MP3 that
                 shipped without a Xing VBR header. Adopt the element's value
                 only when the server gave us nothing. */
              setAudio((a) => (a.durationSec > 0 ? a : { ...a, durationSec: d }));
              /* Context-gated auto-seek: in the generate view, land on
                 the first issue rather than the resume bookmark. Setting
                 pendingSeekRef to null suppresses the resume block below. */
              if (autoSeekToIssues && issuesRef.current.length > 0) {
                const first = issuesRef.current[0].seekSec;
                target.currentTime = first;
                setCurrentSec(first);
                currentSecRef.current = first;
                pendingSeekRef.current = null;
              }
              /* Plan 47 — apply the resume bookmark now that the
                 audio element knows its duration. Cap at d - 1 so a
                 resume point parked near the end of the chapter
                 doesn't immediately trigger onEnded. */
              const pending = pendingSeekRef.current;
              if (pending != null && pending > 0 && pending < d - 1) {
                target.currentTime = pending;
                setCurrentSec(pending);
                currentSecRef.current = pending;
              }
              pendingSeekRef.current = null;
              /* Plan 53 — re-apply the picked playback rate. Browsers
                 reset el.playbackRate on every load, even when load is
                 driven by the same src; without this the user's 1.5×
                 selection silently undoes after the resume seek. */
              target.playbackRate = playbackRateRef.current;
              /* fe-25 — el.volume also resets on load; re-apply the saved level. */
              target.volume = playerVolumeRef.current;
            }
          }}
          onEnded={() => {
            /* Plan 53 — feed the chapter-end event into the sleep
               timer state machine. End-of-chapter mode transitions
               to fired here; countdown / idle states ignore it.
               fe-23 — compute the sleep transition FIRST so we can tell
               whether the end-of-chapter timer just fired (which must
               stop playback, not advance). */
            const nextSleep = sleepNotifyChapterEnded(sleepTimer);
            setSleepTimer(nextSleep);
            /* fs-16 — flush any final accumulated seconds on chapter end.
               onPause() is idempotent (safe even if already paused). */
            accRef.current.onPause();
            flushStats(bookId, accRef.current.drain().days);
            /* fs-15 / Task 4 — fire the finish signal on ended if the
               10 s tail hasn't already done so (dedup ref prevents
               double-fire when both paths trigger). */
            if (!crossedFinishRef.current) {
              crossedFinishRef.current = true;
              onCrossedFinish?.();
            }
            /* fe-23 — auto-advance: roll into the next chapter only when the
               user opted in, there IS a next chapter, and the sleep timer
               didn't just fire on this chapter's end. Keep `playing` true so
               the next chapter starts immediately. Last/single-chapter books
               fall out naturally via nextAvailable === false. */
            if (autoAdvance && nextAvailable && !sleepIsFired(nextSleep)) {
              onNext();
            } else {
              setPlaying(false);
            }
          }}
          onError={() => setError('Audio failed to load.')}
          className="hidden"
        />
      </div>
    </div>
  );
}

/* Plan 53 — inline marker-label form. Renders under the mini-player
   strip when the user clicks "Add marker" or hits M. Submitting (with
   or without a label) commits to the slice + disk; Esc / clicking
   Cancel discards. Kept local to the mini-player so the marker-add
   flow is self-contained. */
interface MarkerDraftFormProps {
  chapterId: number;
  sec: number;
  onCommit: (label: string) => void;
  onCancel: () => void;
}
function MarkerDraftForm({ chapterId, sec, onCommit, onCancel }: MarkerDraftFormProps) {
  const [label, setLabel] = useState('');
  /* Imperative focus on mount via useEffect — the JSX `autoFocus`
     attribute trips a11y lint (jsx-a11y/no-autofocus) because it
     hijacks focus on every page load, but a one-shot focus inside a
     just-opened inline form IS the right UX (user clicked Add
     marker and wants to type immediately). */
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <form
      data-testid="mini-player-marker-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCommit(label);
      }}
      className="max-w-[1500px] mx-auto px-6 py-2 flex items-center gap-3 bg-ink/95 border-t border-canvas/10"
    >
      <span className="text-[10px] uppercase tracking-widest text-canvas/50 shrink-0">
        Marker · CH {String(chapterId).padStart(2, '0')} · {formatTime(sec)}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Label (optional)…"
        data-testid="mini-player-marker-input"
        className="flex-1 bg-transparent border-b border-canvas/20 text-sm text-canvas placeholder:text-canvas/30 focus:outline-hidden focus:border-canvas/60 py-1"
      />
      <button
        type="submit"
        data-testid="mini-player-marker-save"
        className="px-3 py-1 rounded-full bg-canvas text-ink text-xs font-semibold hover:bg-white"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        data-testid="mini-player-marker-cancel"
        className="px-3 py-1 rounded-full text-canvas/60 text-xs hover:text-canvas"
      >
        Cancel
      </button>
    </form>
  );
}
