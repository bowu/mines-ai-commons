import crypto from "node:crypto";
import { config } from "../../config.js";
import { pool } from "../../db/index.js";
import { AppError } from "../../lib/errors.js";

interface MagicTokenPayload {
  email: string;
  exp: number;
  nonce: string;
}

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

let lastMagicLinkForTest: { email: string; link: string } | null = null;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getMagicSecret(): string {
  const secret = config.authMagicLinkSecret || config.sessionSecret;
  if (!secret) {
    throw new AppError(
      "AUTH_MAGIC_LINK_SECRET (or SESSION_SECRET) is required for magic links",
      500,
      "MAGIC_LINK_SECRET_MISSING",
    );
  }
  return secret;
}

function sign(data: string): string {
  return crypto
    .createHmac("sha256", getMagicSecret())
    .update(data)
    .digest("base64url");
}

function tokenHash(token: string): string {
  return crypto
    .createHmac("sha256", getMagicSecret())
    .update(token)
    .digest("hex");
}

function encodePayload(payload: MagicTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): MagicTokenPayload {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as MagicTokenPayload;
    if (
      !parsed ||
      typeof parsed.email !== "string" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.nonce !== "string"
    ) {
      throw new Error("invalid payload");
    }
    return parsed;
  } catch {
    throw new AppError("Invalid magic link", 400, "MAGIC_LINK_INVALID");
  }
}

export function isMagicConfigured(): boolean {
  return config.authProvider === "magic";
}

export function createMagicLinkToken(email: string): string {
  const payload: MagicTokenPayload = {
    email: normalizeEmail(email),
    exp: Date.now() + config.authMagicLinkTtlMs,
    nonce: crypto.randomBytes(16).toString("base64url"),
  };

  const encoded = encodePayload(payload);
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

export async function recordMagicLinkToken(
  email: string,
  token: string,
): Promise<void> {
  const [encodedPayload] = token.split(".");
  if (!encodedPayload) {
    throw new AppError("Invalid magic link", 400, "MAGIC_LINK_INVALID");
  }

  const payload = decodePayload(encodedPayload);
  const normalizedEmail = normalizeEmail(email);
  if (normalizeEmail(payload.email) !== normalizedEmail) {
    throw new AppError("Invalid magic link", 400, "MAGIC_LINK_INVALID");
  }

  await pool.query(
    `INSERT INTO magic_link_tokens (email, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [normalizedEmail, tokenHash(token), new Date(payload.exp)],
  );
}

export async function hasRecentUnconsumedMagicLink(
  email: string,
  cooldownMs: number,
): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM magic_link_tokens
       WHERE email = $1
         AND consumed_at IS NULL
         AND expires_at > NOW()
         AND created_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
     ) AS exists`,
    [normalizedEmail, cooldownMs],
  );
  return Boolean(result.rows[0]?.exists);
}

export async function verifyMagicLinkToken(
  token: string,
): Promise<{ email: string }> {
  const { email: tokenEmail } = validateMagicLinkToken(token);

  const consumed = await pool.query<{ email: string }>(
    `UPDATE magic_link_tokens
     SET consumed_at = NOW()
     WHERE token_hash = $1
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING email`,
    [tokenHash(token)],
  );
  if (consumed.rows.length === 0) {
    throw new AppError(
      "Magic link is invalid or already used",
      400,
      "MAGIC_LINK_USED",
    );
  }

  const persistedEmail = normalizeEmail(consumed.rows[0]?.email || "");
  if (!persistedEmail || persistedEmail !== tokenEmail) {
    throw new AppError("Invalid magic link", 400, "MAGIC_LINK_INVALID");
  }

  return { email: tokenEmail };
}

export function validateMagicLinkToken(token: string): { email: string } {
  const [encoded, providedSignature, ...rest] = token.split(".");
  if (!encoded || !providedSignature || rest.length > 0) {
    throw new AppError("Invalid magic link", 400, "MAGIC_LINK_INVALID");
  }

  const expectedSignature = sign(encoded);
  const provided = Buffer.from(providedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    throw new AppError("Invalid magic link", 400, "MAGIC_LINK_INVALID");
  }

  const payload = decodePayload(encoded);
  if (payload.exp < Date.now()) {
    throw new AppError("Magic link expired", 400, "MAGIC_LINK_EXPIRED");
  }
  return { email: normalizeEmail(payload.email) };
}

export async function sendMagicLinkEmail(
  email: string,
  link: string,
): Promise<void> {
  const normalizedEmail = normalizeEmail(email);

  if (config.nodeEnv === "test") {
    lastMagicLinkForTest = { email: normalizedEmail, link };
    return;
  }

  if (!config.sendgridApiKey || !config.authMagicFromEmail) {
    throw new AppError(
      "Magic link email delivery is not configured",
      500,
      "MAGIC_EMAIL_NOT_CONFIGURED",
    );
  }

  const response = await fetch(SENDGRID_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: normalizedEmail }] }],
      from: { email: config.authMagicFromEmail },
      subject: "Your Mines AI sign-in link",
      content: [
        {
          type: "text/plain",
          value: `Use this secure sign-in link:\n\n${link}\n\nThis link expires in ${Math.floor(
            config.authMagicLinkTtlMs / 60000,
          )} minutes.`,
        },
      ],
      tracking_settings: {
        click_tracking: {
          enable: false,
          enable_text: false,
        },
      },
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new AppError(
      `Failed to send magic link email${
        details ? `: ${details.slice(0, 200)}` : ""
      }`,
      502,
      "MAGIC_EMAIL_SEND_FAILED",
    );
  }
}

export function consumeLastMagicLinkForTest(): {
  email: string;
  link: string;
} | null {
  const value = lastMagicLinkForTest;
  lastMagicLinkForTest = null;
  return value;
}
