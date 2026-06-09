/* "Design full cast" bulk-design job — server-owned, SSE-streamed.

   POST /api/books/:bookId/cast/design        — start a job (with characterIds)
                                                 OR re-subscribe to an in-flight
                                                 one (bare body, no list).
   GET  /api/books/:bookId/cast/design/status — is a job live? (cold-boot probe)
   POST /api/books/:bookId/cast/design/pause   — cancel the book's job.

   One in-memory job per book (`inFlightByBook`). It KEEPS RUNNING when its last
   SSE subscriber disconnects (unlike generation's orphan-abort) so a browser
   reload can re-attach via the bare POST and resume the pill — that's the
   reload-resilience the third status pill promises. Each designed voice is
   persisted to cast.json the instant it completes (idempotent), so a server
   restart loses only the live pill, never work: re-clicking finishes the rest.

   The per-character work reuses the EXACT single-design path:
     - `generateVoiceStylePersona` (Gemini) when the character has no persona,
     - `designQwenVoiceForCharacter` (sidecar design + audition cache, serialized
       per-book + GPU-fair via the shared design lock + semaphore),
     - `applyOverrideToCastFiles` to persist the override the way the drawer does
       (series scope for a series book, workspace scope for a standalone — which
       still writes the current book; the series filter would skip standalones).

   Concurrency hardening (targeted):
     - freshness-skip: re-read each character first; skip if it already has a
       Qwen voice (designed meanwhile, or a linked duplicate already got it),
     - mutual exclusion: refuse to start while an analysis run is live for the
       book (re-analysis rewrites the whole cast), and the single-design route
       refuses while THIS job is live (shared `design-lock` busy registry).

   Pairs with docs/features/NNN-design-full-cast.md. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateLanguage } from '../workspace/scan.js';
import { sidecarLanguageName } from '../tts/language.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { isTtsModelKey, TTS_MODEL_LABELS, type TtsModelKey } from '../tts/index.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';
import { designQwenVoiceForCharacter } from './qwen-voice.js';
import { applyOverrideToCastFiles } from './voices.js';
import { generateVoiceStylePersona } from '../analyzer/voice-style.js';
import { findAuthorSeriesForBookId } from '../workspace/series-cast-scan.js';
import { markDesignBusy, clearDesignBusy, isAnalysisBusy, isDesignBusy } from '../tts/design-lock.js';

export const castDesignRouter = Router();

interface CastFile {
  characters: CastCharacter[];
}

interface DesignSubscriber {
  send: (payload: unknown) => void;
  res: Response;
  keepAlive: ReturnType<typeof setInterval>;
}

interface DesignFailure {
  characterId: string;
  name: string;
  error: string;
}

interface DesignJob {
  controller: AbortController;
  subscribers: Set<DesignSubscriber>;
  bookId: string;
  bookDir: string;
  total: number;
  done: number;
  skipped: number;
  failures: DesignFailure[];
  currentCharacterId: string | null;
  currentName: string | null;
}

/** One job per book (keyed by bookId). */
const inFlightByBook = new Map<string, DesignJob>();

/** Heartbeat cadence during a single (≤180s) design so the pill's 30s stall
    heuristic doesn't trip while the run is healthy. */
const HEARTBEAT_MS = 6000;

function broadcast(job: DesignJob, ev: unknown): void {
  for (const sub of job.subscribers) {
    try {
      sub.send(ev);
    } catch {
      /* dead socket — skip */
    }
  }
}

function endJob(job: DesignJob, finalEv?: unknown): void {
  if (finalEv) broadcast(job, finalEv);
  for (const sub of job.subscribers) {
    clearInterval(sub.keepAlive);
    try {
      sub.res.end();
    } catch {
      /* socket already gone */
    }
  }
  job.subscribers.clear();
  if (inFlightByBook.get(job.bookId) === job) inFlightByBook.delete(job.bookId);
  clearDesignBusy(job.bookDir);
}

/** The serial design loop — runs detached in the background; broadcasts to
    whatever subscribers are currently attached (zero during a reload gap). */
