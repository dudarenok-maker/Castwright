/* Single-character voice-design job — server-owned, SSE-streamed.

   POST /api/books/:bookId/cast/:characterId/design-voice/stream
        — start a background single design (body: persona, sampleVoiceId,
          modelKey, preview). One job per book.
   POST /api/books/:bookId/cast/design-single/subscribe
        — re-attach to an in-flight single design after a reload (bare body).
   GET  /api/books/:bookId/cast/design-single/status
        — is a single design live for this book? (cold-boot probe)

   Like the bulk job, it KEEPS RUNNING when its SSE subscriber disconnects, so
   closing the drawer / reloading the page never cancels it. The shared core
   `designQwenVoiceForCharacter` is reused (lock-guarded, GPU-fair). A FIRST
   design (preview=false) persists the override in-process exactly as the bulk
   job does; a RE-DESIGN (preview=true) stages a `-preview` sibling and emits
   `preview_ready` WITHOUT persisting — the drawer's A/B compare promotes it.

   Marks the shared `designBusy` registry so a bulk run 409s while this runs
   (symmetric mutual exclusion); both serialize on `withDesignLock` regardless. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { sidecarLanguageName } from '../tts/language.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { designQwenVoiceForCharacter, ensureCharacterVoiceUuid } from './qwen-voice.js';
import { applyOverrideToCastFiles } from './voices.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { markDesignBusy, clearDesignBusy, isDesignBusy } from '../tts/design-lock.js';

export const singleDesignRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

interface Subscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: ReturnType<typeof setInterval>;
}

export interface SingleJob {
  bookId: string;
  bookDir: string;
  characterId: string;
  characterName: string;
  mode: 'first' | 'redesign';
  phase: 'freeing-vram' | 'loading-model' | 'designing' | 'anchoring' | 'performing' | 'distilling' | 'rendering';
  preview: boolean;
  subscribers: Set<Subscriber>;
  controller: AbortController;
}

const inFlightByBook = new Map<string, SingleJob>();
const HEARTBEAT_MS = 6000;

/* Progress-token registry: the sidecar POSTs phase progress to the loopback
   relay carrying this token; the relay maps it back to the in-flight job. A
   token is valid only while its job runs (deleted in endJob). */
const tokenToJob = new Map<string, SingleJob>();
export function registerProgressToken(token: string, job: SingleJob): void {
  tokenToJob.set(token, job);
}
export function resolveProgressToken(token: string): SingleJob | undefined {
  return tokenToJob.get(token);
}
export function dropProgressToken(token: string): void {
  tokenToJob.delete(token);
}

export function broadcast(job: SingleJob, ev: unknown): void {
  for (const sub of job.subscribers) {
    try {
      sub.send(ev);
    } catch {
      /* dead socket */
    }
  }
}

function endJob(job: SingleJob, finalEv?: unknown): void {
  if (finalEv) broadcast(job, finalEv);
  for (const sub of job.subscribers) {
    clearInterval(sub.keepAlive);
    try {
      sub.res.end();
    } catch {
      /* gone */
    }
  }
  job.subscribers.clear();
  if (inFlightByBook.get(job.bookId) === job) inFlightByBook.delete(job.bookId);
  clearDesignBusy(job.bookDir);
  for (const [tok, j] of tokenToJob) if (j === job) tokenToJob.delete(tok);
}

async function runSingleDesign(
  job: SingleJob,
  persona: string,
  sampleVoiceId: string,
  modelKey: TtsModelKey,
  language: string,
  seriesFilter: { author: string; series: string } | undefined,
): Promise<void> {
  const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
  const character = cast?.characters?.find((c) => c.id === job.characterId);
  if (!character) {
    endJob(job, { type: 'error', code: 'not_found', message: 'Character no longer exists.' });
    return;
  }

  const heartbeat = setInterval(
    () => broadcast(job, { type: 'heartbeat', characterId: job.characterId }),
    HEARTBEAT_MS,
  );
  try {
    /* srv-43 — mint/persist voiceUuid before the core names the .pt, matching
       the bulk-job and REST-endpoint paths so every design entry point produces
       the same uuid-keyed cache key. */
    const seriesFilterForUuid = seriesFilter;
    const voiceUuid = await ensureCharacterVoiceUuid(
      job.bookDir,
      job.characterId,
      seriesFilterForUuid,
    );
    const characterForDesign = { ...character, voiceUuid: voiceUuid ?? character.voiceUuid };

    /* Mint a progress token so the sidecar can POST real phase updates back via
       the loopback relay (Task 4). The token is registered before the design
       call and dropped in endJob. The sidecar drives every phase event — we no
       longer fake 'designing' or 'rendering' here. */
    const { randomUUID } = await import('node:crypto');
    const { serverLoopbackBaseUrl } = await import('../tts/loopback-url.js');
    const progressToken = randomUUID();
    registerProgressToken(progressToken, job);
    const progressUrl = `${serverLoopbackBaseUrl()}/api/internal/design-progress`;

    const { voiceId, url } = await designQwenVoiceForCharacter({
      bookDir: job.bookDir,
      character: characterForDesign,
      characterId: job.characterId,
      persona,
      sampleVoiceId,
      modelKey,
      language,
      preview: job.preview,
      progressToken,
      progressUrl,
    });

    if (job.preview) {
      /* Re-design: hold the preview, do NOT persist. The drawer's A/B compare
         promotes (promote-voice) or discards (discard-voice).
         srv-43: include voiceUuid so the drawer can resolve the uuid-keyed cache
         entry immediately, without waiting for a cast refetch. */
      endJob(job, {
        type: 'preview_ready',
        characterId: job.characterId,
        name: job.characterName,
        previewVoiceId: voiceId,
        previewUrl: url,
        persona,
        voiceUuid: characterForDesign.voiceUuid,
      });
      return;
    }

    /* First design: auto-persist exactly as the bulk job does. */
    const matchKey = character.voiceId ?? character.id;
    await applyOverrideToCastFiles(matchKey, { engine: 'qwen', name: voiceId }, seriesFilter);
    endJob(job, {
      type: 'designed',
      characterId: job.characterId,
      name: job.characterName,
      voiceId,
      url,
      voiceUuid: characterForDesign.voiceUuid,
    });
  } catch (e) {
    const message = (e as Error).message || 'Voice design failed.';
    endJob(job, { type: 'error', code: 'design_failed', message });
  } finally {
    clearInterval(heartbeat);
  }
}

