import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config — replaces the manual <script> tag ordering in index.html.
// Vite resolves ESM imports, transpiles JSX/TSX via SWC, serves HMR.
//
// VITE_PORT / VITE_API_PORT can override the dev-server port and the proxy
// target so multiple worktrees can run `npm run dev` in parallel without
// fighting over :5173. `scripts/wt-new.mjs` writes these into per-worktree
// .env.local files. Stock ports apply when both are unset.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const vitePort = Number(env.VITE_PORT ?? 5173);
  const apiPort = Number(env.VITE_API_PORT ?? env.PORT ?? 8080);
  return {
    plugins: [react()],
    root: '.',
    server: {
      // Bind to IPv4 loopback. Vite 5 defaults to host:'localhost', and on
      // Node 18+ that resolves to ::1 (IPv6) only — Chrome on Windows then
      // burns its Happy-Eyeballs IPv4 timeout before falling back, so the
      // first paint stalls for several seconds. Pinning to 127.0.0.1 matches
      // the Node + TTS sidecars (both loopback-only) and removes the stall.
      host: '127.0.0.1',
      port: vitePort,
      open: true,
      proxy: {
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
        '/audio': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
