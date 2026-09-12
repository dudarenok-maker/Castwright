/* Connection-level failure codes for the two analysis SSE readers in
   src/lib/api.ts (`realAnalyseManuscript`, `realRunAnalysisForChapters`).
   Neither is an analyzer verdict — the server never emits them; they
   describe what happened to THIS reader's connection. Three consumers
   classify on them, which is why they live in a leaf module rather than
   in api.ts: the stream middleware (src/store/analysis-stream-middleware.ts)
   picks transient vs terminal, and the analysis slice
   (src/store/analysis-slice.ts) lets a live tick lift a halt that carries
   `ANALYSIS_STREAM_FAILED` — a reducer must not import api.ts.

   - `stream_failed` — the POST answered non-2xx / no body, or the body
     read threw. Terminal for the connection AND a real signal about the
     server.
   - `stream_no_result` — the response was a clean 200 that ended without
     a `result` frame. NOT a failure signal: the subset route ends this
     way by design when other chapters still need retry
     (server/src/routes/analysis.ts — the three `endJob(job)` exits with
     no final event), and on the main route every job exit broadcasts its
     final frame to every subscriber, so a result-less end there means
     only that this one socket closed. */
export const ANALYSIS_STREAM_FAILED = 'stream_failed';
export const ANALYSIS_STREAM_NO_RESULT = 'stream_no_result';
