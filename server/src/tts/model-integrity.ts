/* ops-7 (#430) — lightweight on-disk integrity reflection for the Model
   Manager inventory. The CRYPTOGRAPHIC gate runs at INSTALL time (install
   scripts SHA256-verify each download and refuse on mismatch); re-hashing a
   325 MB model on every 30 s inventory poll would be wasteful, so the inventory
   badge does a cheap SIZE comparison against the pinned manifest instead —
   enough to flag a truncated/corrupted/tampered file at a glance. */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { kokoroWeightPaths } from './model-paths.js';

export type IntegrityVerdict = 'verified' | 'mismatch' | undefined;

interface HashEntry {
  sha256?: string | null;
  sizeBytes?: number;
}

function loadManifest(repoRoot: string): { kokoro?: Record<string, HashEntry> } | null {
  const path = join(repoRoot, 'server', 'tts-sidecar', 'scripts', 'model-hashes.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Size-check the on-disk Kokoro weights against the pinned manifest. Returns
    `undefined` (no badge) when the manifest is missing/unpinned or a weight file
    is absent; 'mismatch' when any present file's size differs from its pin;
    'verified' when both present files match. */
export function kokoroIntegrity(repoRoot: string): IntegrityVerdict {
  const manifest = loadManifest(repoRoot);
  const pins = manifest?.kokoro;
  if (!pins) return undefined;

  const [onnxPath, binPath] = kokoroWeightPaths(repoRoot);
  const byName: Record<string, string> = {
    'kokoro-v1.0.onnx': onnxPath,
    'voices-v1.0.bin': binPath,
  };

  let sawOne = false;
  for (const [name, entry] of Object.entries(pins)) {
    const filePath = byName[name];
    if (!filePath || !existsSync(filePath)) return undefined; // not fully installed
    if (typeof entry.sizeBytes !== 'number') continue; // nothing pinned to compare
    sawOne = true;
    try {
      if (statSync(filePath).size !== entry.sizeBytes) return 'mismatch';
    } catch {
      return undefined;
    }
  }
  return sawOne ? 'verified' : undefined;
}
