import * as oidc from "openid-client";
import { config } from "../../config.js";
import { AppError } from "../../lib/errors.js";

let oidcConfigPromise: Promise<oidc.Configuration> | null = null;

function ensureOidcConfigured(): void {
  if (config.authProvider !== "oidc") {
    throw new AppError("OIDC auth is not enabled", 400, "OIDC_NOT_ENABLED");
  }

  if (!config.oidcIssuerUrl) {
    throw new AppError(
      "OIDC_ISSUER_URL is required when AUTH_PROVIDER=oidc",
      500,
      "OIDC_MISCONFIGURED",
    );
  }

  if (!config.oidcClientId) {
    throw new AppError(
      "OIDC_CLIENT_ID is required when AUTH_PROVIDER=oidc",
      500,
      "OIDC_MISCONFIGURED",
    );
  }

  if (!config.oidcCallbackUrl) {
    throw new AppError(
      "OIDC_CALLBACK_URL is required when AUTH_PROVIDER=oidc",
      500,
      "OIDC_MISCONFIGURED",
    );
  }
}

export function isOidcConfigured(): boolean {
  return config.authProvider === "oidc";
}

export async function getOidcConfiguration(): Promise<oidc.Configuration> {
  ensureOidcConfigured();

  if (!oidcConfigPromise) {
    oidcConfigPromise = oidc.discovery(
      new URL(config.oidcIssuerUrl),
      config.oidcClientId,
      {
        client_secret: config.oidcClientSecret || undefined,
        redirect_uris: [config.oidcCallbackUrl],
        response_types: ["code"],
      },
    );
  }

  return oidcConfigPromise;
}
