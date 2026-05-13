/* Side-effect-only module: load server/.env into process.env before any
   other module in the graph has a chance to read it.

   This file exists because ESM `import` declarations are HOISTED above the
   importing module's body — so a top-of-file `process.loadEnvFile('.env')`
   in index.ts actually runs AFTER every imported module has already
   evaluated. That means modules like workspace/paths.ts capture
   `process.env.WORKSPACE_DIR` while it's still undefined, then export a
   stale constant.

   Placing the call inside its own module and importing it FIRST in
   index.ts puts the env load at the correct point in the dependency
   evaluation order: ESM evaluates this module's body (the loadEnvFile
   side-effect) before any later import statement is reached. Subsequent
   imports then read the freshly populated process.env. */

try {
  process.loadEnvFile('.env');
} catch {
  // Missing .env is fine — shell env still applies.
  console.info('[server] no .env file; using process env');
}
