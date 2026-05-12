/* Manual cowork handoff protocol.

   writeInbox writes a markdown prompt to server/handoff/inbox/{id}-stage{N}.md.
   awaitOutbox chokidars server/handoff/outbox/{id}-stage{N}.json, validates
   the JSON against a zod schema, and resolves with the parsed payload. If the
   JSON is malformed or fails validation, it writes a .errors.json sibling and
   keeps watching for a corrected drop. */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar, { type FSWatcher } from 'chokidar';
import type { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');
const INBOX = join(HANDOFF_ROOT, 'inbox');
const OUTBOX = join(HANDOFF_ROOT, 'outbox');

async function ensureDirs(): Promise<void> {
  await mkdir(INBOX, { recursive: true });
  await mkdir(OUTBOX, { recursive: true });
}

export function inboxPath(manuscriptId: string, stage: 1 | 2): string {
  return join(INBOX, `${manuscriptId}-stage${stage}.md`);
}

export function outboxPath(manuscriptId: string, stage: 1 | 2): string {
  return join(OUTBOX, `${manuscriptId}-stage${stage}.json`);
}

export function errorPath(manuscriptId: string, stage: 1 | 2): string {
  return join(OUTBOX, `${manuscriptId}-stage${stage}.errors.json`);
}

export async function writeInbox(manuscriptId: string, stage: 1 | 2, body: string): Promise<string> {
  await ensureDirs();
  const path = inboxPath(manuscriptId, stage);
  // Clean any stale outbox so we only resolve on a fresh drop.
  await rm(outboxPath(manuscriptId, stage), { force: true });
  await rm(errorPath(manuscriptId, stage), { force: true });
  await writeFile(path, body, 'utf8');
  return path;
}

export interface AwaitOptions {
  /** Default 30 minutes. Set higher for long manuscripts. */
  timeoutMs?: number;
  /** Called periodically while we're still waiting (every ~500ms). */
  onWaiting?: (elapsedMs: number) => void;
}

export async function awaitOutbox<T>(
  manuscriptId: string,
  stage: 1 | 2,
  schema: z.ZodType<T>,
  opts: AwaitOptions = {},
): Promise<T> {
  await ensureDirs();
  const target = outboxPath(manuscriptId, stage);
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const start = Date.now();

  return new Promise<T>((resolvePromise, rejectPromise) => {
    let watcher: FSWatcher | null = null;
    let waitingTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (waitingTimer) clearInterval(waitingTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (watcher) void watcher.close();
    };

    const tryParse = async (path: string) => {
      try {
        const raw = await readFile(path, 'utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          await writeFile(errorPath(manuscriptId, stage), JSON.stringify({
            kind: 'invalid-json',
            message: (e as Error).message,
          }, null, 2), 'utf8');
          return;
        }
        const result = schema.safeParse(parsed);
        if (!result.success) {
          await writeFile(errorPath(manuscriptId, stage), JSON.stringify({
            kind: 'schema-validation',
            issues: result.error.issues,
          }, null, 2), 'utf8');
          // Drop the bad file so the next correct one fires a fresh 'add' event.
          await rm(path, { force: true });
          return;
        }
        // Success — delete the consumed outbox file so a re-run gets a clean slate.
        await rm(path, { force: true });
        await rm(errorPath(manuscriptId, stage), { force: true });
        cleanup();
        resolvePromise(result.data);
      } catch (e) {
        cleanup();
        rejectPromise(e);
      }
    };

    watcher = chokidar.watch(target, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });
    watcher.on('add', tryParse);
    watcher.on('change', tryParse);
    watcher.on('error', (err) => { cleanup(); rejectPromise(err); });

    // Pre-existing file (we cleared it in writeInbox, but be defensive).
    if (existsSync(target)) {
      void tryParse(target);
    }

    if (opts.onWaiting) {
      waitingTimer = setInterval(() => {
        if (!settled) opts.onWaiting!(Date.now() - start);
      }, 500);
    }

    timeoutTimer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`Handoff timeout waiting for outbox ${target} after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

export { INBOX, OUTBOX };
