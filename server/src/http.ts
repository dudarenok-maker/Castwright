/* Express 5 typed re-exports (srv-24).

   @types/express 5 widened `req.params` values to `string | string[]` because
   path-to-regexp v8 can bind a wildcard / repeated segment to an array. Every
   route in this server uses only single `:segment` params (no `*` / repeats),
   so we narrow params back to `Record<string, string>` — matching the Express 4
   `ParamsDictionary` shape — and import Request from here instead of 'express'
   in route files. This keeps the 100+ `req.params.x` reads typed as plain
   strings without a per-site cast. */
import type { Request as ExpressRequest } from 'express';

export type Request = ExpressRequest<Record<string, string>>;
export type { Response, NextFunction } from 'express';
