import { defineConfig, loadEnv, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import mkcert from 'vite-plugin-mkcert';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Plan 124 — build-version footer. Capture version + git provenance ONCE here
// (this callback runs at vite start / per `vite build`) and inject them as
// compile-time constants via `define` below, read by src/lib/build-info.ts.
// Each git call is isolated in its own try/catch so a build from a tarball
// without a `.git` dir degrades to sentinels ('unknown' / 'local') instead of
// throwing. NOTE: on the dev server these are frozen at vite-start — commit
// while `npm run dev` is running and the footer keeps the old SHA until you
// restart Vite (HMR does not re-run this config). `vite build` is always fresh.
function gitOutput(cmd: string): string | null {
  try {
    return execSync(cmd, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

function buildInfoConstants() {
  const version = (createRequire(import.meta.url)('./package.json') as { version: string }).version;
  const gitSha = gitOutput('git rev-parse --short HEAD') ?? 'unknown';
  const gitBranch = gitOutput('git rev-parse --abbrev-ref HEAD') ?? 'local';
  const status = gitOutput('git status --porcelain');
  const gitDirty = status === null ? false : status.length > 0;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const buildTime = `${hh}:${mm}`;
  return {
    __APP_VERSION__: JSON.stringify(version),
    __GIT_SHA__: JSON.stringify(gitSha),
    __GIT_BRANCH__: JSON.stringify(gitBranch),
    __GIT_DIRTY__: JSON.stringify(gitDirty), // boolean literal true/false
    __BUILD_TIME__: JSON.stringify(buildTime),
  };
}

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
    // Plan 124 — compile-time build-version constants (see buildInfoConstants).
    define: buildInfoConstants(),
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
    build: {
      outDir: 'dist',
      sourcemap: true,
      /* Plan 89 C5 — route code-split via React.lazy in src/routes/index.tsx
         already produces per-view chunks. The manualChunks groups below
         pull big shared vendor libs into their own chunks so lazy view
         chunks stay small and a warm browser cache can keep vendor code
         pinned across navigations. Touching this list? Run
         `npm run build` and inspect `dist/assets/` — the listen / cast /
         manuscript bundles should NOT pull in the manuscript editor's
         transitive deps when they themselves don't import it. */
      rollupOptions: {
        output: {
          /* Plan 89 C5 — collapse the react runtime + everything that
             transitively depends on it into a single `react` chunk so the
             vendor↔react cross-references can't form a circular chunk
             graph. The smaller per-view bundles depend on this chunk
             stably across navigations. `vendor` carries the long tail
             of utility libs that don't reach into the react runtime. */
          manualChunks: (id) => {
            if (!id.includes('node_modules')) return undefined;
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react-is') ||
              id.includes('node_modules/react-router') ||
              id.includes('node_modules/react-redux') ||
              id.includes('node_modules/scheduler') ||
              id.includes('node_modules/use-sync-external-store') ||
              id.includes('node_modules/@reduxjs/toolkit') ||
              id.includes('node_modules/redux/') ||
              id.includes('node_modules/redux-thunk') ||
              id.includes('node_modules/redux-persist') ||
              id.includes('node_modules/immer/') ||
              id.includes('node_modules/reselect') ||
              id.includes('node_modules/hoist-non-react-statics')
            ) {
              return 'react';
            }
            return 'vendor';
          },
        },
      },
    },
  };
});
