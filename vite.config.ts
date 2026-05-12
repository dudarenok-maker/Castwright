import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config — replaces the manual <script> tag ordering in index.html.
// Vite resolves ESM imports, transpiles JSX/TSX via SWC, serves HMR.
export default defineConfig({
  plugins: [react()],
  root: '.',
  server: { port: 5173, open: true },
  build:  { outDir: 'dist', sourcemap: true },
});
