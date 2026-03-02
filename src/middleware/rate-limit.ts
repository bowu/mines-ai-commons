import type { NextFunction, Request, Response } from "express";

interface RateLimitState {
  count: number;
  resetAtMs: number;
}

interface CreateRateLimitOptions {
  bucket: string;
  maxRequests: number;
  windowMs: number;
  key: (req: Request) => string;
}

const rateLimitState = new Map<string, RateLimitState>();

function cleanupExpired(nowMs: number): void {
  for (const [key, state] of rateLimitState.entries()) {
    if (nowMs >= state.resetAtMs) {
      rateLimitState.delete(key);
    }
  }
}

export function createRateLimit(options: CreateRateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const nowMs = Date.now();
    if (rateLimitState.size > 10_000) {
      cleanupExpired(nowMs);
    }

    const key = `${options.bucket}:${options.key(req)}`;
    const existing = rateLimitState.get(key);
    const active =
      existing && nowMs < existing.resetAtMs
        ? existing
        : {
            count: 0,
            resetAtMs: nowMs + options.windowMs,
          };

    active.count += 1;
    rateLimitState.set(key, active);

    if (active.count > options.maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((active.resetAtMs - nowMs) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Rate limit exceeded",
        code: "RATE_LIMIT_EXCEEDED",
      });
      return;
    }

    next();
  };
}

export const _testOnly = {
  resetRateLimitState(): void {
    rateLimitState.clear();
  },
};
