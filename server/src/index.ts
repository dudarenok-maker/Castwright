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
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mountFrontendStatic } from './frontend-static.js';
import { fileURLToPath } from 'node:url';
import { manuscriptsRouter } from './routes/manuscripts.js';
import { analysisRouter } from './routes/analysis.js';
import { voiceMatchRouter } from './routes/voice-match.js';
import { castMergeRouter } from './routes/cast-merge.js';
import { castAliasesRouter } from './routes/cast-aliases.js';
import { castLinkPriorRouter } from './routes/cast-link-prior.js';
import { castSeriesPatchRouter } from './routes/cast-series-patch.js';
import { castAddFromRosterRouter } from './routes/cast-add-from-roster.js';
import { libraryCastOverrideRouter } from './routes/library-cast-override.js';
import { seriesRosterRouter } from './routes/series-roster.js';
import { voiceSampleRouter } from './routes/voice-sample.js';
import { voicesRouter } from './routes/voices.js';
import { libraryRouter } from './routes/library.js';
import { importRouter } from './routes/import.js';
import { bookStateRouter } from './routes/book-state.js';
import { coverRouter } from './routes/cover.js';
import { generationRouter } from './routes/generation.js';
import { chapterAudioRouter } from './routes/chapter-audio.js';
import { clipRouter } from './routes/clip.js';
import { chaptersRestructureRouter } from './routes/chapters-restructure.js';
import { exportRouter } from './routes/export.js';
import { exportLanRouter, enumerateLanUrls, isLanHttpsEnabled } from './routes/export-lan.js';
import { certRootRouter } from './routes/cert-root.js';
import {
  portableExportRouter,
  portableImportRouter,
} from './routes/exports-portable.js';
import { shareRouter, sharePublicRouter } from './routes/share.js';
import { revisionsRouter, revisionsBulkRouter } from './routes/revisions.js';
import { sidecarHealthRouter } from './routes/sidecar-health.js';
import { ollamaHealthRouter } from './routes/ollama-health.js';
import { workspaceRouter } from './routes/workspace.js';
import { userSettingsRouter } from './routes/user-settings.js';
import { runCatalogAudit } from './tts/coqui-catalog-audit.js';
import { auditEngineCatalog } from './tts/voice-mapping.js';
import { WORKSPACE_ROOT, ensureWorkspace } from './workspace/paths.js';
import { migrateLegacyChangeLogs } from './workspace/changelog-migrate.js';
import { fsckAllBooks } from './workspace/fsck-orphan-audio.js';
import {
  readUserSettings,
  getResolvedSidecarUrl,
  getResolvedAutoStartSidecar,
} from './workspace/user-settings.js';
import { spawnSidecar, type SidecarHandle } from './tts/spawn-sidecar.js';

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
  .then((r) => {
    if (r.migrated.length > 0) {
      console.log(
        `[changelog] migrated ${r.migrated.length} book(s) to a fresh log ` +
          `(originals saved alongside as change-log.legacy.json).`,
      );
    }
  })
  .catch((err) => console.warn('[changelog] migration skipped:', err));

/* Plan 20 — sibling fsck for the rollback-preservation pair. The
   preserve helper (`workspace/preserve-previous-audio.ts`) renames two
   files (audio + segments) sequentially; a crash between them leaves a
   half-preserved state. On startup we walk every book's audio root,
   promote any `.previous.mp3` back to live when the live counterpart
   is missing (regen crash recovery), and drop orphan
   `.previous.segments.json` files. Fire-and-forget: never blocks
   listen, never throws. */
