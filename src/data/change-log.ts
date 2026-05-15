/* The change-log slice starts empty — the workspace Activity view and each
   per-book Log tab are hydrated from disk (`.audiobook/change-log.json`) or
   from server fan-out (`GET /api/workspace/changelog`). Seeding with demo
   fixtures earlier turned out to be more confusing than helpful: it polluted
   the workspace view on first run with rows that didn't reflect anything
   the user had actually done, and it made the empty/zero-count code paths
   hard to notice (the seeded categories always had hits). */

import type { ChangeLogEvent } from '../lib/types';

export const CHANGE_LOG_EVENTS: ChangeLogEvent[] = [];
