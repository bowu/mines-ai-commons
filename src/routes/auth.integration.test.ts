import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCoreTables, closeTestPool } from "../test/db-helper.js";

const defaultIntegrationDatabaseUrl =
  process.env.INTEGRATION_DATABASE_URL ||
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";

async function createFreshApp(
  envOverrides: Record<string, string | undefined>,
) {
  const envKeys = [
    "NODE_ENV",
    "AUTH_PROVIDER",
    "AUTH_EMAIL_WHITELIST",
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "SESSION_SECRET",
    "PUBLIC_URL",
    "SENDGRID_API_KEY",
    "AUTH_MAGIC_FROM_EMAIL",
    "AUTH_MAGIC_LINK_SECRET",
    "AUTH_MAGIC_LINK_TTL_MS",
    "AUTH_MAGIC_RESEND_COOLDOWN_MS",
  ];
  const previous: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    previous[key] = process.env[key];
  }

  process.env.DATABASE_URL = defaultIntegrationDatabaseUrl;
  process.env.APP_DATABASE_URL = defaultIntegrationDatabaseUrl;
  process.env.AUTH_PROVIDER = "none";
  process.env.PUBLIC_URL = "http://localhost:5173";

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  const { createApp } = await import("../app.js");
  const { closePools } = await import("../db/index.js");

  return {
    app: createApp(),
    async cleanup() {
      await closePools();
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    },
  };
}

function getCookieHeader(
  setCookie: string | string[] | undefined,
): string | undefined {
  if (!setCookie) return undefined;
  const cookieValues = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookieValues.map((cookie) => cookie.split(";")[0]).join("; ");
}