void fsckAllBooks()
  .then((r) => {
    if (r.recovered.length > 0) {
      console.log(
        `[fsck] reconciled ${r.recovered.length} rollback-pair half-state(s) on startup ` +
          `(see workspace/fsck-orphan-audio.ts).`,
      );
    }
    if (r.errors.length > 0) {
      for (const e of r.errors) {
        console.warn(`[fsck] ${e.action} failed for ${e.slug}: ${e.message}`);
      }
    }
  })
  .catch((err) => console.warn('[fsck] sweep skipped:', err));
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
app.use('/api/books', bookStateRouter); // mounts /:bookId/state (GET/PUT)
app.use('/api/books', coverRouter); // mounts /:bookId/cover{,/candidates} (OpenLibrary covers)
app.use('/api/books', voiceMatchRouter); // mounts /:bookId/voice-match
app.use('/api/books', castMergeRouter); // mounts /:bookId/cast/merge
app.use('/api/books', castAliasesRouter); // mounts /:bookId/cast/{unlink-alias,add-alias} (editable alias chips on the profile drawer)
app.use('/api/books', castLinkPriorRouter); // mounts /:bookId/cast/link-prior (manual continuity link to a prior series book)
app.use('/api/books', castSeriesPatchRouter); // mounts /:bookId/cast/:characterId/series-patch (cross-book Compare save propagation, BACKLOG #7)
app.use('/api/books', castAddFromRosterRouter); // mounts /:bookId/cast/add-from-roster (new local character pulled from a prior series-mate)
app.use('/api/books', seriesRosterRouter); // mounts /:bookId/series-roster (prior-book characters in the same series)
app.use('/api', libraryCastOverrideRouter); // mounts /library-cast/override (cross-book; not under /:bookId)
app.use('/api/books', generationRouter); // mounts /:bookId/generation (SSE)
app.use('/api/books', chapterAudioRouter); // mounts /:bookId/chapters/:chapterId/audio(.mp3)
app.use('/api/books', clipRouter); // mounts /:bookId/chapters/:chapterId/clip (plan 69 — share-clip download)
app.use('/api/books', chaptersRestructureRouter); // mounts /:bookId/chapters/{merge,split,reorder} (plan 51)
app.use('/api/books', exportRouter); // mounts /:bookId/exports (POST + GET status + GET download)
app.use('/api/books', portableExportRouter); // plan 75 — mounts /:bookId/export/portable (single GET)
app.use('/api/import', portableImportRouter); // plan 75 — mounts POST /portable (multipart bundle)
app.use('/api/export', exportLanRouter); // mounts /lan (LAN URL enumeration for the export modal)
app.use('/cert', certRootRouter); // plan 81 — mounts /root.crt (mkcert root CA download for mobile LAN HTTPS)
app.use('/api/books', shareRouter); // mounts /:bookId/share (POST — mint a slugged share URL — plan 67)
app.use('/', sharePublicRouter); // mounts /share/:slug (public-facing M4B proxy — plan 67)
app.use('/api/books', revisionsRouter); // mounts /:bookId/revisions (drift diff over segments snapshots)
app.use('/api', revisionsBulkRouter); // plan 83 — bulk /revisions?bookIds=... for cross-book fan-out
import { worktreesRouter } from './routes/worktrees.js';
app.use('/api', worktreesRouter); // plan 86 — dev-only GET /worktrees (404s in production)
app.use('/api/voices', voicesRouter); // mounts GET / + PUT /:voiceId/pin
app.use('/api/voices', voiceSampleRouter); // mounts POST /:voiceId/sample
app.use('/api/sidecar', sidecarHealthRouter); // mounts GET /health
app.use('/api/ollama', ollamaHealthRouter); // mounts GET /health (local LLM analyzer)

/* Production-mode frontend serving. Helper resolves whether to mount based
   on NODE_ENV=production OR the existence of dist/index.html. Mounted AFTER
   every /api/* and /audio/* and /workspace/* route so the API can never be
   shadowed by a static file. Hash-router SPA, so no `*` → index.html
   fallback is needed. */
{
  const distDir = resolve(__dirname, '..', '..', 'dist');
  const result = mountFrontendStatic(app, distDir);
  if (result.mounted) {
    // eslint-disable-next-line no-console
    console.log(`[server] serving frontend bundle from ${result.distDir} (${result.reason})`);
  } else if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(`[server] frontend NOT mounted: ${result.reason}`);
  }
}

