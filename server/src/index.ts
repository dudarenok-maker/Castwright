/* Local development backend for Castwright.
   Implements the upload + analysis + voice-match slice of the OpenAPI spec.
   Frontend (Vite, :5173) proxies /api/* to this server (:8080) — see vite.config.ts. */

/* MUST be the first import: it runs `process.loadEnvFile('.env')` as a
   top-level side effect, populating `process.env` before any downstream
   module in the graph evaluates. Without this, ESM hoisting means imports
   like `./workspace/paths.js` capture an empty `process.env.WORKSPACE_DIR`
   even though `.env` sets it — yielding the silent "stale workspace root"
   bug that recreates `audiobook-workspace/` inside the repo. */
import './load-env.js';
import { buildHealthPayload } from './health-payload.js';

/* Patch console.* to prefix every line with a YYYY-MM-DD HH:mm:ss.SSS
   stamp. Runtime logging (route handlers, app.listen callback, …) all
   fires after this call, so every line in logs/server.log is stamped. */
import { installTimestamps } from './logger.js';
import { resolveRunDir } from './app-dirs.js';
installTimestamps();

/* Install crash handlers ASAP — right after console is timestamp-patched — so a
   startup OR runtime crash is captured in logs/server.err.log instead of the
   server vanishing silently (it died twice on 2026-05-30 with no trace). Also
   makes a stray unhandled rejection survivable so a transient async error can't
   take down an unattended generation run. See crash-logging.ts. */
import { installCrashHandlers, attachListenErrorHandler } from './crash-logging.js';
import { selectBindHost } from './bind-host.js';
installCrashHandlers();

import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { mountFrontendStatic } from './frontend-static.js';
import { fileURLToPath } from 'node:url';
import { manuscriptsRouter } from './routes/manuscripts.js';
import { analysisRouter } from './routes/analysis.js';
import { voiceMatchRouter } from './routes/voice-match.js';
import { castMergeRouter } from './routes/cast-merge.js';
import { voiceOverrideLinkedRouter } from './routes/voice-override-linked.js';
import { castAliasesRouter } from './routes/cast-aliases.js';
import { castLinkPriorRouter } from './routes/cast-link-prior.js';
import { castNotLinkedToRouter } from './routes/cast-not-linked-to.js';
import { castSeriesPatchRouter } from './routes/cast-series-patch.js';
import { castAddFromRosterRouter } from './routes/cast-add-from-roster.js';
import { voiceStyleRouter } from './routes/voice-style.js';
import { qwenVoiceRouter } from './routes/qwen-voice.js';
import { castDesignRouter } from './routes/cast-design.js';
import { singleDesignRouter } from './routes/single-design.js';
import { annotateEmotionRouter } from './routes/annotate-emotion.js';
import { libraryCastOverrideRouter } from './routes/library-cast-override.js';
import { seriesRosterRouter } from './routes/series-roster.js';
import { seriesCastRouter } from './routes/series-cast.js';
import { voiceSampleRouter } from './routes/voice-sample.js';
import { voicesRouter } from './routes/voices.js';
import { libraryRouter } from './routes/library.js';
import { syncManifestRouter } from './routes/library-sync-manifest.js';
import { importRouter } from './routes/import.js';
import { bookStateRouter } from './routes/book-state.js';
import { coverRouter } from './routes/cover.js';
import { generationRouter } from './routes/generation.js';
import { chapterSpliceRouter } from './routes/chapter-splice.js';
import { chapterQaRepairRouter } from './routes/chapter-qa-repair.js';
import { generationStatsRouter } from './routes/generation-stats.js';
import { queueRouter } from './routes/queue.js';
import { chapterAudioRouter } from './routes/chapter-audio.js';
import { clipRouter } from './routes/clip.js';
import { chaptersRestructureRouter } from './routes/chapters-restructure.js';
import { exportRouter } from './routes/export.js';
import { exportLanRouter, enumerateLanUrls, isLanHttpsEnabled } from './routes/export-lan.js';
import { certRootRouter } from './routes/cert-root.js';
import { devicesRouter } from './routes/devices.js';
import { pairSessionRouter, pairRedeemRouter } from './routes/pairing.js';
import { requireLanToken } from './lan-auth.js';
import { portableExportRouter, portableImportRouter } from './routes/exports-portable.js';
import { shareRouter, sharePublicRouter } from './routes/share.js';
import { revisionsRouter, revisionsBulkRouter } from './routes/revisions.js';
import { sidecarHealthRouter } from './routes/sidecar-health.js';
import { ollamaHealthRouter } from './routes/ollama-health.js';
import { qwenInstallRouter } from './routes/qwen-install.js';
import { modelsInventoryRouter } from './routes/models-inventory.js';
import { whisperInstallRouter } from './routes/whisper-install.js';
import { coquiInstallRouter } from './routes/coqui-install.js';
import { kokoroInstallRouter } from './routes/kokoro-install.js';
import { venvBootstrapRouter } from './routes/venv-bootstrap.js';
import { gpuQueueRouter } from './routes/gpu-queue.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { setupReadinessRouter } from './routes/setup-readiness.js';
import { workspaceRouter } from './routes/workspace.js';
import { userSettingsRouter } from './routes/user-settings.js';
import { configRouter } from './routes/config.js';
import { runCatalogAudit } from './tts/coqui-catalog-audit.js';
import { auditEngineCatalog } from './tts/voice-mapping.js';
import { WORKSPACE_ROOT, BOOKS_ROOT, ensureWorkspace } from './workspace/paths.js';
import { migrateLegacyChangeLogs } from './workspace/changelog-migrate.js';
import { runUpgradeCoordinator } from './workspace/upgrade-coordinator.js';
import { getAppVersion } from './app-version.js';
import { fsckAllBooks } from './workspace/fsck-orphan-audio.js';
import { resetOrphanedQueueEntries } from './workspace/queue-boot.js';
import { startBackupScheduler, stopBackupScheduler } from './workspace/auto-backup.js';
import {
  readUserSettings,
  writeUpgradeMeta,
  USER_SETTINGS_PATH,
  getResolvedSidecarUrl,
  getResolvedAutoStartSidecar,
  getResolvedTtsModelKey,
  setLastKnownQwenInstallState,
} from './workspace/user-settings.js';
import {
  createSidecarSupervisor,
  registerActiveSupervisor,
  type SidecarSupervisor,
} from './tts/sidecar-supervisor.js';
import { detectQwenInstallStateOnDisk } from './tts/qwen-install-detect.js';
import { errorHandler } from './error-handler.js';

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

