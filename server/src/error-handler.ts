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
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  console.error('[error-handler] unhandled route error:', err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: 'Internal server error.' });
}
