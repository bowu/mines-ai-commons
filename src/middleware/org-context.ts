import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { authBootstrapQuery } from "../db/index.js";
import { AppError } from "../lib/errors.js";

let cachedOrgId: string | null = null;
let loadingOrgId: Promise<string> | null = null;

async function loadDefaultOrgId(): Promise<string> {
  if (cachedOrgId) {
    return cachedOrgId;
  }

  if (!loadingOrgId) {
    loadingOrgId = (async () => {
      const result = await authBootstrapQuery<{ id: string }>(
        `SELECT id
         FROM organizations
         WHERE slug = $1
         LIMIT 1`,
        [config.defaultOrgSlug],
      );

      const orgId = result.rows[0]?.id;
      if (!orgId) {
        throw new AppError(
          `Default organization '${config.defaultOrgSlug}' not found`,
          503,
          "DEFAULT_ORG_NOT_FOUND",
        );
      }

      cachedOrgId = orgId;
      return orgId;
    })().finally(() => {
      loadingOrgId = null;
    });
  }

  return loadingOrgId;
}

export async function orgContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    req.orgId = await loadDefaultOrgId();
    next();
  } catch (error) {
    next(error);
  }
}
