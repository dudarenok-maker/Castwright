/* POST /api/books/:bookId/share — mint a shareable slugged URL for a book.
   GET  /share/:slug                — proxy the book's M4B off disk.

   Plan 67 — closes the third "Or download a file" tile on the Listen view.
   The POST returns a `{ slug, url, expiresAt? }` triple; the slug is 12
   chars from a Crockford-style base32 alphabet (no vowels, no easily-
   confused 0/O 1/I/L glyphs), giving ~60 bits of entropy. This is a
   casual share link — paste-into-DM convenience, not a security token.

   Slug → bookId mappings persist to `<workspace>/.audiobook/share-links.json`
   so a server restart doesn't break already-shared URLs. The file holds the
   full table (writes are full-file atomic via `writeJsonAtomic`); on read,
   missing or malformed file resets to an empty table without throwing.

   GET resolution path: load the slug table → look up the bookId → find the
   most-recent successful M4B export under the book's exports dir → stream
   that file with `Content-Type: audio/mp4`. If no M4B export exists yet,
   we 409 with `error: 'no_m4b_ready'` so the share-link UI can surface a
   "Build an M4B first" message rather than the 404 a casual reader would
   read as "broken link." */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { customAlphabet } from 'nanoid';
import { findBookByBookId } from '../workspace/scan.js';
import { WORKSPACE_ROOT, dotAudiobook } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';

/* Crockford-style base32: 0-9 + A-Z minus I, L, O, U.  No vowels, no easily-
   confused letters; uppercase only (the URL surface case-folds anyway).
   12 chars * log2(32) = 60 bits of entropy — overkill for a casual share
   link but cheap. */
const SLUG_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SLUG_LEN = 12;
const newSlug = customAlphabet(SLUG_ALPHABET, SLUG_LEN);
/** Strict shape — the GET handler refuses anything that doesn't match so
    a casual hit on `/share/foo` returns 404 instead of trawling the table. */
export const SLUG_RE = new RegExp(`^[${SLUG_ALPHABET}]{${SLUG_LEN}}$`);

interface ShareLinksJson {
  /** slug -> bookId */
  links: Record<string, { bookId: string; createdAt: string }>;
}

function shareLinksPath(): string {
  return join(WORKSPACE_ROOT, '.audiobook', 'share-links.json');
}

async function readShareLinks(): Promise<ShareLinksJson> {
  try {
    const raw = await readJson<ShareLinksJson>(shareLinksPath());
    if (raw && raw.links && typeof raw.links === 'object') return raw;
  } catch {
    /* malformed file — fall through to empty table; the next write
       overwrites cleanly. */
  }
  return { links: {} };
}

async function writeShareLinks(value: ShareLinksJson): Promise<void> {
  await mkdir(join(WORKSPACE_ROOT, '.audiobook'), { recursive: true });
  await writeJsonAtomic(shareLinksPath(), value);
}

/* Mirrors the BookExportJob shape we read off-disk; we only need a few
   fields so we keep this loose rather than importing the export route's
   internal interface. */
interface ExportManifestForShare {
  id: string;
  bookId: string;
  format: 'mp3-zip' | 'm4b' | 'mp3-folder';
  status: 'queued' | 'in_progress' | 'done' | 'failed' | 'cancelled';
  filename: string;
  completedAt?: string | null;
  createdAt: string;
}

/** Walk a book's exports dir and return the path to the most-recent
    successful M4B file. Returns null when nothing is ready. */
async function findLatestM4b(bookDir: string): Promise<string | null> {
  const exportsRoot = join(dotAudiobook(bookDir), 'exports');
  if (!existsSync(exportsRoot)) return null;
  let entries: string[] = [];
  try {
    entries = await readdir(exportsRoot);
  } catch {
    return null;
  }
  let best: { path: string; ts: string } | null = null;
  for (const name of entries) {
    const manifestFile = join(exportsRoot, name, 'manifest.json');
    if (!existsSync(manifestFile)) continue;
    try {
      const raw = await readFile(manifestFile, 'utf8');
      const job = JSON.parse(raw) as ExportManifestForShare;
      if (job.format !== 'm4b' || job.status !== 'done') continue;
      const artifact = join(exportsRoot, name, job.filename);
      if (!existsSync(artifact)) continue;
      const ts = job.completedAt ?? job.createdAt;
      if (!best || ts > best.ts) {
        best = { path: artifact, ts };
      }
    } catch {
      /* Corrupt manifest — skip. */
    }
  }
  return best?.path ?? null;
}

export const shareRouter = Router();

shareRouter.post('/:bookId/share', async (req: Request, res: Response) => {
  const located = await findBookByBookId(req.params.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });

  const table = await readShareLinks();

  /* Reuse an existing slug for this book if one is already on file —
     keeps the share URL stable across re-mints so a previously-pasted
     link doesn't silently break when the user clicks the tile again. */
  const existing = Object.entries(table.links).find(
    ([, v]) => v.bookId === located.state.bookId,
  );
  let slug: string;
  if (existing) {
    slug = existing[0];
  } else {
    /* Guard against the extremely unlikely collision — re-roll until
       the slug is fresh. With 60 bits of entropy this is theatre, but
       it's cheap and the safety guarantee is nice. */
    do {
      slug = newSlug();
    } while (table.links[slug]);
    table.links[slug] = {
      bookId: located.state.bookId,
      createdAt: new Date().toISOString(),
    };
    await writeShareLinks(table);
  }

  /* Absolute URL so the modal can render a copyable string without
     having to compose `window.location.origin` on the frontend. The
     reverse proxy + host headers handle the protocol/host. */
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const url = `${proto}://${host}/share/${slug}`;

  return res.status(201).json({ slug, url });
});

/* GET /share/:slug — the public-facing proxy. Mounted at the app root
   (not under /api) so the URL the user pastes into a chat reads more
   like a share link than an API call. */
export const sharePublicRouter = Router();

sharePublicRouter.get('/share/:slug', async (req: Request, res: Response) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) return res.status(404).json({ error: 'slug_not_found' });

  const table = await readShareLinks();
  const entry = table.links[slug];
  if (!entry) return res.status(404).json({ error: 'slug_not_found' });

  const located = await findBookByBookId(entry.bookId);
  if (!located) return res.status(404).json({ error: 'book_not_found' });

  const m4bPath = await findLatestM4b(located.bookDir);
  if (!m4bPath) {
    return res.status(409).json({
      error: 'no_m4b_ready',
      message:
        'No M4B export is built for this book yet. Open the book in the app and build the M4B export first; the share link will then resolve.',
    });
  }

  res.sendFile(
    m4bPath,
    {
      headers: {
        'Content-Type': 'audio/mp4',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(
          `${located.state.title}.m4b`,
        )}"`,
        'Cache-Control': 'no-cache',
      },
      /* The M4B lives under the book's `.audiobook/exports/` dir. Express 5's
         send defaults dotfiles:'ignore', which 404s any path with a
         dot-segment (Express 4's res.sendFile served it) — allow it. */
      dotfiles: 'allow',
    },
    (err) => {
      if (err && !res.headersSent) res.status(500).end();
    },
  );
});

/** Test-only: reset the share-links table on disk so beforeEach can
    isolate cases. */
export async function _resetShareLinks(): Promise<void> {
  await writeShareLinks({ links: {} });
}
