/* Runs the REAL parse-worker entry (which parses workerData), then leaves an
   unawaited rejection behind while that parse is still in flight. The main
   thread logs and survives such a rejection (crash-logging.ts), so the worker
   must too: the parse is expected to complete. Needs the tsx loader, which
   parseInWorker adds for a source-tree run. */
await import('../../parse-worker.ts');
Promise.reject(new Error('stray rejection nobody awaits'));
