/* Cast-design stream middleware — owns the SINGLE SSE to the server's bulk
   "Design full cast" job and keeps the third top-bar status pill ticking
   across navigation and a browser reload.

   Unlike the analysis middleware (which owns a SECOND, subscribe-only SSE
   alongside the analysing view's own stream), this middleware owns the ONLY
   stream — the Cast view never opens one; it just dispatches a request action
   and reads progress from the `castDesign` slice. So both the START path
   (`designAllRequested`, with the character-id list) and the cold-boot
   RE-SUBSCRIBE path (`resubscribe`, a bare POST that re-attaches to an
   in-flight server job after a reload) run here.

   Re-entrancy: one open `handle` at a time (a single in-memory server job per
   book is the contract). A second start while one runs is ignored — the Cast
   view also disables the button, so this is belt-and-braces.

   Terminal summary: on `idle` the slice flips to `state:'done'` (the pill shows
   "Designed N · M failed · K skipped" briefly), a summary toast fires, and a
   short timer clears the snapshot — guarded so a new run started inside the
   window isn't wiped.

   Pairs with docs/features/NNN-design-full-cast.md. */

import type { Dispatch, Middleware } from '@reduxjs/toolkit';
import { api, type CastDesignCallbacks } from '../lib/api';
import { castDesignActions, type DesignAllRequestedPayload } from './cast-design-slice';
import { castActions } from './cast-slice';
import { notificationsActions } from './notifications-slice';
import { emitLanguageGuard } from '../lib/language-guard-bus';

const REQUESTED_TYPE = castDesignActions.designAllRequested.type;
const RESUBSCRIBE_TYPE = castDesignActions.resubscribe.type;
const SINGLE_REQUESTED_TYPE = castDesignActions.designSingleRequested.type;
const RESUBSCRIBE_SINGLE_TYPE = castDesignActions.resubscribeSingle.type;
const CLEAR_TYPE = castDesignActions.clear.type;

/** ms the terminal "Designed N…" summary lingers before the pill clears. */
const SUMMARY_LINGER_MS = 5000;

interface CastDesignRootState {
  castDesign: { active: { bookId: string; state: string; kind?: string; fallbacks?: { characterId: string; emotion: string }[] } | null };
}

