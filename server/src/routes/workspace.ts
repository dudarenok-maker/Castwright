/* Workspace-scoped routes.

   GET  /api/workspace            — metadata (root, booksRoot, source). Lets
                                    the Books page header surface which folder
                                    the library is actually reading from.

   GET  /api/workspace/changelog  — paginated aggregated audit trail across
                                    every book. Fans out
                                    `.audiobook/change-log.json` per book,
                                    attaches bookId/bookTitle/author to each
                                    event, sorts newest-first, and serves
                                    one page plus a cursor for the next.

      Query params:
        limit  — page size (default 50, max 200). Capped so a noisy workspace
                 can't drown the browser the same way the old "return
                 everything" endpoint did.
        before — ISO timestamp cursor; only events strictly older than this
                 land in the page. Omit on the first request.

      The response always carries `totalCount` + `categoryCounts` computed
      over the FULL aggregated set (not just this page) so the workspace
      Activity pills can show honest totals while the user scrolls. */

import { Router } from 'express';
import { WORKSPACE_ROOT, BOOKS_ROOT } from '../workspace/paths.js';
import { listAllChangeLogs } from '../workspace/scan.js';

export const workspaceRouter = Router();

workspaceRouter.get('/', (_req, res) => {
  res.json({
    root: WORKSPACE_ROOT,
    booksRoot: BOOKS_ROOT,
    source: process.env.WORKSPACE_DIR ? 'env' : 'default',
  });
});

interface BookEventRecord {
  id?: unknown;
  at?: unknown;
  type?: unknown;
}

/* Mirrors the FILTER_MAP partition in src/views/change-log.tsx — kept in
   lockstep here so the server-side categoryCounts the workspace view trusts
   for its pill labels are computed the same way the client-side per-book
   pills are. */
const CATEGORY_MAP = {
  voice:      new Set(['voice_tune', 'voice_reuse', 'voice_lock', 'library_add']),
  generation: new Set(['regenerate', 'generation_run_complete', 'chapter_complete', 'chapter_failed', 'generation_started']),
  manuscript: new Set(['boundary_move', 'import', 'reparse']),
  cast:       new Set(['cast_confirm', 'analysis_complete']),
} as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

workspaceRouter.get('/changelog', async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit);
    const before = typeof req.query.before === 'string' ? Date.parse(req.query.before) : NaN;

    const per = await listAllChangeLogs();
    const tagged = per.flatMap(({ bookId, bookTitle, author, events }) =>
      events.map(e => ({
        ...(e as Record<string, unknown>),
        bookId,
        bookTitle,
        author,
      })),
    );
    tagged.sort((a, b) => sortKey(b as BookEventRecord) - sortKey(a as BookEventRecord));

    const totalCount = tagged.length;
    const categoryCounts = { voice: 0, generation: 0, manuscript: 0, cast: 0 };
    for (const e of tagged) {
      const t = (e as BookEventRecord).type;
      if (typeof t !== 'string') continue;
      if (CATEGORY_MAP.voice.has(t))      categoryCounts.voice      += 1;
      if (CATEGORY_MAP.generation.has(t)) categoryCounts.generation += 1;
      if (CATEGORY_MAP.manuscript.has(t)) categoryCounts.manuscript += 1;
      if (CATEGORY_MAP.cast.has(t))       categoryCounts.cast       += 1;
    }

    /* Cursor: page starts at the first event strictly older than `before`.
       Strict `<` (not `<=`) so a re-request with the same cursor doesn't
       re-serve the boundary event the client already has. */
    const startIdx = Number.isFinite(before)
      ? tagged.findIndex(e => sortKey(e as BookEventRecord) < before)
      : 0;
    const safeStart = startIdx < 0 ? tagged.length : startIdx;
    const page = tagged.slice(safeStart, safeStart + limit);

    /* Next cursor: last event of THIS page if there are more after it. The
       client passes this value back as `before` to fetch page N+1. */
    const last = page[page.length - 1] as BookEventRecord | undefined;
    const hasMore = safeStart + page.length < tagged.length;
    const nextCursor = hasMore && last && typeof last.at === 'string' ? last.at : null;

    res.json({ events: page, nextCursor, totalCount, categoryCounts });
  } catch (err) {
    console.error('[workspace/changelog] failed', err);
    res.status(500).json({ error: 'Workspace changelog aggregation failed.' });
  }
});

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/* Prefer ISO `at` for sort order; fall back to the numeric `id` (now.getTime()
   at write time) so demo-fixture entries without `at` still order sensibly. */
function sortKey(e: BookEventRecord): number {
  if (typeof e.at === 'string') {
    const t = Date.parse(e.at);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof e.id === 'number') return e.id;
  return 0;
}
