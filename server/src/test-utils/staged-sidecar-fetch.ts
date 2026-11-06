/* PR #4007 pass 12, Y2 — the real sidecar writes a design's (or a mint's) `.pt`
   under the private staging key it was given, and a landing whose staged `.pt`
   is missing now fails (moveStaged). A suite whose fetch mock only answers the
   call wraps it with this, so a successful staged call leaves the `.pt` the
   sidecar would have written. A file the mock wrote itself is left as it is. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type FetchLike = (url: unknown, init?: { body?: unknown }) => unknown;

export function writesStagedPt(fetchMock: FetchLike): FetchLike {
  return async (url, init) => {
    const res = (await fetchMock(url, init)) as { ok?: boolean } | undefined;
    if (!res?.ok || !String(url).includes('/qwen/') || String(url).includes('evict')) return res;
    let voiceId: unknown;
    try {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      voiceId = body.variantVoiceId ?? body.voiceId;
    } catch {
      return res;
    }
    if (typeof voiceId !== 'string' || !voiceId.startsWith('qwen-staging-')) return res;
    const { qwenVoicePtPath } = await import('../workspace/paths.js');
    const pt = qwenVoicePtPath(voiceId);
    if (!existsSync(pt)) {
      mkdirSync(dirname(pt), { recursive: true });
      writeFileSync(pt, 'STAGED-BY-SIDECAR');
    }
    return res;
  };
}
