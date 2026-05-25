/* In-browser mock of the workspace queue (`<workspace>/.queue.json`) for
 * VITE_USE_MOCKS mode (mock dev app + Playwright e2e).
 *
 * Plan 111 made the persisted queue the single source of truth for generation
 * — the dispatcher opens streams off queue entries, the `hasWork` override is
 * gone. So mock mode needs a working queue or generation never starts. The
 * real server lives in server/src/workspace/queue-io.ts + routes/queue.ts;
 * this mirrors just enough of its contract (enqueue / reorder / pause / cancel
 * / GET, contiguous `order`, dup-id 409, in_progress not cancellable) for the
 * frontend's queue-thunks to drive generation with no backend.
 *
 * State is module-level (per page / per Vite instance) so each Playwright test
 * gets a fresh queue. e2e specs seed it via `window.__mockQueue.seed(...)` (or
 * `window.__mockQueueInitial` before load); the seed hook is wired in
 * main.tsx behind the same DEV/e2e gate as `window.__store__`. */

import type { QueueEntry } from '../store/queue-slice';

interface QueueFile {
  entries: QueueEntry[];
  paused: boolean;
}

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function readInitial(): QueueFile {
  const g = globalThis as { __mockQueueInitial?: QueueEntry[]; __mockQueueInitialPaused?: boolean };
  const entries = Array.isArray(g.__mockQueueInitial)
    ? g.__mockQueueInitial.map((e, i) => ({ ...e, order: i }))
    : [];
  return { entries, paused: g.__mockQueueInitialPaused ?? false };
}

let state: QueueFile = readInitial();

/* Always rebuild `entries` as a fresh array of fresh objects. The snapshot we
   hand back is stored in Redux, which freezes it (Immer) — so we must never
   mutate the previous array in place (that throws "object is not extensible"),
   and never hand the live reference back without copying. */
function renumber(entries: QueueEntry[]): QueueEntry[] {
  return entries.map((e, i) => ({ ...e, order: i }));
}

function resp(body: unknown, status = 200): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  };
}

function snapshot(): MockResponse {
  /* Copy so Redux freezes the copy, never our live working array. */
  return resp({ entries: state.entries.map((e) => ({ ...e })), paused: state.paused });
}

interface EnqueueBody {
  entries?: Array<Pick<QueueEntry, 'id' | 'bookId' | 'chapterId' | 'scope'> & Partial<QueueEntry>>;
}

/** Serve a /api/queue request against the in-memory state. Returns a
    fetch-Response-like object (ok / status / json) so queue-thunks'
    `readSnapshot` consumes it unchanged. */
export function mockQueueRequest(
  path: string,
  init?: { method?: string; body?: string },
): MockResponse {
  const method = init?.method ?? 'GET';
  const rest = path.replace(/^.*\/api\/queue/, '').replace(/\?.*$/, '');

  if (rest === '' || rest === '/') return snapshot();

  if (rest === '/enqueue') {
    const incoming = (init?.body ? (JSON.parse(init.body) as EnqueueBody).entries : []) ?? [];
    const seen = new Set(state.entries.map((e) => e.id));
    for (const inp of incoming) {
      if (seen.has(inp.id))
        return resp({ error: `queue.enqueue: duplicate entry id "${inp.id}"` }, 409);
    }
    const fresh = incoming.map(
      (inp) =>
        ({
          ...inp,
          addedAt: inp.addedAt ?? new Date().toISOString(),
          status: 'queued',
          order: 0,
        }) as QueueEntry,
    );
    state.entries = renumber([...state.entries, ...fresh]);
    return snapshot();
  }

  if (rest === '/reorder') {
    const order = (init?.body ? (JSON.parse(init.body) as { order?: string[] }).order : []) ?? [];
    const inFlight = state.entries.find((e) => e.status === 'in_progress');
    const byId = new Map(
      state.entries.filter((e) => e.status !== 'in_progress').map((e) => [e.id, e] as const),
    );
    const reordered = order.map((id) => byId.get(id)).filter((e): e is QueueEntry => e != null);
    state.entries = renumber(inFlight ? [inFlight, ...reordered] : reordered);
    return snapshot();
  }

  if (rest === '/pause') {
    state.paused = init?.body
      ? Boolean((JSON.parse(init.body) as { paused?: boolean }).paused)
      : false;
    return snapshot();
  }

  /* `${entryId}/start` — status-only mark to in_progress, no reorder (multiple
     entries may be in_progress at once under queue-sole concurrency). */
  if (method === 'POST' && rest.endsWith('/start')) {
    const id = decodeURIComponent(rest.replace(/^\//, '').replace(/\/start$/, ''));
    state.entries = state.entries.map((e) => (e.id === id ? { ...e, status: 'in_progress' } : e));
    return snapshot();
  }

  /* `${entryId}/complete` — done-prune a finished entry regardless of status
     (it IS in_progress at completion). */
  if (method === 'POST' && rest.endsWith('/complete')) {
    const id = decodeURIComponent(rest.replace(/^\//, '').replace(/\/complete$/, ''));
    state.entries = renumber(state.entries.filter((e) => e.id !== id));
    return snapshot();
  }

  if (method === 'DELETE') {
    const id = decodeURIComponent(rest.replace(/^\//, ''));
    const target = state.entries.find((e) => e.id === id);
    if (target?.status === 'in_progress') {
      return resp(
        { error: `queue.cancel: entry "${id}" is in_progress; pause the queue first` },
        409,
      );
    }
    state.entries = renumber(state.entries.filter((e) => e.id !== id));
    return snapshot();
  }

  return resp({ error: `mock queue: no route for ${method} ${path}` }, 404);
}

/** e2e / dev seed hook — replace the queue contents. */
export function seedMockQueue(entries: QueueEntry[], paused = false): void {
  state = { entries: entries.map((e, i) => ({ ...e, order: i })), paused };
}

/** Reset to empty — unit tests + between e2e cases. */
export function resetMockQueue(): void {
  state = { entries: [], paused: false };
}