/* srv-20 — optional shared-secret token guard for the LAN exposure surface.
   Scoped to /api + /workspace; /cert/root.crt + /audio stay open. OFF unless
   LAN HTTPS mode is on AND LAN_AUTH_TOKEN is set; loopback always bypasses. */
app.use('/api/pair', pairRedeemRouter); // QR pairing — code-gated, intentionally pre-guard
app.use(['/api', '/workspace'], requireLanToken);
app.use('/workspace', express.static(WORKSPACE_ROOT, { fallthrough: true, maxAge: '1h' }));

app.get('/api/health', (_req, res) => {
  res.json(buildHealthPayload());
});

app.use('/api/workspace', workspaceRouter); // GET / (metadata) + GET /changelog (cross-book aggregator)
app.use('/api/user/settings', userSettingsRouter); // GET + PUT — account defaults + non-secret env overrides
app.use('/api/config', configRouter); // GET descriptors+values, PUT override, POST reset
import { upgradeRouter } from './routes/upgrade.js';
app.use('/api/upgrade', upgradeRouter); // fs-1 — in-app upgrade: stage/apply/abort/state
import { infoRouter } from './routes/info.js';
app.use('/api/info', infoRouter); // fs-1 — app version + schemas + what's-new state
import { companionRouter } from './routes/companion.js';
app.use('/api/companion', companionRouter); // interim — GET/HEAD /apk: download the packaged Android APK
import { samplesRouter } from './routes/samples.js';
app.use('/api/samples', samplesRouter); // fs-22 — list + load the bundled demo book
app.use('/api', devicesRouter); // srv-33 — companion per-device tokens: GET/POST /devices, DELETE /devices/:id
app.use('/api/pair', pairSessionRouter); // QR pairing — loopback-only session mint (post-guard)
app.use('/api/library', libraryRouter);
app.use('/api/library', syncManifestRouter); // srv-32 — GET /api/library/sync-manifest
app.use('/api', importRouter); // mounts /import and /books
app.use('/api/manuscripts', manuscriptsRouter);
app.use('/api/manuscripts', analysisRouter); // analysisRouter mounts /:id/analysis
app.use('/api/books', bookStateRouter); // mounts /:bookId/state (GET/PUT)
import { backupRouter } from './routes/backup.js';
app.use('/api/books', backupRouter); // srv-2 — /:bookId/backups (list) + /backups/now + /backups/restore
app.use('/api/books', coverRouter); // mounts /:bookId/cover{,/candidates} (OpenLibrary covers)
app.use('/api/books', voiceMatchRouter); // mounts /:bookId/voice-match
app.use('/api/books', castMergeRouter); // mounts /:bookId/cast/merge
app.use('/api/books', voiceOverrideLinkedRouter); // mounts /:bookId/cast/:characterId/voice-override-linked (plan 122 — name/alias-aware series voice write)
app.use('/api/books', castAliasesRouter); // mounts /:bookId/cast/{unlink-alias,add-alias} (editable alias chips on the profile drawer)
app.use('/api/books', castLinkPriorRouter); // mounts /:bookId/cast/link-prior (manual continuity link to a prior series book)
app.use('/api/books', castNotLinkedToRouter); // mounts /:bookId/cast/:characterId/not-linked-to (plan 101 — mark cross-book duplicate as intentional variant)
app.use('/api/books', castSeriesPatchRouter); // mounts /:bookId/cast/:characterId/series-patch (cross-book Compare save propagation, BACKLOG #7)
app.use('/api/books', castAddFromRosterRouter); // mounts /:bookId/cast/add-from-roster (new local character pulled from a prior series-mate)
app.use('/api/books', voiceStyleRouter); // mounts /:bookId/cast/{:characterId/voice-style/generate,voice-style/generate-all} (plan 108 — Gemini voice-design personas)
app.use('/api/books', qwenVoiceRouter); // mounts /:bookId/cast/:characterId/design-voice (plan 108 Wave 4 — Qwen bespoke-voice design + audition proxy)
app.use('/api/books', castDesignRouter); // mounts /:bookId/cast/design{,/status,/pause} ("Design full cast" bulk-design job — server-owned SSE)
app.use('/api/books', singleDesignRouter); // mounts /:bookId/cast/:characterId/design-voice/stream + /:bookId/cast/design-single/{subscribe,status} (single-design background job)
app.use('/api/books', annotateEmotionRouter); // mounts /:bookId/annotate-emotion (fs-33 — emotion-only backfill SSE pass)
app.use('/api/books', seriesRosterRouter); // mounts /:bookId/series-roster (prior-book characters in the same series)
app.use('/api/books', seriesCastRouter); // mounts /:bookId/series-cast (full-fidelity cast of every OTHER series book — rebaseline aggregation)
app.use('/api', libraryCastOverrideRouter); // mounts /library-cast/override (cross-book; not under /:bookId)
app.use('/api/books', generationRouter); // mounts /:bookId/generation (SSE)
app.use('/api/books', chapterSpliceRouter); // fs-26 — mounts /:bookId/chapters/:chapterId/splice (SSE)
app.use('/api/books', chapterQaRepairRouter); // mounts /:bookId/chapters/:chapterId/audio-qa-repair (SSE)
app.use('/api/generation', generationStatsRouter); // GET /stats — live RTF throughput for the dev pill
app.use('/api/queue', queueRouter); // plan 102 — workspace-level cross-book chapter-generation queue
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
app.use('/api/qwen', qwenInstallRouter); // in-app Qwen3-TTS installer (detect/install/poll/recheck)
app.use('/api/coqui', coquiInstallRouter); // in-app Coqui XTTS v2 installer (detect/install/poll/recheck)
app.use('/api/kokoro', kokoroInstallRouter); // in-app Kokoro ONNX installer (fs-21: detect/install/poll/recheck)
app.use('/api/whisper', whisperInstallRouter); // in-app Whisper ASR installer (srv-31: detect/install/poll/recheck)
app.use('/api/models', modelsInventoryRouter); // fs-23 — in-app Model Manager: inventory + remove
app.use('/api/gpu', gpuQueueRouter); // mounts GET /queue (semaphore depth + inFlight for the top-bar pill)
app.use('/api/diagnostics', diagnosticsRouter); // fs-18 — GET / one-shot health board (admin console)
app.use('/api/setup', setupReadinessRouter); // fs-21 — first-run readiness probe
app.use('/api/setup/venv', venvBootstrapRouter); // fs-21 wave 1b — venv bootstrap (decision Z)