singleDesignRouter.post(
  '/:bookId/cast/:characterId/design-voice/stream',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    const body = (req.body ?? {}) as {
      persona?: unknown;
      sampleVoiceId?: unknown;
      modelKey?: unknown;
      preview?: unknown;
    };

    const located = await findBookByBookId(bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir } = located;

    /* Symmetric mutual exclusion: refuse if a bulk OR another single design owns
       the book. (Both register in the shared designBusy set.) */
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error: 'A voice design is already in progress for this book.',
      });
    }

    const persona = typeof body.persona === 'string' ? body.persona.trim() : '';
    if (!persona) return res.status(400).json({ error: 'A persona is required to design a voice.' });
    const sampleVoiceId = typeof body.sampleVoiceId === 'string' ? body.sampleVoiceId.trim() : '';
    if (!sampleVoiceId) return res.status(400).json({ error: '`sampleVoiceId` is required.' });
    if (!isTtsModelKey(body.modelKey)) {
      return res
        .status(400)
        .json({ error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` });
    }
    const modelKey = body.modelKey;
    const preview = body.preview === true;

    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) return res.status(404).json({ error: `Character "${characterId}" not found.` });

    /* SSE framing (mirror cast-design.ts). */
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const keepAlive = setInterval(() => {
      try {
        res.write(':ka\n\n');
      } catch {
        /* gone */
      }
    }, 15_000);
    const send = (payload: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* gone */
      }
    };

    let language: string;
    try {
      language = sidecarLanguageName(bookStateLanguage(located.state));
    } catch (e) {
      send({ type: 'error', code: 'unsupported_language', message: (e as Error).message });
      clearInterval(keepAlive);
      return res.end();
    }
    const isStandalone = located.state?.isStandalone === true;
    const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);

    const job: SingleJob = {
      bookId,
      bookDir,
      characterId,
      characterName: character.name ?? characterId,
      mode: preview ? 'redesign' : 'first',
      phase: 'freeing-vram',
      preview,
      subscribers: new Set(),
      controller: new AbortController(),
    };
    inFlightByBook.set(bookId, job);
    markDesignBusy(bookDir);
    const subscriber: Subscriber = { send, res, keepAlive };
    job.subscribers.add(subscriber);
    res.on('close', () => {
      if (res.writableEnded) return;
      job.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Sticky: keep running for a reload re-attach. */
    });

    void runSingleDesign(job, persona, sampleVoiceId, modelKey, language, seriesInfo ?? undefined);
  },
);

singleDesignRouter.post(
  '/:bookId/cast/design-single/subscribe',
  (req: Request, res: Response) => {
    const { bookId } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(':ok\n\n');
    const keepAlive = setInterval(() => {
      try {
        res.write(':ka\n\n');
      } catch {
        /* gone */
      }
    }, 15_000);
    const send = (payload: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* gone */
      }
    };

    const job = inFlightByBook.get(bookId);
    if (!job) {
      send({ type: 'idle' });
      clearInterval(keepAlive);
      return res.end();
    }
    const subscriber: Subscriber = { send, res, keepAlive };
    job.subscribers.add(subscriber);
    send({
      type: 'resume_from',
      characterId: job.characterId,
      name: job.characterName,
      mode: job.mode,
      phase: job.phase,
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      job.subscribers.delete(subscriber);
      clearInterval(keepAlive);
    });
  },
);

singleDesignRouter.get('/:bookId/cast/design-single/status', (req: Request, res: Response) => {
  const job = inFlightByBook.get(req.params.bookId);
  if (!job) return res.status(200).json({ active: false });
  return res.status(200).json({
    active: true,
    characterId: job.characterId,
    name: job.characterName,
    mode: job.mode,
    phase: job.phase,
  });
});
