import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/** Validates and replaces req.body with the parsed (stripped, coerced) value. */
export function validate(schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };
}
