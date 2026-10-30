import type { Request, Response, NextFunction } from 'express';
import { z, ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to perform this action') => new HttpError(403, msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const conflict = (msg: string) => new HttpError(409, msg);

export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, 'Please correct the highlighted fields', fieldErrors(r.error));
  }
  return r.data;
}

function fieldErrors(err: ZodError) {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, fields: err.details });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File is too large' });
    return;
  }
  if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: 'A record with these details already exists' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

export const id = z.coerce.number().int().positive();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const bool = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v ? 1 : 0));

export function pageParams(q: any) {
  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
