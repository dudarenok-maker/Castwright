import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import mkcert from 'vite-plugin-mkcert';

// Vite config — replaces the manual <script> tag ordering in index.html.
// Vite resolves ESM imports, transpiles JSX/TSX via SWC, serves HMR.
//
// VITE_PORT / VITE_API_PORT can override the dev-server port and the proxy
// target so multiple worktrees can run `npm run dev` in parallel without
// fighting over :5173. `scripts/wt-new.mjs` writes these into per-worktree
// .env.local files. Stock ports apply when both are unset.
//
// VITE_HTTPS=1 (set by `npm run dev:lan`) flips Vite into HTTPS mode via
// vite-plugin-mkcert, which auto-installs the mkcert binary on first run
// and generates a per-user local CA + per-host certs. Combined with the
// CLI flag `--host 0.0.0.0` (also set by dev:lan), the dev server becomes
// reachable from any device on the LAN at https://<lan-ip>:5173 with no
// browser warning once the device has trusted the mkcert root CA (see
// `npm run install:cert-mobile` for the per-device install flow). Default
// dev path (`npm run dev`) stays HTTP-on-loopback and is unaffected.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const vitePort = Number(env.VITE_PORT ?? 5173);
  const apiPort = Number(env.VITE_API_PORT ?? env.PORT ?? 8080);
  const useHttps = env.VITE_HTTPS === '1' || process.env.VITE_HTTPS === '1';
  const plugins: PluginOption[] = [react()];
  if (useHttps) plugins.push(mkcert());
  return {
    plugins,
    root: '.',
    server: {
      // Bind to IPv4 loopback by default. Vite 5 defaults to host:'localhost',
      // and on Node 18+ that resolves to ::1 (IPv6) only — Chrome on Windows
      // then burns its Happy-Eyeballs IPv4 timeout before falling back, so
      // the first paint stalls for several seconds. Pinning to 127.0.0.1
      // matches the Node + TTS sidecars (both loopback-only) and removes
      // the stall. `npm run dev:lan` overrides via CLI `--host 0.0.0.0`
      // for LAN access from mobile / tablet devices.
      host: '127.0.0.1',
      port: vitePort,
      open: !useHttps, // skip auto-open in LAN mode — user is on a mobile device
      proxy: {
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
        '/audio': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: true },
  };
});
