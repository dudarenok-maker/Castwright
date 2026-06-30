/* Express app assembly — extracted from index.ts so the integration test suite
   can import the wired app without binding a port or running startup side-effects
   (queue reset, VRAM init, upgrade coordinator). index.ts imports this and calls
   app.listen(). All middleware order is identical to the original index.ts. */

import express from 'express';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mountFrontendStatic } from './frontend-static.js';
import { manuscriptsRouter } from './routes/manuscripts.js';
import { analysisRouter } from './routes/analysis.js';
import { voiceMatchRouter } from './routes/voice-match.js';
import { castMergeRouter } from './routes/cast-merge.js';
import { castMergeSuggestionsRouter } from './routes/cast-merge-suggestions.js';
import { voiceOverrideLinkedRouter } from './routes/voice-override-linked.js';
import { castTierRouter } from './routes/cast-tier.js';
import { castAliasesRouter } from './routes/cast-aliases.js';
import { castLinkPriorRouter } from './routes/cast-link-prior.js';
import { castNotLinkedToRouter } from './routes/cast-not-linked-to.js';
import { castSeriesPatchRouter } from './routes/cast-series-patch.js';
import { castAddFromRosterRouter } from './routes/cast-add-from-roster.js';
import { castCreateRouter } from './routes/cast-create.js';
import { voiceStyleRouter } from './routes/voice-style.js';
import { qwenVoiceRouter } from './routes/qwen-voice.js';
import { castDesignRouter } from './routes/cast-design.js';
import { singleDesignRouter } from './routes/single-design.js';
import { annotateEmotionRouter } from './routes/annotate-emotion.js';
import { instructAnnotationRouter } from './routes/instruct-annotation.js';
import { scriptReviewRouter } from './routes/script-review.js';
import { libraryCastOverrideRouter } from './routes/library-cast-override.js';
import { seriesRosterRouter } from './routes/series-roster.js';
import { seriesCastRouter } from './routes/series-cast.js';
import { voiceSampleRouter } from './routes/voice-sample.js';
import { voicesRouter } from './routes/voices.js';
import { libraryRouter } from './routes/library.js';
import { syncManifestRouter } from './routes/library-sync-manifest.js';
import { seriesMemoryRouter } from './routes/series-memory.js';
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
import { exportLanRouter } from './routes/export-lan.js';
import { certRootRouter } from './routes/cert-root.js';
import { devicesRouter } from './routes/devices.js';
import { pairSessionRouter, pairRedeemRouter } from './routes/pairing.js';
import { designProgressRelayRouter } from './routes/design-progress-relay.js';
import { requireLanToken } from './lan-auth.js';
import { requireSameOrigin } from './csrf-origin.js';
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
import { gpuDevicesRouter } from './routes/gpu-devices.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { setupReadinessRouter } from './routes/setup-readiness.js';
import { tourRouter } from './routes/tour.js';
import { workspaceRouter } from './routes/workspace.js';
import { userSettingsRouter } from './routes/user-settings.js';
import { configRouter } from './routes/config.js';
import { acceleratorProfileRouter } from './routes/accelerator-profile.js';
import { upgradeRouter } from './routes/upgrade.js';
import { infoRouter } from './routes/info.js';
import { updatesRouter } from './routes/updates.js';
import { companionRouter } from './routes/companion.js';
import { samplesRouter } from './routes/samples.js';
import { worktreesRouter } from './routes/worktrees.js';
import { backupRouter } from './routes/backup.js';
import { WORKSPACE_ROOT } from './workspace/paths.js';
import { buildHealthPayload } from './health-payload.js';
import { errorHandler } from './error-handler.js';
import { apiLimiter } from './middleware/rate-limit.js';
import { assertNoTrustProxy } from './lan-safety.js';

export const app = express();
assertNoTrustProxy(app);

/* QR pairing redeem routes are code-gated and intentionally pre-guard. Mounted
   BEFORE the global body parser so the per-route express.json({ limit: '1kb' })
   on each redeem handler engages first — placing them after the 20MB global
   parser would make those per-route caps a no-op (Express skips re-parsing when
   req._body is already set). Both /redeem and /redeem-browser carry their own
   1KB parser; see pairing.ts. */
app.use('/api/pair', pairRedeemRouter);

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Global anti-DoS limiter — mounted before every route/static mount so it
// dominates the whole API surface (no-op under test; see rate-limit.ts).
app.use(apiLimiter);

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = resolve(__dirname, '..', 'audio');
mkdirSync(resolve(AUDIO_DIR, 'voices'), { recursive: true });
app.use('/audio', express.static(AUDIO_DIR, { fallthrough: true, maxAge: '1h' }));

/* srv-20 — optional shared-secret token guard for the LAN exposure surface.
   Scoped to /api + /workspace; /cert/root.crt + /audio stay open. OFF unless
   LAN HTTPS mode is on AND LAN_AUTH_TOKEN is set; loopback always bypasses. */
app.use(['/api', '/workspace'], requireLanToken);
/* CSRF guard — only triggers on cookie-bearing state-changing requests (Task 6).
   Mounted after the LAN token guard so it only applies to authenticated sessions. */
app.use(['/api', '/workspace'], requireSameOrigin);
app.use('/workspace', express.static(WORKSPACE_ROOT, { fallthrough: true, maxAge: '1h' }));

