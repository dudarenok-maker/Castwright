/* Shared dynamic-import thunks for lazy route chunks.
 *
 * Each thunk is exported so BOTH the React.lazy definition (routes/index.tsx)
 * and the proactive prefetch (components/layout.tsx) reference the EXACT same
 * import specifier. Vite code-splits a given dynamic specifier into one chunk,
 * so warming it via the prefetch resolves the very module the route lazy
 * awaits — the view then paints from cache instead of showing the route
 * Suspense fallback while a cold chunk downloads (which reads as a stall).
 *
 * Lives in its own module to avoid a circular import: routes/index.tsx imports
 * Layout, and layout.tsx imports this — a shared specifier here keeps that edge
 * acyclic (this module imports nothing from either).
 *
 * - GenerationView: warmed once the user is inside a book / a run is live;
 *   worst case is a cold download while the main thread is busy mid-generation.
 * - UploadView: warmed while the user sits on the library landing page (the
 *   page hosting the "New project" entry). Its chunk graph is heavy
 *   (upload.tsx + manuscript-diff.tsx), so the first cold transform/download
 *   otherwise stretches the "#/new" route Suspense fallback into a multi-second
 *   "Loading…". */
export const importGenerationView = () => import('../views/generation');
export const importUploadView = () => import('../views/upload');
