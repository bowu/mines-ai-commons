import { config } from "../../config.js";
import { authBootstrapQuery } from "../../db/index.js";
import { AppError } from "../../lib/errors.js";

export interface ProvisionedUser {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  role: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function getDomainFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    throw new AppError("Invalid email", 400, "INVALID_EMAIL");
  }
  return email.slice(at + 1);
}

function slugifyDomain(domain: string): string {
  const base = domain
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return base || "org";
}

function titleCaseSegment(segment: string): string {
  if (!segment) return segment;
  return segment[0].toUpperCase() + segment.slice(1);
}

function buildOrgName(domain: string): string {
  const root = domain.split(".")[0] || domain;
  return `${titleCaseSegment(root)} Organization`;
}

async function findOrganizationIdByDomain(domain: string): Promise<string> {
  const existing = await authBootstrapQuery<{ id: string }>(
    `SELECT id
     FROM organizations
     WHERE LOWER(domain) = $1
     LIMIT 1`,
    [domain],
  );

  const orgId = existing.rows[0]?.id;
  if (!orgId) {
    throw new AppError(
      `Failed to provision organization for domain ${domain}`,
      500,
      "ORG_PROVISION_FAILED",
    );
  }

  return orgId;
}

async function ensureOrganization(domain: string): Promise<string> {
  const preferredSlug = slugifyDomain(domain);
  const orgName = buildOrgName(domain);

  for (let attempt = 0; attempt < 8; attempt++) {
    const slug =
      attempt === 0 ? preferredSlug : `${preferredSlug}-${attempt + 1}`;

    try {
      const inserted = await authBootstrapQuery<{ id: string }>(
        `INSERT INTO organizations (name, slug, domain)
         VALUES ($1, $2, $3)
         ON CONFLICT ((LOWER(domain))) DO NOTHING
         RETURNING id`,
        [orgName, slug, domain],
      );

      if (inserted.rows[0]?.id) {
        return inserted.rows[0].id;
      }

      return await findOrganizationIdByDomain(domain);
    } catch (error: any) {
      if (
        error?.code === "23505" &&
        String(error?.constraint || "").includes("organizations_slug_unique")
      ) {
        continue;
      }
      throw error;
    }
  }

  return findOrganizationIdByDomain(domain);
}

export async function provisionOrgAndUser(
  email: string,
  name: string,
): Promise<ProvisionedUser> {
  const normalizedEmail = normalizeEmail(email);

  if (
    config.authProvider !== "none" &&
    config.authEmailWhitelist.size > 0 &&
    !config.authEmailWhitelist.has(normalizedEmail)
  ) {
    throw new AppError(
      "Access denied: email not on the allowed list",
      403,
      "EMAIL_NOT_WHITELISTED",
    );
  }

  const domain = getDomainFromEmail(normalizedEmail);
  const displayName = name.trim() || normalizedEmail;

  const orgId = await ensureOrganization(domain);

  const userResult = await authBootstrapQuery<{
    id: string;
    org_id: string;
    email: string;
    name: string | null;
    role: string | null;
  }>(
    `INSERT INTO users (org_id, email, name, role)
     VALUES ($1, $2, $3, 'member')
     ON CONFLICT ((LOWER(email)))
     DO UPDATE SET name = EXCLUDED.name
     RETURNING id, org_id, email, name, role`,
    [orgId, normalizedEmail, displayName],
  );

  const row = userResult.rows[0];
  if (!row) {
    throw new AppError(
      "Failed to provision user",
      500,
      "USER_PROVISION_FAILED",
    );
  }

  return {
    userId: row.id,
    orgId: row.org_id,
    email: row.email,
    name: row.name || displayName,
    role: row.role || "member",
  };
}