export function createCastDesignMiddleware(): Middleware {
  return (store) => {
    let handle: { bookId: string; controller: AbortController } | null = null;
    /* Task 9d (#2407) — the action that opened the current stream, replayed
       verbatim when the language guard's Save resolves the unset language.
       `handle` is single by design (one design op per book), so one slot
       mirrors it. */
    let restart: (() => void) | null = null;
    const dispatch = store.dispatch as Dispatch;

    const close = (): void => {
      if (!handle) return;
      handle.controller.abort();
      handle = null;
    };

    /* Display name for a designed character — read from the active single
       snapshot when it's the one being designed, else fall back to 'Voice'. */
    const currentNameFor = (s: typeof store, cid: string): string | null => {
      const snap = (
        s.getState() as {
          castDesign: { active: { characterId?: string; currentName: string | null } | null };
        }
      ).castDesign.active;
      return snap && snap.characterId === cid ? snap.currentName : null;
    };

    const buildCallbacks = (bookId: string, controller: AbortController): CastDesignCallbacks => ({
      signal: controller.signal,
      /* Cold-boot re-subscribe: seed the snapshot from the server's replay so
         the pill resumes at the right percentage. (On the start path the
         middleware already dispatched `begin`; a server-sent resume_from there
         re-seeds identically — harmless.) */
      onResumeFrom: ({ total, done, currentName }) =>
        dispatch(
          castDesignActions.begin({ bookId, total, done, currentName, lastTickAt: Date.now() }),
        ),
      onProgress: ({ name }) =>
        dispatch(castDesignActions.tick({ bookId, currentName: name, lastTickAt: Date.now() })),
      onHeartbeat: () =>
        dispatch(castDesignActions.heartbeat({ bookId, lastTickAt: Date.now() })),
      onCharacterDesigned: ({ characterId, voiceId }) => {
        /* Mirror the persisted override into the cast slice so the row flips
           "Needs voice" → "Designed" live. */
        dispatch(castActions.setQwenOverrideName({ characterId, voiceId }));
        dispatch(castDesignActions.charDone({ bookId, lastTickAt: Date.now() }));
      },
      onVariantDesigned: ({ characterId, emotion, voiceId, viaFallback }) => {
        dispatch(castActions.setCharacterEmotionVariant({ characterId, emotion, voiceId }));
        if (viaFallback) {
          dispatch(castDesignActions.variantFellBack({ bookId, characterId, emotion, lastTickAt: Date.now() }));
        }
        dispatch(castDesignActions.charDone({ bookId, lastTickAt: Date.now() }));
      },
      onCharacterSkipped: () =>
        dispatch(castDesignActions.charSkipped({ bookId, lastTickAt: Date.now() })),
      onCharacterFailed: ({ characterId, name, errorReason }) =>
        dispatch(
          castDesignActions.charFailed({
            bookId,
            characterId,
            name,
            error: errorReason,
            lastTickAt: Date.now(),
          }),
        ),
      onIdle: ({ done, total, skipped, clonedSkips, failures }) => {
        const fellBack = (store.getState() as CastDesignRootState).castDesign.active?.fallbacks?.length ?? 0;
        dispatch(castDesignActions.settle({ bookId, lastTickAt: Date.now() }));
        if (total > 0) {
          const failed = failures.length;
          const parts = [`Designed ${done}`];
          if (fellBack > 0) parts.push(`${fellBack} via fallback (lower fidelity)`);
          if (failed > 0) parts.push(`${failed} failed`);
          if (skipped > 0) parts.push(`${skipped} skipped`);
          /* GATE 2 C-6 — name who the clone-protection guard skipped, not
             just fold them into the bare `skipped` count: "Design full cast"
             quietly designing fewer characters than asked is exactly the
             silence the server-side guard's report-instead-of-retarget
             behaviour exists to surface. */
          if (clonedSkips.length > 0) {
            parts.push(`already cloned: ${clonedSkips.map((c) => c.name).join(', ')}`);
          }
          dispatch(
            notificationsActions.pushToast({
              kind: failed > 0 ? 'error' : 'info',
              message: `${parts.join(' · ')}.`,
              dedupeKey: `cast-design-done:${bookId}`,
            }),
          );
        }
        /* Clear the pill after the brief summary — but only if the snapshot is
           still THIS finished run (a new run started in the window must survive). */
        setTimeout(() => {
          const s = store.getState() as CastDesignRootState;
          const snap = s.castDesign.active;
          if (snap && snap.bookId === bookId && snap.state === 'done') {
            dispatch(castDesignActions.clear());
          }
        }, SUMMARY_LINGER_MS);
      },
      onError: ({ code, message }) => {
        const fail = (): void => {
          dispatch(castDesignActions.halt({ bookId, lastTickAt: Date.now() }));
          dispatch(
            notificationsActions.pushToast({
              kind: 'error',
              message,
              dedupeKey: `cast-design:${bookId}`,
            }),
          );
        };
        /* Task 9d (#2407) — streaming shape. An unset book language is not a
           generic stream failure: route it to the language-guard host instead of
           the error toast, and replay the action that opened this stream once the
           language is saved. A dismissed guard falls back to the ordinary error
           path, so the pill never sits spinning on a modal the user closed. */
        if (code === 'language_unset') {
          const replay = restart;
          if (emitLanguageGuard({
            selector: { bookId },
            shape: 'sse',
            sseSource: 'cast-design',
            onRetry: () => { close(); replay?.(); },
            onDismiss: fail,
          })) return;
        }
        fail();
      },
    });

    /* Single-character design callbacks. CRITICAL: each handler reads the
       characterId FROM THE EVENT (not a bound argument) — the reload re-subscribe
       path doesn't know which character is in flight until `resume_from` lands. */
    const buildSingleCallbacks = (
      bookId: string,
      controller: AbortController,
    ): CastDesignCallbacks => ({
      signal: controller.signal,
      /* Reload re-attach: open the single snapshot from the server replay. */
      onResumeSingle: ({ characterId: cid, name, mode, phase }) => {
        dispatch(
          castDesignActions.beginSingle({
            bookId,
            characterId: cid,
            name,
            mode,
            lastTickAt: Date.now(),
          }),
        );
        dispatch(
          castDesignActions.setPhase({ bookId, characterId: cid, phase, lastTickAt: Date.now() }),
        );
      },
      onPhase: ({ characterId: cid, phase }) =>
        dispatch(
          castDesignActions.setPhase({ bookId, characterId: cid, phase, lastTickAt: Date.now() }),
        ),
      onHeartbeat: () =>
        dispatch(castDesignActions.heartbeat({ bookId, lastTickAt: Date.now() })),
      onCharacterDesigned: ({ characterId: cid, voiceId, voiceUuid }) => {
        /* Mirror the persisted override into the cast slice so the row flips
           "Needs voice" → "Designed" live. (The `designed` event may carry an
           extra `url` now — ignored; we don't auto-play on first design in v1.) */
        dispatch(castActions.setQwenOverrideName({ characterId: cid, voiceId }));
        /* srv-43: mirror the voiceUuid so "Play 12s" right after a first design
           resolves the uuid-keyed cache entry without waiting for a cast refetch. */
        if (voiceUuid) dispatch(castActions.setCharacterVoiceUuid({ characterId: cid, voiceUuid }));
        dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message: `${currentNameFor(store, cid) ?? 'Voice'} is ready.`,
            dedupeKey: `single-design-done:${bookId}:${cid}`,
          }),
        );
        /* Flip the snapshot to 'done' immediately so the Profile Drawer's
           sliceDesigning check (state === 'running') becomes false right away
           and the "Voice designed" confirmation (qwen-designed-confirm) is
           shown without waiting for onIdle. The onIdle setTimeout still clears
           the snapshot after SUMMARY_LINGER_MS — its guard (state !== 'ready-to-compare')
           is satisfied by 'done', so it will dispatch clear() as before. */
        dispatch(castDesignActions.settle({ bookId, lastTickAt: Date.now() }));
      },
      onPreviewReady: ({ characterId: cid, name, previewVoiceId, previewUrl, persona, voiceUuid }) => {
        dispatch(
          castDesignActions.previewReady({
            bookId,
            characterId: cid,
            previewVoiceId,
            previewUrl,
            persona,
            voiceUuid,
            lastTickAt: Date.now(),
          }),
        );
        dispatch(
          notificationsActions.pushToast({
            kind: 'info',
            message: `${name}'s new voice is ready to compare.`,
            dedupeKey: `single-design-compare:${bookId}:${cid}`,
          }),
        );
      },
      onIdle: () => {
        /* For a FIRST design, the slice is cleared shortly after the designed
           toast; for a re-design the snapshot stays in 'ready-to-compare' until
           the drawer resolves it, so only clear when NOT awaiting compare. */
        setTimeout(() => {
          const snap = (store.getState() as CastDesignRootState).castDesign.active;
          if (
            snap &&
            snap.bookId === bookId &&
            snap.kind === 'single' &&
            snap.state !== 'ready-to-compare'
          ) {
            dispatch(castDesignActions.clear());
          }
        }, SUMMARY_LINGER_MS);
      },
      onError: ({ code, message }) => {
        const fail = (): void => {
          dispatch(castDesignActions.halt({ bookId, lastTickAt: Date.now() }));
          dispatch(
            notificationsActions.pushToast({
              kind: 'error',
              message,
              dedupeKey: `single-design:${bookId}`,
            }),
          );
        };
        /* Task 9d (#2407) — streaming shape. An unset book language is not a
           generic stream failure: route it to the language-guard host instead of
           the error toast, and replay the action that opened this stream once the
           language is saved. A dismissed guard falls back to the ordinary error
           path, so the pill never sits spinning on a modal the user closed. */
        if (code === 'language_unset') {
          const replay = restart;
          if (emitLanguageGuard({
            selector: { bookId },
            shape: 'sse',
            sseSource: 'single-design',
            onRetry: () => { close(); replay?.(); },
            onDismiss: fail,
          })) return;
        }
        fail();
      },
    });

    const runStream = (
      bookId: string,
      controller: AbortController,
      open: (cb: CastDesignCallbacks) => Promise<void>,
      makeCallbacks: (
        bookId: string,
        controller: AbortController,
      ) => CastDesignCallbacks = buildCallbacks,
      replay: (() => void) | null = null,
    ): void => {
      const localHandle = { bookId, controller };
      handle = localHandle;
      restart = replay;
      const callbacks = makeCallbacks(bookId, controller);
      void (async () => {
        try {
          await open(callbacks);
        } catch (e) {
          if ((e as Error)?.name === 'AbortError') return;
          if (handle !== localHandle) return;
          const message = (e as Error)?.message ?? 'Cast design failed.';
          dispatch(castDesignActions.halt({ bookId, lastTickAt: Date.now() }));
          dispatch(
            notificationsActions.pushToast({
              kind: 'error',
              message,
              dedupeKey: `cast-design:${bookId}`,
            }),
          );
        } finally {
          if (handle === localHandle) handle = null;
        }
      })();
    };

    return (next) => (action) => {
      const result = next(action);
      const a = action as { type?: string; payload?: unknown };

      if (a.type === REQUESTED_TYPE) {
        const { bookId, characterIds, modelKey, scope, variantTasks } =
          a.payload as DesignAllRequestedPayload;
        if (handle) return result; // a run is already streaming
        const variantCount = (variantTasks ?? []).reduce((n, t) => n + t.emotions.length, 0);
        const baseCount = scope === 'variants' ? 0 : characterIds.length;
        const total = baseCount + (scope === 'bases' ? 0 : variantCount);
        if (!bookId || total === 0) return result;
        const controller = new AbortController();
        /* Seed the pill instantly (before the first SSE event lands). */
        dispatch(
          castDesignActions.begin({
            bookId,
            total,
            currentName: null,
            lastTickAt: Date.now(),
          }),
        );
        runStream(
          bookId,
          controller,
          (cb) => api.startCastDesign(bookId, { characterIds, modelKey, scope, variantTasks }, cb),
          buildCallbacks,
          () => dispatch(castDesignActions.designAllRequested(a.payload as DesignAllRequestedPayload)),
        );
        return result;
      }

      if (a.type === RESUBSCRIBE_TYPE) {
        const { bookId } = a.payload as { bookId: string };
        if (handle || !bookId) return result; // already streaming, or nothing to do
        const controller = new AbortController();
        /* No upfront begin — the server replays `resume_from` to seed the slice. */
        runStream(
          bookId,
          controller,
          (cb) => api.subscribeCastDesign(bookId, cb),
          buildCallbacks,
          () => dispatch(castDesignActions.resubscribe({ bookId })),
        );
        return result;
      }

      if (a.type === SINGLE_REQUESTED_TYPE) {
        const p = a.payload as {
          bookId: string;
          characterId: string;
          name: string;
          persona: string;
          sampleVoiceId: string;
          modelKey: string;
          mode: 'first' | 'redesign';
        };
        if (handle) return result; // one design op per book
        const controller = new AbortController();
        /* Seed the single snapshot instantly (before the first SSE event). */
        dispatch(
          castDesignActions.beginSingle({
            bookId: p.bookId,
            characterId: p.characterId,
            name: p.name,
            mode: p.mode,
            lastTickAt: Date.now(),
          }),
        );
        runStream(
          p.bookId,
          controller,
          (cb) =>
            api.startSingleDesign(
              p.bookId,
              {
                characterId: p.characterId,
                persona: p.persona,
                sampleVoiceId: p.sampleVoiceId,
                modelKey: p.modelKey,
                preview: p.mode === 'redesign',
              },
              cb,
            ),
          buildSingleCallbacks,
          () => dispatch(castDesignActions.designSingleRequested(p)),
        );
        return result;
      }

      if (a.type === RESUBSCRIBE_SINGLE_TYPE) {
        const { bookId } = a.payload as { bookId: string };
        if (handle || !bookId) return result; // already streaming, or nothing to do
        const controller = new AbortController();
        /* No upfront beginSingle — the server replays `resume_from` with the
           characterId/mode/phase, which onResumeSingle turns into a snapshot. */
        runStream(
          bookId,
          controller,
          (cb) => api.subscribeSingleDesign(bookId, cb),
          buildSingleCallbacks,
          () => dispatch(castDesignActions.resubscribeSingle({ bookId })),
        );
        return result;
      }

      if (a.type === CLEAR_TYPE) {
        /* Snapshot torn down (cancel / teardown) — stop streaming. */
        close();
        return result;
      }

      return result;
    };
  };
}

export const castDesignMiddleware: Middleware = createCastDesignMiddleware();
