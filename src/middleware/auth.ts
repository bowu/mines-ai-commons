import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import {
  type ProvisionedUser,
  provisionOrgAndUser,
} from "../services/auth/provision.js";

const bypassUserCache = new Map<string, Promise<ProvisionedUser>>();

function deriveNameFromEmail(email: string): string {
  const local = email.split("@")[0] || "user";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveBypassEmail(req: Request): string {
  if (config.nodeEnv === "test") {
    const testEmail = req.header("X-Test-User-Email")?.trim().toLowerCase();
    if (testEmail) {
      return testEmail;
    }
  }
  return config.defaultUserEmail;
}

async function getOrProvisionBypassUser(
  email: string,
  name: string,
): Promise<ProvisionedUser> {
  if (config.nodeEnv === "test") {
    // Tests reset database rows between cases, so cache entries become stale.
    return provisionOrgAndUser(email.toLowerCase(), name);
  }

  const cacheKey = email.toLowerCase();
  let pending = bypassUserCache.get(cacheKey);
  if (!pending) {
    pending = provisionOrgAndUser(cacheKey, name).catch((error) => {
      bypassUserCache.delete(cacheKey);
      throw error;
    });
    bypassUserCache.set(cacheKey, pending);
  }
  return pending;
}

export function requireAuthContext(req: Request): {
  orgId: string;
  user: Express.AuthUser;
} {
  if (!req.orgId || !req.user) {
    throw new AppError("Unauthorized", 401, "UNAUTHORIZED");
  }

  return {
    orgId: req.orgId,
    user: req.user,
  };
}

export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (config.authProvider === "none") {
      const email = resolveBypassEmail(req);
      const fallbackName =
        email === config.defaultUserEmail
          ? config.defaultUserName
          : deriveNameFromEmail(email);

      const provisioned = await getOrProvisionBypassUser(email, fallbackName);

      req.orgId = provisioned.orgId;
      req.user = {
        id: provisioned.userId,
        orgId: provisioned.orgId,
        email: provisioned.email,
        name: provisioned.name,
        role: provisioned.role,
      };
      return next();
    }

    if (
      req.session?.userId &&
      req.session.orgId &&
      req.session.email &&
      req.session.name &&
      req.session.role
    ) {
      req.orgId = req.session.orgId;
      req.user = {
        id: req.session.userId,
        orgId: req.session.orgId,
        email: req.session.email,
        name: req.session.name,
        role: req.session.role,
      };
      return next();
    }

    next(new AppError("Unauthorized", 401, "UNAUTHORIZED"));
  } catch (error) {
    next(error);
  }
}
