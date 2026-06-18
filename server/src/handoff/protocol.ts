/* Inbox/outbox file paths used for traceability. The Gemini analyzer
   writes the prompt that went to the model into the inbox and writes the
   raw JSON response into the outbox so a developer can reproduce a
   particular run from disk. The historical manual file-drop "cowork"
   analyzer used the same paths to coordinate human responses; that
   analyzer is gone, so awaitOutbox + chokidar are gone too. */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeSegment, assertContained } from '../util/safe-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');
const INBOX = join(HANDOFF_ROOT, 'inbox');
const OUTBOX = join(HANDOFF_ROOT, 'outbox');

/* Handoff key identifying the slice of work the inbox/outbox pair carries.
   Literal types instead of free strings so callers can't typo a key.
   `1-ch{n}` is per-chapter Phase 0a cast detection (the current flow);
   plain `1` is the legacy whole-book stage 1 (kept for back-compat).
   `emotion-ch{n}` is the fs-33 emotion-only backfill pass. */
export type HandoffKey =
  | '1'
  | `1-ch${number}`
  | '2'
  | `2-ch${number}`
  | `emotion-ch${number}`;

async function ensureDirs(): Promise<void> {
  await mkdir(INBOX, { recursive: true });
  await mkdir(OUTBOX, { recursive: true });
}

export function inboxPath(manuscriptId: string, key: HandoffKey): string {
  const p = join(INBOX, `${safeSegment(manuscriptId)}-stage${key}.md`);
  assertContained(INBOX, p);
  return p;
}

export function outboxPath(manuscriptId: string, key: HandoffKey): string {
  const p = join(OUTBOX, `${safeSegment(manuscriptId)}-stage${key}.json`);
  assertContained(OUTBOX, p);
  return p;
}

export function errorPath(manuscriptId: string, key: HandoffKey): string {
  const p = join(OUTBOX, `${safeSegment(manuscriptId)}-stage${key}.errors.json`);
  assertContained(OUTBOX, p);
  return p;
}

/* Forensic record of a model response that failed parse/validation. Lives
   alongside the structured `errors.json` so a developer can open the
   actual bytes (e.g. byte 1365 line 46 col 37) and diagnose what tripped
   the parser. `attempt` is 1 or 2 — both attempts get their own file when
   they fail, so a partial-success retry preserves the first attempt's text
   for comparison. */
export function rawAttemptPath(manuscriptId: string, key: HandoffKey, attempt: 1 | 2): string {
  const p = join(OUTBOX, `${safeSegment(manuscriptId)}-stage${key}.attempt${attempt}.raw.txt`);
  assertContained(OUTBOX, p);
  return p;
}

export async function writeInbox(
  manuscriptId: string,
  key: HandoffKey,
  body: string,
): Promise<string> {
  safeSegment(manuscriptId);
  await ensureDirs();
  const path = inboxPath(manuscriptId, key);
  // Clean any stale outbox so a stale dropped file can't masquerade as fresh.
  await rm(outboxPath(manuscriptId, key), { force: true });
  await rm(errorPath(manuscriptId, key), { force: true });
  await rm(rawAttemptPath(manuscriptId, key, 1), { force: true });
  await rm(rawAttemptPath(manuscriptId, key, 2), { force: true });
  await writeFile(path, body, 'utf8');
  return path;
}

export { INBOX, OUTBOX };