describe("auth routes integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("GET /api/auth/me succeeds without session in bypass mode", async () => {
    const runtime = await createFreshApp({ NODE_ENV: "test" });
    try {
      const res = await request(runtime.app).get("/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("admin@mines.edu");
    } finally {
      await runtime.cleanup();
    }
  });

  it("GET /api/auth/login redirects and sets session cookie in bypass mode", async () => {
    const runtime = await createFreshApp({ NODE_ENV: "test" });
    try {
      const login = await request(runtime.app).get("/api/auth/login");
      expect(login.status).toBe(302);
      expect(login.headers.location).toBe("http://localhost:5173");
      expect(getCookieHeader(login.headers["set-cookie"])).toBeTruthy();
    } finally {
      await runtime.cleanup();
    }
  });

  it("GET /api/auth/me returns user with session cookie after login", async () => {
    const runtime = await createFreshApp({ NODE_ENV: "test" });
    try {
      const login = await request(runtime.app).get("/api/auth/login");
      const cookie = getCookieHeader(login.headers["set-cookie"]);
      const me = await request(runtime.app)
        .get("/api/auth/me")
        .set("Cookie", cookie || "");
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe("admin@mines.edu");
    } finally {
      await runtime.cleanup();
    }
  });

  it("POST /api/auth/logout is idempotent", async () => {
    const runtime = await createFreshApp({ NODE_ENV: "test" });
    try {
      const login = await request(runtime.app).get("/api/auth/login");
      const cookie = getCookieHeader(login.headers["set-cookie"]);

      const logoutWithSession = await request(runtime.app)
        .post("/api/auth/logout")
        .set("Cookie", cookie || "");
      expect(logoutWithSession.status).toBe(200);
      expect(logoutWithSession.body).toEqual({ ok: true });

      const logoutWithoutSession = await request(runtime.app).post(
        "/api/auth/logout",
      );
      expect(logoutWithoutSession.status).toBe(200);
      expect(logoutWithoutSession.body).toEqual({ ok: true });
    } finally {
      await runtime.cleanup();
    }
  });

  it("GET /api/auth/callback returns 400 when oidc is not enabled", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "none",
    });
    try {
      const res = await request(runtime.app).get(
        "/api/auth/callback?code=abc&state=def",
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OIDC_NOT_ENABLED");
    } finally {
      await runtime.cleanup();
    }
  });

  it("GET /api/auth/callback accepts OIDC error callback shape", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "none",
    });
    try {
      const res = await request(runtime.app).get(
        "/api/auth/callback?error=access_denied&state=def",
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OIDC_NOT_ENABLED");
    } finally {
      await runtime.cleanup();
    }
  });

  it("honors X-Test-User-Email only in NODE_ENV=test", async () => {
    const testRuntime = await createFreshApp({ NODE_ENV: "test" });
    try {
      const testRes = await request(testRuntime.app)
        .get("/api/auth/me")
        .set("X-Test-User-Email", "viewer@example.edu");
      expect(testRes.status).toBe(200);
      expect(testRes.body.user.email).toBe("viewer@example.edu");
    } finally {
      await testRuntime.cleanup();
    }

    const devRuntime = await createFreshApp({ NODE_ENV: "development" });
    try {
      const devRes = await request(devRuntime.app)
        .get("/api/auth/me")
        .set("X-Test-User-Email", "viewer@example.edu");
      expect(devRes.status).toBe(200);
      expect(devRes.body.user.email).toBe("admin@mines.edu");
    } finally {
      await devRuntime.cleanup();
    }
  });

  it("enforces csrf origin checks in production", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "production",
      SESSION_SECRET: "01234567890123456789012345678901",
    });

    try {
      const missingOrigin = await request(runtime.app).post("/api/auth/logout");
      expect(missingOrigin.status).toBe(403);

      const wrongOrigin = await request(runtime.app)
        .post("/api/auth/logout")
        .set("Origin", "https://evil.example.com");
      expect(wrongOrigin.status).toBe(403);
    } finally {
      await runtime.cleanup();
    }
  });

  it("supports whitelist-gated magic link login flow", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "magic",
      AUTH_EMAIL_WHITELIST: "allowed@example.edu",
      PUBLIC_URL: "http://localhost:5173",
      AUTH_MAGIC_LINK_SECRET: "magic-secret-for-tests",
      AUTH_MAGIC_LINK_TTL_MS: "600000",
    });

    try {
      const requestLink = await request(runtime.app)
        .post("/api/auth/magic/request")
        .send({ email: "allowed@example.edu" });

      expect(requestLink.status).toBe(200);
      expect(requestLink.body).toEqual({ ok: true });

      const magic = await import("../services/auth/magic.js");
      const sent = magic.consumeLastMagicLinkForTest();
      expect(sent?.email).toBe("allowed@example.edu");
      expect(sent?.link).toContain("/api/auth/magic/verify?token=");

      const parsed = new URL(sent?.link || "http://localhost/invalid");
      const verifyPage = await request(runtime.app).get(
        `${parsed.pathname}${parsed.search}`,
      );

      expect(verifyPage.status).toBe(200);
      expect(verifyPage.headers["content-type"]).toContain("text/html");
      expect(verifyPage.text).toContain("Complete sign in");
      expect(verifyPage.text).toContain("/api/auth/magic/verify/confirm");

      const verifyResponse = await request(runtime.app)
        .post("/api/auth/magic/verify/confirm")
        .send({
          token: parsed.searchParams.get("token"),
        });

      expect(verifyResponse.status).toBe(200);
      expect(verifyResponse.body).toEqual({
        ok: true,
        redirectTo: "http://localhost:5173",
      });

      const cookie = getCookieHeader(verifyResponse.headers["set-cookie"]);
      expect(cookie).toBeTruthy();

      const me = await request(runtime.app)
        .get("/api/auth/me")
        .set("Cookie", cookie || "");
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe("allowed@example.edu");

      const replayResponse = await request(runtime.app)
        .post("/api/auth/magic/verify/confirm")
        .send({
          token: parsed.searchParams.get("token"),
        });
      expect(replayResponse.status).toBe(400);
      expect(replayResponse.body.error.code).toBe("MAGIC_LINK_USED");
    } finally {
      await runtime.cleanup();
    }
  });

  it("deduplicates repeated magic link requests during cooldown", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "magic",
      AUTH_EMAIL_WHITELIST: "allowed@example.edu",
      AUTH_MAGIC_LINK_SECRET: "magic-secret-for-tests",
      AUTH_MAGIC_RESEND_COOLDOWN_MS: "30000",
    });

    try {
      const magic = await import("../services/auth/magic.js");

      const first = await request(runtime.app)
        .post("/api/auth/magic/request")
        .send({ email: "allowed@example.edu" });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ok: true });
      expect(magic.consumeLastMagicLinkForTest()).toBeTruthy();

      const second = await request(runtime.app)
        .post("/api/auth/magic/request")
        .send({ email: "allowed@example.edu" });
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ ok: true });
      expect(magic.consumeLastMagicLinkForTest()).toBeNull();
    } finally {
      await runtime.cleanup();
    }
  });

  it("rejects non-whitelisted email in magic link flow", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "magic",
      AUTH_EMAIL_WHITELIST: "allowed@example.edu",
      AUTH_MAGIC_LINK_SECRET: "magic-secret-for-tests",
    });

    try {
      const response = await request(runtime.app)
        .post("/api/auth/magic/request")
        .send({ email: "blocked@example.edu" });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("EMAIL_NOT_WHITELISTED");
    } finally {
      await runtime.cleanup();
    }
  });

  it("renders magic-link login page when magic auth is enabled", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "magic",
      AUTH_MAGIC_LINK_SECRET: "magic-secret-for-tests",
    });

    try {
      const response = await request(runtime.app).get("/api/auth/login");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.text).toContain("Sign in with Magic Link");
      expect(response.text).toContain("/api/auth/magic/request");
    } finally {
      await runtime.cleanup();
    }
  });
});
