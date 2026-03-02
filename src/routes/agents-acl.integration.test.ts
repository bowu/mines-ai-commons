import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  clearCoreTables,
  closeTestPool,
  createTestUser,
  getDefaultOrgId,
  getTestPool,
} from "../test/db-helper.js";

const app = createApp();

interface AclFixture {
  orgId: string;
  agentId: string;
  ownerEmail: string;
  ownerId: string;
  editorEmail: string;
  editorId: string;
  viewerEmail: string;
  viewerId: string;
  noAccessEmail: string;
  noAccessId: string;
  sessionId: string;
}

async function setupAclFixture(): Promise<AclFixture> {
  const pool = getTestPool();
  const orgId = await getDefaultOrgId();

  const ownerEmail = "owner@mines.edu";
  const editorEmail = "editor@mines.edu";
  const viewerEmail = "viewer@mines.edu";
  const noAccessEmail = "noaccess@mines.edu";

  const ownerId = await createTestUser(orgId, ownerEmail, "Owner", "admin");
  const editorId = await createTestUser(orgId, editorEmail, "Editor", "member");
  const viewerId = await createTestUser(orgId, viewerEmail, "Viewer", "member");
  const noAccessId = await createTestUser(
    orgId,
    noAccessEmail,
    "No Access",
    "member",
  );

  const agentId = randomUUID();
  await pool.query(
    `INSERT INTO agents (id, org_id, name, description, icon, system_prompt)
     VALUES ($1, $2, 'ACL Agent', '', '🔬', '')`,
    [agentId, orgId],
  );

  await pool.query(
    `INSERT INTO agent_access (agent_id, user_id, role)
     VALUES
       ($1, $2, 'owner'),
       ($1, $3, 'editor'),
       ($1, $4, 'viewer')`,
    [agentId, ownerId, editorId, viewerId],
  );

  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO agent_chat_sessions (id, agent_id, created_by)
     VALUES ($1, $2, $3)`,
    [sessionId, agentId, viewerId],
  );

  await pool.query(
    `INSERT INTO agent_chat_messages (session_id, user_id, role, content)
     VALUES ($1, $2, 'user', 'hello')`,
    [sessionId, viewerId],
  );

  return {
    orgId,
    agentId,
    ownerEmail,
    ownerId,
    editorEmail,
    editorId,
    viewerEmail,
    viewerId,
    noAccessEmail,
    noAccessId,
    sessionId,
  };
}

describe("agents ACL integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("enforces owner vs editor permissions", async () => {
    const fixture = await setupAclFixture();

    const ownerGet = await request(app)
      .get(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.ownerEmail);
    expect(ownerGet.status).toBe(200);

    const ownerUpdate = await request(app)
      .put(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.ownerEmail)
      .send({ description: "owner updated" });
    expect(ownerUpdate.status).toBe(200);

    const editorGet = await request(app)
      .get(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.editorEmail);
    expect(editorGet.status).toBe(200);

    const editorChat = await request(app)
      .post(`/api/agent-chat/${fixture.agentId}/chat`)
      .set("X-Test-User-Email", fixture.editorEmail)
      .send({ message: " " });
    expect(editorChat.status).toBe(400);

    const editorUpdate = await request(app)
      .put(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.editorEmail)
      .send({ description: "editor update should fail" });
    expect(editorUpdate.status).toBe(403);

    const editorDelete = await request(app)
      .delete(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.editorEmail);
    expect(editorDelete.status).toBe(403);
  });

  it("enforces viewer and no-access restrictions", async () => {
    const fixture = await setupAclFixture();

    const viewerGet = await request(app)
      .get(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.viewerEmail);
    expect(viewerGet.status).toBe(200);

    const viewerMessages = await request(app)
      .get(`/api/agent-chat/sessions/${fixture.sessionId}/messages`)
      .set("X-Test-User-Email", fixture.viewerEmail);
    expect(viewerMessages.status).toBe(200);

    const viewerChat = await request(app)
      .post(`/api/agent-chat/${fixture.agentId}/chat`)
      .set("X-Test-User-Email", fixture.viewerEmail)
      .send({ message: "hi" });
    expect(viewerChat.status).toBe(403);

    const viewerUpload = await request(app)
      .post(`/api/workspace/${fixture.agentId}/upload`)
      .set("X-Test-User-Email", fixture.viewerEmail);
    expect(viewerUpload.status).toBe(403);

    const noAccessGet = await request(app)
      .get(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.noAccessEmail);
    expect(noAccessGet.status).toBe(403);

    const noAccessChat = await request(app)
      .post(`/api/agent-chat/${fixture.agentId}/chat`)
      .set("X-Test-User-Email", fixture.noAccessEmail)
      .send({ message: "hi" });
    expect(noAccessChat.status).toBe(403);
  });

  it("supports share and unshare flow", async () => {
    const fixture = await setupAclFixture();

    const share = await request(app)
      .post(`/api/agents/${fixture.agentId}/share`)
      .set("X-Test-User-Email", fixture.ownerEmail)
      .send({ email: fixture.noAccessEmail, role: "editor" });
    expect(share.status).toBe(200);

    const nowCanAccess = await request(app)
      .get(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.noAccessEmail);
    expect(nowCanAccess.status).toBe(200);

    const unshare = await request(app)
      .delete(`/api/agents/${fixture.agentId}/share/${fixture.noAccessId}`)
      .set("X-Test-User-Email", fixture.ownerEmail);
    expect(unshare.status).toBe(200);

    const accessRemoved = await request(app)
      .get(`/api/agents/${fixture.agentId}`)
      .set("X-Test-User-Email", fixture.noAccessEmail);
    expect(accessRemoved.status).toBe(403);
  });

  it("prevents removing the last owner", async () => {
    const fixture = await setupAclFixture();

    const removeLastOwner = await request(app)
      .delete(`/api/agents/${fixture.agentId}/share/${fixture.ownerId}`)
      .set("X-Test-User-Email", fixture.ownerEmail);

    expect(removeLastOwner.status).toBe(409);
  });
});