app.get('/api/health', (_req, res) => {
  res.json(buildHealthPayload());
});

app.use('/api/workspace', workspaceRouter); // GET / (metadata) + GET /changelog (cross-book aggregator)
app.use('/api/user/settings', userSettingsRouter); // GET + PUT — account defaults + non-secret env overrides
app.use('/api/config', configRouter); // GET descriptors+values, PUT override, POST reset
app.use('/api/accelerator', acceleratorProfileRouter); // AMD phase 2 — job-guarded profile switch
app.use('/api/upgrade', upgradeRouter); // fs-1 — in-app upgrade: stage/apply/abort/state
app.use('/api/info', infoRouter); // fs-1 — app version + schemas + what's-new state
app.use('/api/updates', updatesRouter); // GET /latest — fail-open "newer release available?" check
app.use('/api/companion', companionRouter); // interim — GET/HEAD /apk: download the packaged Android APK
app.use('/api/samples', samplesRouter); // fs-22 — list + load the bundled demo book
app.use('/api', devicesRouter); // srv-33 — companion per-device tokens: GET/POST /devices, DELETE /devices/:id
app.use('/api/pair', pairSessionRouter); // QR pairing — loopback-only session mint (post-guard)
app.use('/api/internal', designProgressRelayRouter); // sidecar→server single-design phase relay (loopback only)
app.use('/api/library', libraryRouter);
app.use('/api/library', syncManifestRouter); // srv-32 — GET /api/library/sync-manifest
app.use('/api/library', seriesMemoryRouter); // fe-40 — GET /api/library/series-memory
app.use('/api', importRouter); // mounts /import and /books
app.use('/api/manuscripts', manuscriptsRouter);
app.use('/api/manuscripts', analysisRouter); // analysisRouter mounts /:id/analysis
app.use('/api/books', bookStateRouter); // mounts /:bookId/state (GET/PUT)
app.use('/api/books', backupRouter); // srv-2 — /:bookId/backups (list) + /backups/now + /backups/restore
app.use('/api/books', coverRouter); // mounts /:bookId/cover{,/candidates} (OpenLibrary covers)
app.use('/api/books', voiceMatchRouter); // mounts /:bookId/voice-match
app.use('/api/books', castMergeRouter); // mounts /:bookId/cast/merge
app.use('/api/books', castMergeSuggestionsRouter); // mounts /:bookId/cast/merge-suggestions (list/dismiss/accept)
app.use('/api/books', voiceOverrideLinkedRouter); // mounts /:bookId/cast/:characterId/voice-override-linked (plan 122 — name/alias-aware series voice write)
app.use('/api/books', castTierRouter); // mounts /:bookId/cast/tier (series-scoped Qwen quality tier pin)
app.use('/api/books', castAliasesRouter); // mounts /:bookId/cast/{unlink-alias,add-alias} (editable alias chips on the profile drawer)
app.use('/api/books', castLinkPriorRouter); // mounts /:bookId/cast/link-prior (manual continuity link to a prior series book)
app.use('/api/books', castNotLinkedToRouter); // mounts /:bookId/cast/:characterId/not-linked-to (plan 101 — mark cross-book duplicate as intentional variant)
app.use('/api/books', castSeriesPatchRouter); // mounts /:bookId/cast/:characterId/series-patch (cross-book Compare save propagation, BACKLOG #7)
app.use('/api/books', castAddFromRosterRouter); // mounts /:bookId/cast/add-from-roster (new local character pulled from a prior series-mate)
app.use('/api/books', castCreateRouter); // mounts /:bookId/cast/create (fs-58 Unit B — mint a net-new cast member)
app.use('/api/books', voiceStyleRouter); // mounts /:bookId/cast/{:characterId/voice-style/generate,voice-style/generate-all} (plan 108 — Gemini voice-design personas)
app.use('/api/books', qwenVoiceRouter); // mounts /:bookId/cast/:characterId/design-voice (plan 108 Wave 4 — Qwen bespoke-voice design + audition proxy)
app.use('/api/books', castDesignRouter); // mounts /:bookId/cast/design{,/status,/pause} ("Design full cast" bulk-design job — server-owned SSE)
app.use('/api/books', singleDesignRouter); // mounts /:bookId/cast/:characterId/design-voice/stream + /:bookId/cast/design-single/{subscribe,status} (single-design background job)
app.use('/api/books', annotateEmotionRouter); // mounts /:bookId/annotate-emotion (fs-33 — emotion-only backfill SSE pass)
app.use('/api/books', instructAnnotationRouter); // mounts /:bookId/instruct-annotation (fs-57 — Stage-3 instruct-annotation SSE pass)
app.use('/api/books', scriptReviewRouter); // mounts /:bookId/script-review (fs-58 — LLM script-review SSE pass)
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
app.use('/api/gpu', gpuDevicesRouter); // mounts GET /devices (CUDA card discovery for the admin picker)
app.use('/api/diagnostics', diagnosticsRouter); // fs-18 — GET / one-shot health board (admin console)
app.use('/api/setup', setupReadinessRouter); // fs-21 — first-run readiness probe
app.use('/api/setup/venv', venvBootstrapRouter); // fs-21 wave 1b — venv bootstrap (decision Z)
app.use('/api/tour', tourRouter); // guided-tour status + completion

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
