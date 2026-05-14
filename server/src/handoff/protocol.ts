/* Inbox/outbox file paths used for traceability. The Gemini analyzer
   writes the prompt that went to the model into the inbox and writes the
   raw JSON response into the outbox so a developer can reproduce a
   particular run from disk. The historical manual file-drop "cowork"
   analyzer used the same paths to coordinate human responses; that
   analyzer is gone, so awaitOutbox + chokidar are gone too. */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');
const INBOX = join(HANDOFF_ROOT, 'inbox');
const OUTBOX = join(HANDOFF_ROOT, 'outbox');

/* Handoff key identifying the slice of work the inbox/outbox pair carries.
   Literal types instead of free strings so callers can't typo a key.
   `1-ch{n}` is per-chapter Phase 0a cast detection (the current flow);
   plain `1` is the legacy whole-book stage 1 (kept for back-compat). */
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
  // Clean any stale outbox so a stale dropped file can't masquerade as fresh.
  await rm(outboxPath(manuscriptId, key), { force: true });
  await rm(errorPath(manuscriptId, key), { force: true });
  await writeFile(path, body, 'utf8');
  return path;
}

export { INBOX, OUTBOX };