async function runDesignJob(
  job: DesignJob,
  characterIds: string[],
  modelKey: TtsModelKey,
  language: string,
  seriesFilter: { author: string; series: string } | undefined,
): Promise<void> {
  for (const characterId of characterIds) {
    if (job.controller.signal.aborted) break;

    /* Re-read fresh each iteration so a concurrent edit (rename, a manual
       design) is reflected, and the override write below races the smallest
       possible window. */
    const cast = await readJson<CastFile>(castJsonPath(job.bookDir));
    const character = cast?.characters?.find((c) => c.id === characterId);
    if (!character) {
      /* Deleted/merged mid-run — silently skip (not a failure). */
      job.skipped += 1;
      broadcast(job, { type: 'character_skipped', characterId });
      continue;
    }
    /* Freshness-skip: someone designed this character (or a linked duplicate)
       since the list was captured — never clobber it. */
    if (character.overrideTtsVoices?.qwen?.name) {
      job.skipped += 1;
      broadcast(job, { type: 'character_skipped', characterId });
      continue;
    }

    job.currentCharacterId = characterId;
    job.currentName = character.name ?? characterId;
    broadcast(job, {
      type: 'progress',
      characterId,
      name: job.currentName,
      done: job.done,
      total: job.total,
    });

    const heartbeat = setInterval(() => broadcast(job, { type: 'heartbeat', characterId }), HEARTBEAT_MS);
    try {
      /* Persona fallback (Gemini) when the character has none, persisted
         minimal-patch so a concurrent edit to another character survives. */
      let persona = (character.voiceStyle ?? '').trim();
      if (!persona) {
        persona = await generateVoiceStylePersona(character);
        const fresh = await readJson<CastFile>(castJsonPath(job.bookDir));
        const idx = fresh?.characters?.findIndex((c) => c.id === characterId) ?? -1;
        if (fresh && idx !== -1) {
          fresh.characters[idx] = { ...fresh.characters[idx], voiceStyle: persona };
          await writeJsonAtomic(castJsonPath(job.bookDir), fresh);
        }
      }

      const sampleVoiceId = character.voiceId ?? `char-${characterId}`;
      const { voiceId } = await designQwenVoiceForCharacter({
        bookDir: job.bookDir,
        character,
        characterId,
        persona,
        sampleVoiceId,
        modelKey,
        language,
        signal: job.controller.signal,
      });

      /* Persist the override exactly as the drawer does — match key is the
         character's voiceId/id, the name is the designed `qwen-…` id. */
      const matchKey = character.voiceId ?? character.id;
      await applyOverrideToCastFiles(matchKey, { engine: 'qwen', name: voiceId }, seriesFilter);

      job.done += 1;
      broadcast(job, { type: 'character_designed', characterId, voiceId });
    } catch (e) {
      const message = (e as Error).message || 'Voice design failed.';
      /* A sidecar-wide failure (down / stuck) would fail every remaining
         character identically — stop early with a catastrophic error instead
         of grinding through N timeouts. */
      if (/unreachable|did not complete within|stopped responding/i.test(message)) {
        clearInterval(heartbeat);
        endJob(job, { type: 'error', code: 'sidecar_unavailable', message });
        return;
      }
      job.failures.push({ characterId, name: character.name ?? characterId, error: message });
      broadcast(job, {
        type: 'character_failed',
        characterId,
        name: character.name ?? characterId,
        errorReason: message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  job.currentCharacterId = null;
  job.currentName = null;
  endJob(job, {
    type: 'idle',
    done: job.done,
    total: job.total,
    skipped: job.skipped,
    failures: job.failures,
  });
}

castDesignRouter.post('/:bookId/cast/design', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const body = (req.body ?? {}) as { characterIds?: unknown; modelKey?: unknown };
  const characterIds = Array.isArray(body.characterIds)
    ? body.characterIds.filter((x): x is string => typeof x === 'string')
    : null;

  const located = await findBookByBookId(bookId);
  if (!located) return res.status(404).json({ error: 'Book not found.' });
  const { bookDir } = located;

  const existing = inFlightByBook.get(bookId);
  const isStart = characterIds !== null && characterIds.length > 0 && !existing;

  /* Start-path validation BEFORE we flush SSE headers (so a 4xx is a real
     status code, not an SSE error event). */
  let modelKey: TtsModelKey | null = null;
  if (isStart) {
    if (isAnalysisBusy(bookDir)) {
      return res.status(409).json({
        error:
          'Analysis is running for this book. Wait for it to finish before designing the full cast (re-analysis rewrites the cast).',
      });
    }
    if (isDesignBusy(bookDir)) {
      return res.status(409).json({
        error:
          'A single voice design is in progress for this book. Wait for it to finish before designing the full cast.',
      });
    }
    if (!isTtsModelKey(body.modelKey)) {
      return res
        .status(400)
        .json({ error: `modelKey must be one of: ${Object.keys(TTS_MODEL_LABELS).join(', ')}` });
    }
    modelKey = body.modelKey;
  }

  /* ── SSE setup (mirrors the analysis route's framing). */
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
      /* socket gone */
    }
  }, 15_000);
  const send = (payload: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* dead socket */
    }
  };

  /* ── Subscribe path: re-attach to a live job, or idle if there's nothing
     to resume (a bare cold-boot probe POST for a book with no job). */
  if (!isStart) {
    if (!existing) {
      send({ type: 'idle', done: 0, total: 0, skipped: 0, failures: [] });
      clearInterval(keepAlive);
      return res.end();
    }
    const subscriber: DesignSubscriber = { send, res, keepAlive };
    existing.subscribers.add(subscriber);
    send({
      type: 'resume_from',
      total: existing.total,
      done: existing.done,
      currentName: existing.currentName,
    });
    res.on('close', () => {
      if (res.writableEnded) return;
      existing.subscribers.delete(subscriber);
      clearInterval(keepAlive);
      /* Do NOT abort — the job keeps running so a reload can re-attach. */
    });
    return;
  }

  /* ── Start path: register the job + run the loop detached. */
  const language = sidecarLanguageName(bookStateLanguage(located.state));
  const isStandalone = located.state?.isStandalone === true;
  const seriesInfo = isStandalone ? null : await findAuthorSeriesForBookId(bookId);
  const seriesFilter = seriesInfo ?? undefined;

  const job: DesignJob = {
    controller: new AbortController(),
    subscribers: new Set(),
    bookId,
    bookDir,
    total: characterIds!.length,
    done: 0,
    skipped: 0,
    failures: [],
    currentCharacterId: null,
    currentName: null,
  };
  inFlightByBook.set(bookId, job);
  markDesignBusy(bookDir);
  const subscriber: DesignSubscriber = { send, res, keepAlive };
  job.subscribers.add(subscriber);
  res.on('close', () => {
    if (res.writableEnded) return;
    job.subscribers.delete(subscriber);
    clearInterval(keepAlive);
    /* Sticky: keep running for a reload re-attach. */
  });

  void runDesignJob(job, characterIds!, modelKey!, language, seriesFilter).catch((e) => {
    /* Defensive — the loop catches per-character; a throw here is unexpected. */
    endJob(job, {
      type: 'error',
      code: 'unknown',
      message: (e as Error).message || 'Cast design failed.',
    });
  });
});

castDesignRouter.get('/:bookId/cast/design/status', (req: Request, res: Response) => {
  const job = inFlightByBook.get(req.params.bookId);
  if (!job) return res.status(200).json({ active: false });
  return res.status(200).json({
    active: true,
    total: job.total,
    done: job.done,
    skipped: job.skipped,
    currentName: job.currentName,
    state: 'running',
    failures: job.failures,
  });
});

castDesignRouter.post('/:bookId/cast/design/pause', (req: Request, res: Response) => {
  const job = inFlightByBook.get(req.params.bookId);
  if (job && !job.controller.signal.aborted) job.controller.abort();
  return res.status(200).json({ ok: true, cancelled: !!job });
});