/* Production-mode frontend serving. Helper resolves whether to mount based
   on NODE_ENV=production OR the existence of dist/index.html. Mounted AFTER
   every /api/* and /audio/* and /workspace/* route so the API can never be
   shadowed by a static file. Hash-router SPA, so no `*` → index.html
   fallback is needed. */
{
  const distDir = resolve(__dirname, '..', '..', 'dist');
  const result = mountFrontendStatic(app, distDir);
  if (result.mounted) {
    console.log(`[server] serving frontend bundle from ${result.distDir} (${result.reason})`);
  } else if (process.env.NODE_ENV === 'production') {
    console.warn(`[server] frontend NOT mounted: ${result.reason}`);
  }
}

/* Express-5 async-rejection backstop — registered LAST, after every route and
   the frontend static mount, so it catches anything the per-route try/catch
   blocks miss. See error-handler.ts. */
app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 8080);
const LAN_HTTPS_PORT = Number(process.env.LAN_HTTPS_PORT ?? 8443);

/* Sidecar supervisor (srv-15): owns the sidecar child handle and respawns it
   on unexpected exit (crash / OOM-kill / poison self-exit). Module-scoped so
   the SIGINT/SIGTERM handlers below can stop it (which reaps the child without
   triggering a respawn). Null until the boot block constructs it. */
