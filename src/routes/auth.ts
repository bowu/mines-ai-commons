import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import * as oidc from "openid-client";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { requireAuthContext } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import {
  createMagicLinkToken,
  hasRecentUnconsumedMagicLink,
  isMagicConfigured,
  recordMagicLinkToken,
  sendMagicLinkEmail,
  validateMagicLinkToken,
  verifyMagicLinkToken,
} from "../services/auth/magic.js";
import {
  getOidcConfiguration,
  isOidcConfigured,
} from "../services/auth/oidc.js";
import { provisionOrgAndUser } from "../services/auth/provision.js";
import {
  type OidcCallbackQuery,
  magicLinkRequestBodySchema,
  magicLinkVerifyBodySchema,
  magicLinkVerifyQuerySchema,
  oidcCallbackQuerySchema,
} from "./schemas/auth.schema.js";

export const authPublicRouter = Router();
export const authSessionRouter = Router();
export const authProtectedRouter = Router();

function rateLimitClientKey(req: Request): string {
  const forwarded = req.header("x-forwarded-for") || "";
  const primaryForwarded = forwarded.split(",")[0]?.trim();
  const ip =
    primaryForwarded || req.ip || req.socket.remoteAddress || "unknown";
  return ip;
}

const magicRequestRateLimit = createRateLimit({
  bucket: "auth_magic_request",
  maxRequests: config.authMagicRequestRateLimitMax,
  windowMs: config.authMagicRequestRateLimitWindowMs,
  key: rateLimitClientKey,
});

const magicVerifyRateLimit = createRateLimit({
  bucket: "auth_magic_verify",
  maxRequests: config.authMagicVerifyRateLimitMax,
  windowMs: config.authMagicVerifyRateLimitWindowMs,
  key: rateLimitClientKey,
});

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function setAuthenticatedSession(
  req: Request,
  user: {
    userId: string;
    orgId: string;
    email: string;
    name: string;
    role: string;
  },
): Promise<void> {
  await regenerateSession(req);
  req.session.userId = user.userId;
  req.session.orgId = user.orgId;
  req.session.email = user.email;
  req.session.name = user.name;
  req.session.role = user.role;
  req.session.oidcState = undefined;
  req.session.oidcNonce = undefined;
  req.session.oidcCodeVerifier = undefined;
  await saveSession(req);
}

