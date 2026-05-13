/* Workspace-scoped routes.

   GET  /api/workspace            — metadata (root, booksRoot, source). Lets
                                    the Books page header surface which folder
                                    the library is actually reading from.

   GET  /api/workspace/changelog  — aggregated audit trail across every book.
                                    Fans out `.audiobook/change-log.json` per
                                    book, attaches bookId/bookTitle/author to
                                    each event, sorts newest-first. */

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
}

workspaceRouter.get('/changelog', async (_req, res) => {
  try {
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
    res.json({ events: tagged });
  } catch (err) {
    console.error('[workspace/changelog] failed', err);
    res.status(500).json({ error: 'Workspace changelog aggregation failed.' });
  }
});

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
