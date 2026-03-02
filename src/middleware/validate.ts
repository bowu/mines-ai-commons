import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny } from "zod";
import { ZodError } from "zod";
import { ValidationError } from "../lib/errors.js";

interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        const parsedQuery = schemas.query.parse(req.query) as Record<
          string,
          unknown
        >;
        const queryRef = req.query as Record<string, unknown>;
        for (const key of Object.keys(queryRef)) {
          delete queryRef[key];
        }
        Object.assign(queryRef, parsedQuery);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params) as any;
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(new ValidationError("Invalid request", error.flatten()));
        return;
      }
      next(error);
    }
  };
}