function getClaimString(claims: Record<string, unknown>, key: string): string {
  const value = claims[key];
  return typeof value === "string" ? value : "";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function ensureWhitelistedEmail(email: string): void {
  if (
    config.authEmailWhitelist.size > 0 &&
    !config.authEmailWhitelist.has(normalizeEmail(email))
  ) {
    throw new AppError(
      "Access denied: email not on the allowed list",
      403,
      "EMAIL_NOT_WHITELISTED",
    );
  }
}

function renderMagicLoginPage(message = ""): string {
  const escapedMessage = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in | Mines AI</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #111827; }
    .card { max-width: 420px; margin: 48px auto; background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }
    h1 { margin-top: 0; font-size: 20px; }
    p { color: #4b5563; }
    label { display: block; margin-top: 12px; font-size: 14px; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; }
    button { margin-top: 14px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #111827; color: white; font-weight: 600; cursor: pointer; }
    .status { margin-top: 12px; min-height: 20px; font-size: 13px; color: #1f2937; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Sign in with Magic Link</h1>
    <p>Enter your email to receive a sign-in link.</p>
    <form id="magic-link-form">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" required autocomplete="email" />
      <button id="send-btn" type="submit">Send sign-in link</button>
    </form>
    <div id="status" class="status">${escapedMessage}</div>
  </main>
  <script>
    const form = document.getElementById("magic-link-form");
    const status = document.getElementById("status");
    const sendBtn = document.getElementById("send-btn");
    let sending = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (sending) return;
      const email = document.getElementById("email").value.trim();
      if (!email) return;
      sending = true;
      sendBtn.disabled = true;
      status.textContent = "Sending...";
      try {
        const res = await fetch("/api/auth/magic/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          status.textContent = (payload && payload.error && payload.error.message) || "Failed to send magic link.";
          return;
        }
        status.textContent = "If your email is allowed, check your inbox for a sign-in link.";
      } catch {
        status.textContent = "Failed to send magic link.";
      } finally {
        // Keep the button disabled briefly to avoid duplicate sends from
        // double-click/Enter key retries.
        setTimeout(() => {
          sending = false;
          sendBtn.disabled = false;
        }, 3000);
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMagicVerifyPage(token: string): string {
  const escapedToken = escapeHtml(token);
  const escapedRedirect = escapeHtml(config.publicUrl);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Complete sign in | Mines AI</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px; background: #f7f7f8; color: #111827; }
    .card { max-width: 460px; margin: 48px auto; background: white; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; }
    h1 { margin-top: 0; font-size: 20px; }
    p { color: #4b5563; }
    button { margin-top: 14px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: #111827; color: white; font-weight: 600; cursor: pointer; }
    button[disabled] { opacity: 0.6; cursor: default; }
    .status { margin-top: 12px; min-height: 20px; font-size: 13px; color: #1f2937; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Complete sign in</h1>
    <p>Click continue to finish signing in.</p>
    <button id="continue-btn" type="button">Continue</button>
    <div id="status" class="status"></div>
  </main>
  <script>
    const token = "${escapedToken}";
    const fallbackRedirect = "${escapedRedirect}";
    const button = document.getElementById("continue-btn");
    const status = document.getElementById("status");
    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Signing you in...";
      try {
        const res = await fetch("/api/auth/magic/verify/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          const message = payload && payload.error && payload.error.message
            ? payload.error.message
            : "Sign-in failed. Request a new magic link.";
          status.textContent = message;
          button.disabled = false;
          return;
        }
        window.location.href = (payload && payload.redirectTo) || fallbackRedirect;
      } catch {
        status.textContent = "Sign-in failed. Request a new magic link.";
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

authPublicRouter.get(
  "/login",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        req.session?.userId &&
        req.session.orgId &&
        req.session.email &&
        req.session.name &&
        req.session.role
      ) {
        return res.redirect(config.publicUrl);
      }

      if (config.authProvider === "none") {
        const user = await provisionOrgAndUser(
          config.defaultUserEmail,
          config.defaultUserName,
        );

        await setAuthenticatedSession(req, user);
        return res.redirect(config.publicUrl);
      }

      if (isMagicConfigured()) {
        return res.type("html").status(200).send(renderMagicLoginPage());
      }

      const oidcConfig = await getOidcConfiguration();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);

      req.session.oidcState = state;
      req.session.oidcNonce = nonce;
      req.session.oidcCodeVerifier = codeVerifier;
      await saveSession(req);

      const authorizationUrl = oidc.buildAuthorizationUrl(oidcConfig, {
        scope: "openid email profile",
        response_type: "code",
        redirect_uri: config.oidcCallbackUrl,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      return res.redirect(String(authorizationUrl));
    } catch (error) {
      next(error);
    }
  },
);

authPublicRouter.post(
  "/magic/request",
  magicRequestRateLimit,
  validate({ body: magicLinkRequestBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isMagicConfigured()) {
        throw new AppError(
          "Magic link auth is not enabled",
          400,
          "MAGIC_NOT_ENABLED",
        );
      }

      const email = normalizeEmail((req.body as { email: string }).email);
      ensureWhitelistedEmail(email);

      const alreadySentRecently = await hasRecentUnconsumedMagicLink(
        email,
        config.authMagicResendCooldownMs,
      );
      if (alreadySentRecently) {
        return res.json({ ok: true });
      }

      const token = createMagicLinkToken(email);
      await recordMagicLinkToken(email, token);
      const magicLink = `${config.publicUrl}/api/auth/magic/verify?token=${encodeURIComponent(
        token,
      )}`;
      await sendMagicLinkEmail(email, magicLink);

      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

authPublicRouter.get(
  "/magic/verify",
  magicVerifyRateLimit,
  validate({ query: magicLinkVerifyQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isMagicConfigured()) {
        throw new AppError(
          "Magic link auth is not enabled",
          400,
          "MAGIC_NOT_ENABLED",
        );
      }

      const token = String((req.query as { token: string }).token || "");
      const { email } = validateMagicLinkToken(token);
      ensureWhitelistedEmail(email);
      return res.type("html").status(200).send(renderMagicVerifyPage(token));
    } catch (error) {
      next(error);
    }
  },
);

authPublicRouter.post(
  "/magic/verify/confirm",
  magicVerifyRateLimit,
  validate({ body: magicLinkVerifyBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isMagicConfigured()) {
        throw new AppError(
          "Magic link auth is not enabled",
          400,
          "MAGIC_NOT_ENABLED",
        );
      }

      const token = String((req.body as { token: string }).token || "");
      const { email } = await verifyMagicLinkToken(token);
      ensureWhitelistedEmail(email);

      const user = await provisionOrgAndUser(email, email);
      await setAuthenticatedSession(req, user);
      return res.json({ ok: true, redirectTo: config.publicUrl });
    } catch (error) {
      next(error);
    }
  },
);

authPublicRouter.get(
  "/callback",
  validate({ query: oidcCallbackQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!isOidcConfigured()) {
        throw new AppError("OIDC not enabled", 400, "OIDC_NOT_ENABLED");
      }

      const callbackQuery = req.query as OidcCallbackQuery;
      if ("error" in callbackQuery) {
        const detail = callbackQuery.error_description
          ? `: ${callbackQuery.error_description}`
          : "";
        throw new AppError(
          `OIDC login failed (${callbackQuery.error})${detail}`,
          400,
          "OIDC_LOGIN_FAILED",
        );
      }

      const expectedState = req.session.oidcState;
      const expectedNonce = req.session.oidcNonce;
      const pkceCodeVerifier = req.session.oidcCodeVerifier;

      if (!expectedState || !expectedNonce || !pkceCodeVerifier) {
        throw new AppError(
          "Missing OIDC state from session",
          400,
          "OIDC_STATE_MISSING",
        );
      }

      const oidcConfig = await getOidcConfiguration();
      const callbackUrl = new URL(config.oidcCallbackUrl);
      callbackUrl.search = new URLSearchParams({
        code: callbackQuery.code,
        state: callbackQuery.state,
      }).toString();

      const tokenResponse = await oidc.authorizationCodeGrant(
        oidcConfig,
        callbackUrl,
        {
          expectedState,
          expectedNonce,
          pkceCodeVerifier,
        },
      );

      const claims = tokenResponse.claims();
      if (!claims) {
        throw new AppError("Missing ID token claims", 400, "OIDC_NO_CLAIMS");
      }

      const email = getClaimString(claims as Record<string, unknown>, "email");
      if (!email) {
        throw new AppError(
          "OIDC response missing email claim",
          400,
          "OIDC_EMAIL_MISSING",
        );
      }

      const name =
        getClaimString(claims as Record<string, unknown>, "name") || email;

      const user = await provisionOrgAndUser(email, name);
      await setAuthenticatedSession(req, user);

      return res.redirect(config.publicUrl);
    } catch (error) {
      next(error);
    }
  },
);

authSessionRouter.post(
  "/logout",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.session) {
        res.clearCookie("sid", { path: "/api" });
        return res.json({ ok: true });
      }

      await new Promise<void>((resolve, reject) => {
        req.session.destroy((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      res.clearCookie("sid", { path: "/api" });
      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);

authProtectedRouter.get(
  "/me",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user } = requireAuthContext(req);
      res.json({ user });
    } catch (error) {
      next(error);
    }
  },
);
