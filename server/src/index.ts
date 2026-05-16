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

/* Patch console.* to prefix every line with a YYYY-MM-DD HH:mm:ss.SSS
   stamp. Runtime logging (route handlers, app.listen callback, …) all
   fires after this call, so every line in logs/server.log is stamped. */
import { installTimestamps } from './logger.js';
installTimestamps();

import express from 'express';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manuscriptsRouter } from './routes/manuscripts.js';
import { analysisRouter } from './routes/analysis.js';
import { voiceMatchRouter } from './routes/voice-match.js';
import { castMergeRouter } from './routes/cast-merge.js';
import { libraryCastOverrideRouter } from './routes/library-cast-override.js';
import { voiceSampleRouter } from './routes/voice-sample.js';
import { voicesRouter } from './routes/voices.js';
import { libraryRouter } from './routes/library.js';
import { importRouter } from './routes/import.js';
import { bookStateRouter } from './routes/book-state.js';
import { coverRouter } from './routes/cover.js';
import { generationRouter } from './routes/generation.js';
import { chapterAudioRouter } from './routes/chapter-audio.js';
import { exportRouter } from './routes/export.js';
import { exportLanRouter, enumerateLanUrls } from './routes/export-lan.js';
import { revisionsRouter } from './routes/revisions.js';
import { sidecarHealthRouter } from './routes/sidecar-health.js';
import { ollamaHealthRouter } from './routes/ollama-health.js';
import { workspaceRouter } from './routes/workspace.js';
import { userSettingsRouter } from './routes/user-settings.js';
import { runCatalogAudit } from './tts/coqui-catalog-audit.js';
import { auditEngineCatalog } from './tts/voice-mapping.js';
import { WORKSPACE_ROOT, ensureWorkspace } from './workspace/paths.js';
import { migrateLegacyChangeLogs } from './workspace/changelog-migrate.js';
import { readUserSettings, getResolvedSidecarUrl } from './workspace/user-settings.js';

const app = express();

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = resolve(__dirname, '..', 'audio');
mkdirSync(resolve(AUDIO_DIR, 'voices'), { recursive: true });
app.use('/audio', express.static(AUDIO_DIR, { fallthrough: true, maxAge: '1h' }));

ensureWorkspace();
/* Warm the user-settings cache so sync resolvers (getResolvedSidecarUrl)
   see real values from disk before the first request lands. Fire-and-forget:
   a missing or malformed file falls through to defaults inside
   readUserSettings(). */
void readUserSettings();

/* One-shot wipe-and-fresh for change-logs written before the
   generation_run_complete rollup landed. The pre-collapse middleware wrote
   one event per chapter_complete tick, and books that ran a few times
   accumulated 200+ near-identical rows. Migration renames the legacy
   file to `.legacy.json` (kept for recovery) and replaces the live file
   with `[]`. Fire-and-forget: never blocks listen, never crashes on a
   malformed file. */
void migrateLegacyChangeLogs()
  .then(r => {
    if (r.migrated.length > 0) {
      console.log(
        `[changelog] migrated ${r.migrated.length} book(s) to a fresh log ` +
        `(originals saved alongside as change-log.legacy.json).`,
      );
    }
  })
  .catch(err => console.warn('[changelog] migration skipped:', err));
app.use('/workspace', express.static(WORKSPACE_ROOT, { fallthrough: true, maxAge: '1h' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use('/api/workspace', workspaceRouter); // GET / (metadata) + GET /changelog (cross-book aggregator)
app.use('/api/user/settings', userSettingsRouter); // GET + PUT — account defaults + non-secret env overrides
app.use('/api/library', libraryRouter);
app.use('/api', importRouter); // mounts /import and /books
app.use('/api/manuscripts', manuscriptsRouter);
app.use('/api/manuscripts', analysisRouter); // analysisRouter mounts /:id/analysis
app.use('/api/books', bookStateRouter);      // mounts /:bookId/state (GET/PUT)
app.use('/api/books', coverRouter);          // mounts /:bookId/cover{,/candidates} (OpenLibrary covers)
app.use('/api/books', voiceMatchRouter);     // mounts /:bookId/voice-match
app.use('/api/books', castMergeRouter);      // mounts /:bookId/cast/merge
app.use('/api', libraryCastOverrideRouter);  // mounts /library-cast/override (cross-book; not under /:bookId)
app.use('/api/books', generationRouter);     // mounts /:bookId/generation (SSE)
app.use('/api/books', chapterAudioRouter);   // mounts /:bookId/chapters/:chapterId/audio(.mp3|.wav)
app.use('/api/books', exportRouter);         // mounts /:bookId/exports (POST + GET status + GET download)
app.use('/api/export', exportLanRouter);     // mounts /lan (LAN URL enumeration for the export modal)
app.use('/api/books', revisionsRouter);      // mounts /:bookId/revisions (drift diff over segments snapshots)
app.use('/api/voices', voicesRouter);        // mounts GET / + PUT /:voiceId/pin
app.use('/api/voices', voiceSampleRouter);   // mounts POST /:voiceId/sample
app.use('/api/sidecar', sidecarHealthRouter); // mounts GET /health
app.use('/api/ollama', ollamaHealthRouter);  // mounts GET /health (local LLM analyzer)

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[server] workspace root: ${WORKSPACE_ROOT}`);

  /* Log the LAN URLs so the user can spot which IP to point their phone's
     browser at for the audiobook export sideload flow. Node's app.listen
     already binds all interfaces, so every URL here genuinely reaches us. */
  const lan = enumerateLanUrls(PORT);
  for (const url of lan.urls) {
    // eslint-disable-next-line no-console
    console.log(`[server] LAN URL: ${url}`);
  }

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
  const sidecarUrl = getResolvedSidecarUrl();
  void runCatalogAudit({ sidecarUrl });
});
