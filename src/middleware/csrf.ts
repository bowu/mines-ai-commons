import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function isAllowedOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  return config.corsAllowedOrigins.some(
    (candidate) => candidate === normalized,
  );
}

export function csrfCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  if (config.nodeEnv !== "production") {
    return next();
  }

  const origin = req.header("origin");
  if (!origin) {
    return next(new AppError("Missing Origin header", 403, "CSRF_BLOCKED"));
  }

  if (!isAllowedOrigin(origin)) {
    return next(new AppError("Origin not allowed", 403, "CSRF_BLOCKED"));
  }

  next();
}
