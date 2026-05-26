/* Shared dynamic-import thunk for the lazy GenerationView chunk.
 *
 * Exported so BOTH the React.lazy definition (routes/index.tsx) and the
 * proactive prefetch (components/layout.tsx) reference the EXACT same import
 * specifier. Vite code-splits a given dynamic specifier into one chunk, so
 * warming it via the prefetch resolves the very module the route lazy awaits —
 * the Generate view then paints from cache instead of showing the route
 * Suspense fallback while a cold chunk downloads (worst right when the main
 * thread is busy mid-generation, which is exactly when the user opens it).
 *
 * Lives in its own module to avoid a circular import: routes/index.tsx imports
 * Layout, and layout.tsx imports this — a shared specifier here keeps that edge
 * acyclic (this module imports nothing from either). */
export const importGenerationView = () => import('../views/generation');
