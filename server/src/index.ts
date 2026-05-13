/* Local development backend for the audiobook generator.
   Implements the upload + analysis + voice-match slice of the OpenAPI spec.
   Frontend (Vite, :5173) proxies /api/* to this server (:8080) — see vite.config.ts. */

// Load server/.env (Node 20.6+ native; no dotenv dep). Missing file is fine —
// fall back to shell env. Logs at info level so absent prod env isn't silent.
try {
  process.loadEnvFile('.env');
} catch {
  console.info('[server] no .env file; using process env');
}

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
import { WORKSPACE_ROOT, ensureWorkspace } from './workspace/paths.js';

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

app.use('/api/library', libraryRouter);
app.use('/api', importRouter); // mounts /import and /books
app.use('/api/manuscripts', manuscriptsRouter);
app.use('/api/manuscripts', analysisRouter); // analysisRouter mounts /:id/analysis
app.use('/api/books', bookStateRouter);      // mounts /:bookId/state (GET/PUT)
app.use('/api/books', voiceMatchRouter);     // mounts /:bookId/voice-match
app.use('/api/books', generationRouter);     // mounts /:bookId/generation (SSE)
app.use('/api/books', chapterAudioRouter);   // mounts /:bookId/chapters/:chapterId/audio(.wav)
app.use('/api/voices', voicesRouter);        // mounts GET / + PUT /:voiceId/pin
app.use('/api/voices', voiceSampleRouter);   // mounts POST /:voiceId/sample

const PORT = Number(process.env.PORT ?? 8080);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[server] workspace root: ${WORKSPACE_ROOT}`);
});
