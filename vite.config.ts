import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config — replaces the manual <script> tag ordering in index.html.
// Vite resolves ESM imports, transpiles JSX/TSX via SWC, serves HMR.
export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    // Bind to IPv4 loopback. Vite 5 defaults to host:'localhost', and on
    // Node 18+ that resolves to ::1 (IPv6) only — Chrome on Windows then
    // burns its Happy-Eyeballs IPv4 timeout before falling back, so the
    // first paint stalls for several seconds. Pinning to 127.0.0.1 matches
    // the Node + TTS sidecars (both loopback-only) and removes the stall.
    host: '127.0.0.1',
    port: 5173,
    open: true,
    proxy: {
      '/api':   { target: 'http://localhost:8080', changeOrigin: true },
      '/audio': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build:  { outDir: 'dist', sourcemap: true },
});
