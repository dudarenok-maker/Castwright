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

import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from './app.js';
import { enumerateLanUrls, isLanHttpsEnabled } from './routes/export-lan.js';
import { runCatalogAudit } from './tts/coqui-catalog-audit.js';
import { auditEngineCatalog } from './tts/voice-mapping.js';
import { WORKSPACE_ROOT, BOOKS_ROOT, ensureWorkspace } from './workspace/paths.js';
import { migrateLegacyChangeLogs } from './workspace/changelog-migrate.js';
import { runUpgradeCoordinator } from './workspace/upgrade-coordinator.js';
import { getAppVersion } from './app-version.js';
import { fsckAllBooks } from './workspace/fsck-orphan-audio.js';
import { resetOrphanedQueueEntries } from './workspace/queue-boot.js';
import { initDeviceTotalVram, getDeviceTotalVramMb } from './gpu/device-total.js';
import { rotateStatsIfDeviceChanged } from './gpu/telemetry-fingerprint.js';
import { initVramStats } from './analyzer/model-vram-stats.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// VRAM telemetry substrate (fs-45 v1, record-only — nothing consumes this yet).
// Order: probe device total → rotate stale stats if GPU changed → prime cache.
await initDeviceTotalVram();
await rotateStatsIfDeviceChanged(getDeviceTotalVramMb());
await initVramStats();

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
