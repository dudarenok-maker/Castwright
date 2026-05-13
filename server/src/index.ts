/* Local development backend for the audiobook generator.
   Implements the upload + analysis + voice-match slice of the OpenAPI spec.
   Frontend (Vite, :5173) proxies /api/* to this server (:8080) — see vite.config.ts. */

/* MUST be the first import: it runs `process.loadEnvFile('.env')` as a
   top-level side effect, populating `process.env` before any downstream
   module in the graph evaluates. Without this, ESM hoisting means imports
   like `./workspace/paths.js` capture an empty `process.env.WORKSPACE_DIR`
   even though `.env` sets it — yielding the silent "stale workspace root"
   bug that recreates `audiobook-workspace/` inside the repo. */
import './load-env.js';

import express from 'express';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manuscriptsRouter } from './routes/manuscripts.js';
import { analysisRouter } from './routes/analysis.js';
import { voiceMatchRouter } from './routes/voice-match.js';
import { voiceSampleRouter } from './routes/voice-sample.js';
import { voicesRouter } from './routes/voices.js';
import { libraryRouter } from './routes/library.js';
import { importRouter } from './routes/import.js';
import { bookStateRouter } from './routes/book-state.js';
import { generationRouter } from './routes/generation.js';
import { chapterAudioRouter } from './routes/chapter-audio.js';
import { sidecarHealthRouter } from './routes/sidecar-health.js';
import { runCatalogAudit } from './tts/coqui-catalog-audit.js';
import { auditEngineCatalog } from './tts/voice-mapping.js';
import { WORKSPACE_ROOT, BOOKS_ROOT, ensureWorkspace } from './workspace/paths.js';

const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = resolve(__dirname, '..', 'audio');
mkdirSync(resolve(AUDIO_DIR, 'voices'), { recursive: true });
app.use('/audio', express.static(AUDIO_DIR, { fallthrough: true, maxAge: '1h' }));

ensureWorkspace();
app.use('/workspace', express.static(WORKSPACE_ROOT, { fallthrough: true, maxAge: '1h' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/* Workspace metadata for the Books page header — lets the user see at a
   glance which folder the library is actually reading from, so a stale
   WORKSPACE_DIR override doesn't silently empty out the library. The
   scanner already reads from WORKSPACE_ROOT (paths.ts) so this is the
   exact same value the library tree is computed from. */
app.get('/api/workspace', (_req, res) => {
  res.json({
    root: WORKSPACE_ROOT,
    booksRoot: BOOKS_ROOT,
    source: process.env.WORKSPACE_DIR ? 'env' : 'default',
  });
});

app.use('/api/library', libraryRouter);
app.use('/api', importRouter); // mounts /import and /books
app.use('/api/manuscripts', manuscriptsRouter);
app.use('/api/manuscripts', analysisRouter); // analysisRouter mounts /:id/analysis
app.use('/api/books', bookStateRouter);      // mounts /:bookId/state (GET/PUT)
app.use('/api/books', voiceMatchRouter);     // mounts /:bookId/voice-match
app.use('/api/books', generationRouter);     // mounts /:bookId/generation (SSE)
app.use('/api/books', chapterAudioRouter);   // mounts /:bookId/chapters/:chapterId/audio(.mp3|.wav)
app.use('/api/voices', voicesRouter);        // mounts GET / + PUT /:voiceId/pin
app.use('/api/voices', voiceSampleRouter);   // mounts POST /:voiceId/sample
app.use('/api/sidecar', sidecarHealthRouter); // mounts GET /health

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[server] workspace root: ${WORKSPACE_ROOT}`);

  /* Static catalog self-consistency check (instant, no I/O). Catches
     "wrong voices used for wrong models" at its source — the per-engine
     PROFILE_VOICES table and VOICE_DESCRIPTIONS table can drift apart
     (a picker chooses a voice with no description, or a described voice
     is never routable). This runs synchronously at boot so any drift
     prints before the first request lands. */
  for (const engine of ['gemini', 'coqui'] as const) {
    const audit = auditEngineCatalog(engine);
    if (audit.missingDescriptions.length > 0) {
      console.warn(
        `[tts:catalog] ${engine}: ${audit.missingDescriptions.length} picker voice(s) ` +
        `have no description — cast view will show "Prebuilt voice" placeholder for: ` +
        audit.missingDescriptions.join(', '),
      );
    }
    if (audit.unrouted.length > 0) {
      console.info(
        `[tts:catalog] ${engine}: ${audit.unrouted.length} described voice(s) are ` +
        `never chosen by the picker (orphan entries): ${audit.unrouted.join(', ')}`,
      );
    }
    if (audit.missingDescriptions.length === 0 && audit.unrouted.length === 0) {
      console.log(`[tts:catalog] ${engine}: ${audit.routedCount} voices, tables in sync.`);
    }
  }

  /* Background model-manifest audit: poll the sidecar's /speakers endpoint
     until the XTTS v2 model has loaded, then diff our hardcoded
     COQUI_PROFILE_VOICES (server/src/tts/voice-mapping.ts) against the
     model's actual speaker manifest. Logs a structured summary the
     moment it completes so any catalog drift is visible at boot
     instead of silently substituting voices mid-chapter. Result is
     cached and served by GET /api/sidecar/catalog-audit.

     Fire-and-forget — we don't block app.listen on the sidecar being
     up, and runCatalogAudit never throws (it logs a warning on timeout). */
  const sidecarUrl = (process.env.LOCAL_TTS_URL ?? 'http://localhost:9000').replace(/\/+$/, '');
  void runCatalogAudit({ sidecarUrl });
});
