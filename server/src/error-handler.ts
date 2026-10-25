import type { Request, Response, NextFunction } from 'express';

/* Express-5-native global error handler (srv-24).

   Express 5 forwards a rejected promise from an async route handler into the
   framework's error pipeline; Express 4 silently swallowed it (the request
   would hang). Every route in this server already wraps its body in try/catch
   and returns its own response, so this middleware is a defense-in-depth
   backstop: if some future handler throws or rejects without catching, this
   turns it into a clean `500 { error }` JSON body instead of an unhandled
   rejection + Express's default HTML error page.

   Register it LAST, after every route — Express identifies an error handler by
   its four-argument signature. If the response already started streaming (SSE
   generation routes), delegate back to Express's default handler, which closes
   the socket rather than corrupting an in-flight response body. */
/* #3793 — body-parser / raw-body client errors are http-errors with
   `expose: true`, a 4xx `status`, and a `type` naming the class. Answer them
   with their own status and a FIXED sentence, never `err.message`: body-parser
   messages can echo header values (the charset name, the content-encoding).

   Gate = expose + 4xx + a KNOWN `type`, so a 4xx some other library or route
   threw with `expose: true` stays a 500 exactly as before. A failed gzip/deflate
   decode is the one class with no `type` — body-parser re-wraps the raw zlib
   error with status 400 and it keeps zlib's `code` (`Z_DATA_ERROR`,
   `Z_BUF_ERROR`) — so that is matched by `code` instead. */
const BODY_PARSER_CLIENT_ERRORS: Record<string, string> = {
  'entity.parse.failed': 'Malformed JSON request body.',
  'entity.too.large': 'Request body too large.',
  'charset.unsupported': 'Unsupported charset.',
  // Deliberately not app.ts's guard sentence ('Unsupported Content-Encoding.'):
  // app.content-encoding.test.ts tells the two refusals apart by it.
  'encoding.unsupported': 'Unsupported request encoding.',
  'request.aborted': 'Request aborted.',
  'request.size.invalid': 'Request body size did not match Content-Length.',
};
const BODY_DECODE_FAILED = 'Request body could not be decoded.';

function bodyParserClientError(err: unknown): { status: number; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { expose?: unknown; status?: unknown; type?: unknown; code?: unknown };
  if (e.expose !== true) return null;
  if (!Number.isInteger(e.status) || (e.status as number) < 400 || (e.status as number) > 499) {
    return null;
  }
  const status = e.status as number;
  if (typeof e.type === 'string' && Object.hasOwn(BODY_PARSER_CLIENT_ERRORS, e.type)) {
    return { status, message: BODY_PARSER_CLIENT_ERRORS[e.type] };
  }
  if (typeof e.code === 'string' && e.code.startsWith('Z_')) {
    return { status, message: BODY_DECODE_FAILED };
  }
  return null;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const clientErr = bodyParserClientError(err);
  if (clientErr) {
    console.warn(`[error-handler] rejected request body (${clientErr.status}): ${clientErr.message}`);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(clientErr.status).json({ error: clientErr.message });
    return;
  }
  console.error('[error-handler] unhandled route error:', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Internal server error.' });
}