let sidecarSupervisor: SidecarSupervisor | null = null;

/* Plan 81 mobile + tablet support — when LAN_HTTPS=1 is set, flip the
   listener from HTTP on :8080 to HTTPS on :8443 using mkcert-generated
   certs from .run/certs/. iOS Safari / Android Chrome won't show the
   "Not Secure" warning AND clipboard / file-picker / mic / camera /
   service-worker APIs become available on mobile.

   When LAN_HTTPS is unset, behaviour is plain HTTP on :8080, every existing
   workflow unchanged — EXCEPT the bind host: since srv-19 the default HTTP
   listener binds loopback (127.0.0.1) only, so the unauthenticated API +
   /workspace static mount aren't reachable from other LAN machines. Set
   BIND_HOST=0.0.0.0 (or HOST=…) to restore all-interface HTTP. The HTTPS path
   is opt-in only via npm run start:lan (LAN_HTTPS=1) and keeps binding all
   interfaces — it's the deliberately-reachable mobile flow. */
const lanHttps = isLanHttpsEnabled();
const bindHost = selectBindHost(lanHttps);
const repoRoot = resolve(__dirname, '..', '..');
/* .run/ honours APP_RUN_DIR so a versioned-dir install (fs-1) shares one cert
   store across releases instead of regenerating per release. */
const runDir = resolveRunDir(repoRoot);
const LAN_CERT_FILE = resolve(runDir, 'certs', 'lan-cert.pem');
const LAN_KEY_FILE = resolve(runDir, 'certs', 'lan-key.pem');

