/* Manual cowork handoff protocol.

   writeInbox writes a markdown prompt to server/handoff/inbox/{id}-stage{key}.md
   where `key` is '1' for stage 1, '2' for the legacy whole-manuscript stage 2,
   or '2-ch{n}' for the per-chapter stage 2 (current default — see
   server/src/routes/analysis.ts). awaitOutbox chokidars the corresponding
   outbox file, validates the JSON against a zod schema, and resolves with the
   parsed payload. If the JSON is malformed or fails validation, it writes a
   .errors.json sibling and keeps watching for a corrected drop. */

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

/* Handoff key identifying the slice of work the inbox/outbox pair carries.
   Literal types instead of free strings so callers can't typo a key.
   `1-ch{n}` is per-chapter Phase 0a cast detection (the new flow);
   plain `1` is the legacy whole-book stage 1 (kept for back-compat with
   any cached drops). */
export type HandoffKey = '1' | `1-ch${number}` | '2' | `2-ch${number}`;

async function ensureDirs(): Promise<void> {
  await mkdir(INBOX, { recursive: true });
  await mkdir(OUTBOX, { recursive: true });
}

export function inboxPath(manuscriptId: string, key: HandoffKey): string {
  return join(INBOX, `${manuscriptId}-stage${key}.md`);
}

export function outboxPath(manuscriptId: string, key: HandoffKey): string {
  return join(OUTBOX, `${manuscriptId}-stage${key}.json`);
}

export function errorPath(manuscriptId: string, key: HandoffKey): string {
  return join(OUTBOX, `${manuscriptId}-stage${key}.errors.json`);
}

export async function writeInbox(manuscriptId: string, key: HandoffKey, body: string): Promise<string> {
  await ensureDirs();
  const path = inboxPath(manuscriptId, key);
  // Clean any stale outbox so we only resolve on a fresh drop.
  await rm(outboxPath(manuscriptId, key), { force: true });
  await rm(errorPath(manuscriptId, key), { force: true });
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
  key: HandoffKey,
  schema: z.ZodType<T>,
  opts: AwaitOptions = {},
): Promise<T> {
  await ensureDirs();
  const target = outboxPath(manuscriptId, key);
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
          await writeFile(errorPath(manuscriptId, key), JSON.stringify({
            kind: 'invalid-json',
            message: (e as Error).message,
          }, null, 2), 'utf8');
          return;
        }
        const result = schema.safeParse(parsed);
        if (!result.success) {
          await writeFile(errorPath(manuscriptId, key), JSON.stringify({
            kind: 'schema-validation',
            issues: result.error.issues,
          }, null, 2), 'utf8');
          // Drop the bad file so the next correct one fires a fresh 'add' event.
          await rm(path, { force: true });
          return;
        }
        // Success — delete the consumed outbox file so a re-run gets a clean slate.
        await rm(path, { force: true });
        await rm(errorPath(manuscriptId, key), { force: true });
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
