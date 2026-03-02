import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import {
  clearCoreTables,
  closeTestPool,
  createTestUser,
  getDefaultOrgId,
  getTestPool,
} from "../test/db-helper.js";

const app = createApp();

const defaultIntegrationDatabaseUrl =
  process.env.INTEGRATION_DATABASE_URL ||
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";

async function createFreshApp(
  envOverrides: Record<string, string | undefined>,
) {
  const envKeys = [
    "NODE_ENV",
    "AUTH_PROVIDER",
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "SESSION_SECRET",
    "PUBLIC_URL",
    "SANDBOX_MODE",
  ];
  const previous: Record<string, string | undefined> = {};
  for (const key of envKeys) {
    previous[key] = process.env[key];
  }

  process.env.DATABASE_URL = defaultIntegrationDatabaseUrl;
  process.env.APP_DATABASE_URL = defaultIntegrationDatabaseUrl;
  process.env.PUBLIC_URL = "http://localhost:5173";
  process.env.SANDBOX_MODE = "local";

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  const { createApp: createRuntimeApp } = await import("../app.js");
  const { closePools } = await import("../db/index.js");

  return {
    app: createRuntimeApp(),
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

async function createAgentAclFixture() {
  const orgId = await getDefaultOrgId();
  const ownerEmail = "sandbox-owner@mines.edu";
  const editorEmail = "sandbox-editor@mines.edu";
  const viewerEmail = "sandbox-viewer@mines.edu";

  const ownerId = await createTestUser(orgId, ownerEmail, "Owner", "admin");
  const editorId = await createTestUser(orgId, editorEmail, "Editor", "member");
  const viewerId = await createTestUser(orgId, viewerEmail, "Viewer", "member");

  const agentId = randomUUID();
  await getTestPool().query(
    `INSERT INTO agents (id, org_id, name, description, icon, system_prompt)
     VALUES ($1, $2, 'Sandbox ACL Agent', '', '🔬', '')`,
    [agentId, orgId],
  );

  await getTestPool().query(
    `INSERT INTO agent_access (agent_id, user_id, role)
     VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'editor'),
       ($1, $4, 'viewer')`,
    [agentId, ownerId, editorId, viewerId],
  );

  return { agentId, ownerEmail, editorEmail, viewerEmail };
}

describe("sandbox routes integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("requires authentication when auth provider is not bypass mode", async () => {
    const runtime = await createFreshApp({
      NODE_ENV: "test",
      AUTH_PROVIDER: "oidc",
    });

    try {
      const response = await request(runtime.app).post(
        `/api/sandbox/${randomUUID()}/ensure`,
      );

      expect(response.status).toBe(401);
      expect(response.body.error?.code).toBe("UNAUTHORIZED");
    } finally {
      await runtime.cleanup();
    }
  });

  it("returns 403 for an unknown agentId on ensure (ACL fires before agent lookup)", async () => {
    // requireAgentAccess("viewer") runs before ensureSandbox(). If the agent
    // doesn't exist in agent_access the middleware returns 403 — not 404 —
    // which is the correct security behaviour (no resource-existence leakage).
    const fakeId = randomUUID();
    const response = await request(app).post(`/api/sandbox/${fakeId}/ensure`);
    expect(response.status).toBe(403);
  });

  it("returns vm_error_retrying when last_provision_error is set", async () => {
    const fixture = await createAgentAclFixture();
    await getTestPool().query(
      `UPDATE agents
       SET observed_vm_state = 'stopped',
           last_provision_error = 'quota exceeded during provisioning'
       WHERE id = $1`,
      [fixture.agentId],
    );

    const response = await request(app)
      .post(`/api/sandbox/${fixture.agentId}/ensure`)
      .set("X-Test-User-Email", fixture.editorEmail);

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("starting");
    expect(response.body.reason).toBe("vm_error_retrying");
  });

  it("only touches last_activity_at when touchActivity=true", async () => {
    const fixture = await createAgentAclFixture();
    await getTestPool().query(
      `UPDATE agents
       SET observed_vm_state = 'running',
           desired_vm_state = 'running',
           last_activity_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [fixture.agentId],
    );

    const before = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [fixture.agentId],
    );

    const passive = await request(app)
      .post(`/api/sandbox/${fixture.agentId}/ensure`)
      .set("X-Test-User-Email", fixture.editorEmail)
      .send({ touchActivity: false });
    expect(passive.status).toBe(200);

    const afterPassive = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [fixture.agentId],
    );
    expect(afterPassive.rows[0]?.last_activity_at.getTime()).toBe(
      before.rows[0]?.last_activity_at.getTime(),
    );

    const active = await request(app)
      .post(`/api/sandbox/${fixture.agentId}/ensure`)
      .set("X-Test-User-Email", fixture.editorEmail)
      .send({ touchActivity: true });
    expect(active.status).toBe(200);

    const afterActive = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [fixture.agentId],
    );
    expect(afterActive.rows[0]?.last_activity_at.getTime()).toBeGreaterThan(
      afterPassive.rows[0]?.last_activity_at.getTime() ?? 0,
    );
  });

  it("concurrent POST /ensure requests do not cause errors or corrupt state (route-level race)", async () => {
    // The route now sets intent only; reconciler performs VM actions.
    const fixture = await createAgentAclFixture();

    const [res1, res2] = await Promise.all([
      request(app)
        .post(`/api/sandbox/${fixture.agentId}/ensure`)
        .set("X-Test-User-Email", fixture.editorEmail),
      request(app)
        .post(`/api/sandbox/${fixture.agentId}/ensure`)
        .set("X-Test-User-Email", fixture.editorEmail),
    ]);

    // Neither request should produce a server error.
    for (const res of [res1, res2]) {
      expect(res.status).not.toBe(500);
    }

    // Both requests should report vm_starting until reconciler marks ready.
    for (const res of [res1, res2]) {
      expect(res.status).toBe(503);
      expect(res.body.reason).toBe("vm_starting");
    }

    // DB must remain consistent — desired state is running after either call.
    const row = await getTestPool().query<{
      observed_vm_state: string;
      desired_vm_state: string;
    }>("SELECT observed_vm_state, desired_vm_state FROM agents WHERE id = $1", [
      fixture.agentId,
    ]);
    expect(row.rows[0]?.observed_vm_state).toBe("stopped");
    expect(row.rows[0]?.desired_vm_state).toBe("running");
  });

  // Detailed ensure intent/error coverage lives in:
  // src/services/sandbox/client.ensure.integration.test.ts
});
