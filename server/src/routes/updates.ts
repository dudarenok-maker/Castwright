/* GET /api/updates/latest — best-effort "is a newer release available?" check.

   Self-hosted apps upgrade by applying a release .zip (see upgrade.ts); there's
   no auto-update feed. This route adds a *check* so the Account → Application
   updates card can say "you're up to date" vs "update available" instead of
   always offering Apply.

   FAIL-OPEN by design: the repo may be private (or the box offline / behind a
   proxy), so any failure to reach GitHub Releases resolves to
   `{ reachable: false }` — NOT an error. The card then degrades to showing the
   running version + manual Apply, exactly as before. Never throws to the client.

   Local-ops only (like sidecar/ollama/models routes) — stays out of openapi.yaml. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getAppVersion } from '../app-version.js';

export const updatesRouter = Router();

/** owner/repo to query. Overridable for forks / private mirrors. */
function repoSlug(): string {
  return process.env.UPDATE_CHECK_REPO?.trim() || 'dudarenok-maker/Castwright';
}

const CHECK_TIMEOUT_MS = 4000;
/* GitHub's unauthenticated API allows 60 req/hr/IP; cache so repeated Account
   visits don't burn it. 1h is plenty for a manual-upgrade product. */
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface UpdateStatus {
  /** False when the release source couldn't be reached (private repo, offline,
      rate-limited, …). The client treats this as "no info" and shows the
      running version only — never an error. */
  reachable: boolean;
  /** The running app version (always present — read locally). */
  currentVersion: string;
  /** Parsed latest release version, or null when unreachable/unparseable. */
  latestVersion: string | null;
  /** True only when reachable AND latestVersion is strictly newer than current. */
  updateAvailable: boolean;
  /** Release page URL when reachable, else null. */
  url: string | null;
}

/** Extract a semver-ish "X.Y.Z" from a release tag. Handles 'v1.7.0',
    'castwright-v1.7.0', 'castwright-1.7.0', and a bare '1.7.0'. Returns null
    when no major.minor.patch can be found. */
export function parseVersionFromTag(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const m = tag.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Compare two "X.Y.Z" strings numerically. Returns 1 if a>b, -1 if a<b, 0 if
    equal. A version that can't be parsed sorts as 0.0.0 (oldest), so a garbage
    "latest" can never falsely claim to be newer than a real current version. */
export function compareSemver(a: string, b: string): number {
  const parts = (v: string): [number, number, number] => {
    const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  };
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** Pure assembly of the response from the current version + the (already
    fetched, fail-safe) release lookup. Unit-tested without network. */
export function buildUpdateStatus(
  currentVersion: string,
  fetched: { ok: true; tag: string; url: string } | { ok: false },
): UpdateStatus {
  if (!fetched.ok) {
    return { reachable: false, currentVersion, latestVersion: null, updateAvailable: false, url: null };
  }
  const latestVersion = parseVersionFromTag(fetched.tag);
  const updateAvailable = latestVersion != null && compareSemver(latestVersion, currentVersion) > 0;
  return { reachable: true, currentVersion, latestVersion, updateAvailable, url: fetched.url };
}

/** Fetch the latest release tag from GitHub. Never throws — returns
    `{ ok: false }` on timeout, non-2xx (incl. 404 for a private repo without a
    token), or malformed body. An optional GITHUB_TOKEN lifts the rate limit and
    grants access to a private repo's releases. */
async function fetchLatestRelease(): Promise<{ ok: true; tag: string; url: string } | { ok: false }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'castwright-update-check',
    };
    const token = process.env.GITHUB_TOKEN?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`https://api.github.com/repos/${repoSlug()}/releases/latest`, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { tag_name?: string; html_url?: string };
    if (typeof body.tag_name !== 'string') return { ok: false };
    return { ok: true, tag: body.tag_name, url: typeof body.html_url === 'string' ? body.html_url : '' };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

let cache: { at: number; status: UpdateStatus } | null = null;

updatesRouter.get('/latest', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    res.json(cache.status);
    return;
  }
  const status = buildUpdateStatus(getAppVersion(), await fetchLatestRelease());
  /* Only cache a reachable result — a transient failure shouldn't pin
     "unreachable" for an hour; the next visit retries. */
  if (status.reachable) cache = { at: now, status };
  res.json(status);
});

/** Test seam — reset the module-level cache between cases. */
export function __resetUpdateCacheForTests(): void {
  cache = null;
}