const listenerCallback = () => {
  const protocol: 'http' | 'https' = lanHttps ? 'https' : 'http';
  const listenPort = lanHttps ? LAN_HTTPS_PORT : PORT;

  console.log(`[server] listening on ${protocol}://localhost:${listenPort}`);

  console.log(`[server] workspace root: ${WORKSPACE_ROOT}`);

  /* Log the LAN URLs so the user can spot which IP to point their phone's
     browser at for the audiobook export sideload flow. Node's listen
     binds all interfaces, so every URL here genuinely reaches us. */
  const lan = enumerateLanUrls(listenPort, protocol);
  for (const url of lan.urls) {
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
  const bootRepoRoot = resolve(__dirname, '..', '..');
  /* Seed the Qwen install-state from a Node-side disk probe BEFORE resolving
     the default — the sidecar /health probe isn't available yet (we're about
     to spawn it). This lets a box with Qwen installed hot-preload Qwen at boot
     (PRELOAD_QWEN=1); a box without it spawns with Kokoro eager + Qwen off, and
     the conditional default falls back to Kokoro. The /health poll refreshes
     this continuously once the sidecar is up. */
  setLastKnownQwenInstallState(detectQwenInstallStateOnDisk(bootRepoRoot));
  /* srv-15 — supervise the sidecar instead of a one-shot spawn, so a crash /
     OOM-kill / poison self-exit respawns instead of stalling generation
     forever. `buildOpts` re-reads settings on each respawn so a mid-session
     eager-load / model-key change is picked up by the next process. */
  sidecarSupervisor = createSidecarSupervisor({
    buildOpts: async () => {
      const settings = await readUserSettings();
      return {
        autoStart: getResolvedAutoStartSidecar(),
        /* Resolved (Qwen-when-installed) key — drives PRELOAD_QWEN vs Kokoro. */
        modelKey: getResolvedTtsModelKey(),
        eagerLoadKokoro: settings.eagerLoadKokoro ?? true,
        eagerLoadQwen: settings.eagerLoadQwen ?? true,
        repoRoot: bootRepoRoot,
      };
    },
  });
  void sidecarSupervisor.start();
  registerActiveSupervisor(sidecarSupervisor);

  /* srv-2 — start the periodic per-book state.json backup sweep (no-op when
     disabled in user-settings). Timers are unref()'d so they never hold the
     process open on their own. */
  startBackupScheduler();
};

/* Plan: server-boot orphan sweep for the chapter-generation queue. A restart
   / crash / browser reload can strand entries `in_progress` on disk with no
   live stream behind them; the frontend dispatcher then neither re-runs them
   (FILL claims only `queued`) nor reconciles them (its in-memory inFlight map
   is empty on a fresh boot), so the chapter wedges and the GPU sits idle.
   Flipping them back to `queued` lets the dispatcher re-claim and finish them.
   Safe because a server restart kills all in-flight synthesis (the server owns
   the generation SSE). AWAITED before listen — not fire-and-forget — so no
   freshly-connecting frontend can /start a queued entry in the gap between the
   sweep's read and write and have it clobbered. The inner .catch keeps a queue
   read error from blocking startup. See workspace/queue-boot.ts. */
await resetOrphanedQueueEntries()
  .then((r) => {
    if (r.reset > 0) {
      console.log(
        `[queue] reset ${r.reset} orphaned in_progress entr${r.reset === 1 ? 'y' : 'ies'} ` +
          `to queued on boot (workspace/queue-boot.ts).`,
      );
    }
  })
  .catch((err) => console.warn('[queue] orphan reset skipped:', err));

/* fs-1 — boot upgrade coordinator. On a version increase since last boot it
   backs up every workspace JSON to <WORKSPACE_ROOT>/.upgrade-backups/ BEFORE
   running any schema migration, records the new version, and flags the
   what's-new banner. AWAITED before listen so no request hits half-migrated
   data; the inner .catch keeps a backup/IO error from blocking startup (the
   coordinator is idempotent and retries next boot). releasesDir is the parent
   of repoRoot ONLY in a versioned-dir install (repoRoot == releases/vX.Y.Z),
   else null — so prune is a no-op in a dev checkout. */
const releasesParent = dirname(repoRoot);
const releasesDir = basename(releasesParent) === 'releases' ? releasesParent : null;
await runUpgradeCoordinator({
  appVersion: getAppVersion(),
  workspaceRoot: WORKSPACE_ROOT,
  booksRoot: BOOKS_ROOT,
  userSettingsPath: USER_SETTINGS_PATH,
  readLastSeenAppVersion: async () => (await readUserSettings()).lastSeenAppVersion,
  writeMeta: writeUpgradeMeta,
  releasesDir,
  log: (m) => console.log(m),
})
  .then((r) => {
    if (r.action === 'upgrade') {
      console.log(
        `[upgrade] v${r.fromVersion} → v${r.toVersion}: ${r.backedUp?.length ?? 0} file(s) backed up, ` +
          `${r.migrated?.length ?? 0} migrated, ${r.prunedReleases?.length ?? 0} old release(s) pruned.`,
      );
    }
  })
  .catch((err) => console.warn('[upgrade] coordinator skipped:', err));

if (lanHttps) {
  if (!existsSync(LAN_CERT_FILE) || !existsSync(LAN_KEY_FILE)) {
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
  const server = createHttpsServer({ key, cert }, app).listen(
    LAN_HTTPS_PORT,
    bindHost,
    listenerCallback,
  );
  attachListenErrorHandler(server, LAN_HTTPS_PORT);
} else {
  const server = app.listen(PORT, bindHost, listenerCallback);
  attachListenErrorHandler(server, PORT);
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
  stopBackupScheduler();
  console.log(`[server] ${signal} received, tearing down sidecar...`);
  /* stop() sets the supervisor's stopped flag BEFORE reaping the child, so the
     child's exit can't trigger a respawn race during shutdown. */
  const reap = sidecarSupervisor?.stop() ?? Promise.resolve();
  void reap.finally(() => process.exit(0));
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