const PORT = Number(process.env.PORT ?? 8080);
const LAN_HTTPS_PORT = Number(process.env.LAN_HTTPS_PORT ?? 8443);

/* Sidecar child-process handle: populated when the spawn succeeds, null
   when the preference is off OR something is already listening on :9000
   (manual `npm run tts:sidecar` already running). Kept module-scoped so
   the SIGINT/SIGTERM handlers below can reach it. */
let sidecarHandle: SidecarHandle | null = null;

/* Plan 81 mobile + tablet support — when LAN_HTTPS=1 is set, flip the
   listener from HTTP on :8080 to HTTPS on :8443 using mkcert-generated
   certs from .run/certs/. iOS Safari / Android Chrome won't show the
   "Not Secure" warning AND clipboard / file-picker / mic / camera /
   service-worker APIs become available on mobile.

   When LAN_HTTPS is unset, behaviour is identical to before plan 81:
   plain HTTP, app.listen(PORT) binds all interfaces, every existing
   workflow unchanged. The HTTPS path is opt-in only via npm run start:lan
   (which sets LAN_HTTPS=1 via cross-env). */
const lanHttps = isLanHttpsEnabled();
const repoRoot = resolve(__dirname, '..', '..');
const LAN_CERT_FILE = resolve(repoRoot, '.run', 'certs', 'lan-cert.pem');
const LAN_KEY_FILE = resolve(repoRoot, '.run', 'certs', 'lan-key.pem');

const listenerCallback = () => {
  const protocol: 'http' | 'https' = lanHttps ? 'https' : 'http';
  const listenPort = lanHttps ? LAN_HTTPS_PORT : PORT;
  // eslint-disable-next-line no-console
  console.log(`[server] listening on ${protocol}://localhost:${listenPort}`);
  // eslint-disable-next-line no-console
  console.log(`[server] workspace root: ${WORKSPACE_ROOT}`);

  /* Log the LAN URLs so the user can spot which IP to point their phone's
     browser at for the audiobook export sideload flow. Node's listen
     binds all interfaces, so every URL here genuinely reaches us. */
  const lan = enumerateLanUrls(listenPort, protocol);
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

  /* Plan 43 — spawn the Python TTS sidecar per user preference. Fired
     after the listener is up so the server is already accepting requests
     while the sidecar warms in the background. The catalog audit above
     will pick up the same sidecar once Kokoro/Coqui finishes loading. */
  void (async () => {
    const settings = await readUserSettings();
    sidecarHandle = await spawnSidecar({
      autoStart: getResolvedAutoStartSidecar(),
      modelKey: settings.defaultTtsModelKey,
      repoRoot: resolve(__dirname, '..', '..'),
    });
  })();
};

if (lanHttps) {
  if (!existsSync(LAN_CERT_FILE) || !existsSync(LAN_KEY_FILE)) {
    // eslint-disable-next-line no-console
    console.error(
      `[server] LAN_HTTPS=1 set but cert files are missing.\n` +
        `[server] Expected: ${LAN_CERT_FILE}\n` +
        `[server]           ${LAN_KEY_FILE}\n` +
        `[server] Run 'npm run install:cert-mobile' first to bootstrap mkcert and generate per-LAN-IP certs.`,
    );
    process.exit(1);
  }
  const key = readFileSync(LAN_KEY_FILE);
  const cert = readFileSync(LAN_CERT_FILE);
  createHttpsServer({ key, cert }, app).listen(LAN_HTTPS_PORT, listenerCallback);
} else {
  app.listen(PORT, listenerCallback);
}

/* On Ctrl+C or kill, reap the sidecar tree before exit so port 9000 is
   free for the next boot and stop-app.bat's port sweep has nothing left
   to find. On Windows the child is powershell.exe → uvicorn → python,
   and the handle's kill() runs `taskkill /T /F /PID <pid>` to cascade
   through the tree. */
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, tearing down sidecar...`);
  const reap = sidecarHandle?.kill() ?? Promise.resolve();
  void reap.finally(() => process.exit(0));
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
