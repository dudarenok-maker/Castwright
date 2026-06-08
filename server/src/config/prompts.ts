/* Prompt-fork loader for the four analyzer skill prompts.

   Shipped prompts live as .md files under skills/ in the repo (the `default`
   field of each prompt knob gives the repo-relative path). A user "edit" forks
   the prompt into ~/.castwright/prompts/<id>.md and writes the absolute fork
   path as a configOverride so the server picks it up on the NEXT analysis
   call — no restart needed (apply:'live').

   The override pointer is stored in configOverrides keyed by the prompt knob
   key (e.g. 'prompt.castDetection'), value = absolute fork path. Revert drops
   the override and optionally deletes the fork file. */

import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { allKnobs, getKnob } from './registry.js';
import {
  readConfigOverrides,
  writeConfigOverride,
  clearConfigOverride,
} from '../workspace/user-settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo (worktree) root — three levels up from server/src/config/. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** The four prompt knob ids. Derived from the registry so there is a single
    source of truth; any future isPrompt knob added to registry.ts is
    automatically included here without a code change. */
export const PROMPT_IDS: ReadonlySet<string> = new Set(
  allKnobs()
    .filter((k) => k.isPrompt)
    .map((k) => k.key),
);

/** Directory where user-forked prompt files live.
    Overridable via CASTWRIGHT_PROMPTS_DIR (used by tests for isolation). */
function resolvePromptDir(): string {
  const override = process.env.CASTWRIGHT_PROMPTS_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.castwright', 'prompts');
}

function assertValidId(id: string): void {
  if (!PROMPT_IDS.has(id)) {
    throw new Error(`Unknown prompt id "${id}". Valid ids: ${[...PROMPT_IDS].join(', ')}`);
  }
}

/** Resolve the repo-relative shipped path for a prompt id to an absolute path. */
function shippedPath(id: string): string {
  const knob = getKnob(id);
  if (!knob) throw new Error(`No registry entry for prompt id "${id}"`);
  // knob.default is a repo-relative path like 'skills/audiobook-sentence-attribution.md'
  return resolve(REPO_ROOT, knob.default as string);
}

export interface PromptState {
  id: string;
  text: string;
  isForked: boolean;
  defaultText: string;
}

/** Read a prompt, resolving the fork if one is set and its file exists.
    Falls back transparently to the shipped default if the fork file is missing
    (e.g. after a manual deletion). */
export async function readPrompt(id: string): Promise<PromptState> {
  assertValidId(id);

  const defaultText = await readFile(shippedPath(id), 'utf8');

  const overrides = readConfigOverrides();
  const forkPath = overrides[id];
  if (typeof forkPath === 'string' && forkPath.length > 0 && existsSync(forkPath)) {
    const text = await readFile(forkPath, 'utf8');
    return { id, text, isForked: true, defaultText };
  }

  return { id, text: defaultText, isForked: false, defaultText };
}

/** Write a forked prompt file and record its path in configOverrides.
    The fork file lives at <promptDir>/<id>.md. */
export async function writeForkedPrompt(id: string, text: string): Promise<void> {
  assertValidId(id);
  const dir = resolvePromptDir();
  await mkdir(dir, { recursive: true });
  const forkPath = join(dir, `${id}.md`);
  await writeFile(forkPath, text, 'utf8');
  await writeConfigOverride(id, forkPath);
}

/** Reset a prompt to the shipped default: clear the configOverride and delete
    the fork file if it exists. */
export async function resetPrompt(id: string): Promise<void> {
  assertValidId(id);
  // Clear the override first so a concurrent readPrompt falls back to default.
  await clearConfigOverride(id);
  // Best-effort delete of the fork file; ENOENT is fine.
  const dir = resolvePromptDir();
  const forkPath = join(dir, `${id}.md`);
  try {
    await unlink(forkPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
