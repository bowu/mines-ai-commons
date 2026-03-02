import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  const payloadTooLarge =
    !!error &&
    typeof error === "object" &&
    ((error as { type?: unknown }).type === "entity.too.large" ||
      (error as { name?: unknown }).name === "PayloadTooLargeError");
  const isAppError = error instanceof AppError;
  const statusCode = payloadTooLarge
    ? 413
    : isAppError
      ? error.statusCode
      : 500;
  const code = payloadTooLarge
    ? "PAYLOAD_TOO_LARGE"
    : isAppError
      ? error.code
      : "INTERNAL_ERROR";
  const message =
    isAppError || config.nodeEnv !== "production"
      ? error instanceof Error
        ? error.message
        : "Unknown error"
      : "Internal server error";

  console.error("Request failed", {
    method: req.method,
    path: req.path,
    code,
    statusCode,
    error: error instanceof Error ? error.message : String(error),
  });

  res.status(statusCode).json({
    error: {
      message,
      code,
    },
  });
}
