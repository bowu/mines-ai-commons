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

describe("agents routes integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("supports agents CRUD flow", async () => {
    const listEmpty = await request(app).get("/api/agents");
    expect(listEmpty.status).toBe(200);
    expect(listEmpty.body.agents).toEqual([]);

    const create = await request(app).post("/api/agents").send({
      name: "Integration Agent",
      description: "agent for integration tests",
    });
    expect(create.status).toBe(201);
    expect(create.body.agent.name).toBe("Integration Agent");

    const agentId = create.body.agent.id as string;

    const getOne = await request(app).get(`/api/agents/${agentId}`);
    expect(getOne.status).toBe(200);
    expect(getOne.body.agent.id).toBe(agentId);

    const update = await request(app).put(`/api/agents/${agentId}`).send({
      description: "updated description",
    });
    expect(update.status).toBe(200);
    expect(update.body.agent.description).toBe("updated description");

    const del = await request(app).delete(`/api/agents/${agentId}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe("");

    const missing = await request(app).get(`/api/agents/${agentId}`);
    expect(missing.status).toBe(404);
  });

  it("lists newest agents first", async () => {
    const first = await request(app).post("/api/agents").send({
      name: "First Agent",
    });
    expect(first.status).toBe(201);
    const firstAgentId = first.body.agent.id as string;

    await getTestPool().query(
      `UPDATE agents
       SET last_user_message_at = NOW() - interval '1 day'
       WHERE id = $1`,
      [firstAgentId],
    );

    const second = await request(app).post("/api/agents").send({
      name: "Second Agent",
    });
    expect(second.status).toBe(201);
    const secondAgentId = second.body.agent.id as string;

    const list = await request(app).get("/api/agents");
    expect(list.status).toBe(200);
    expect(list.body.agents.map((agent: { id: string }) => agent.id)).toEqual([
      secondAgentId,
      firstAgentId,
    ]);
  });

  it("returns 403 for unknown agent id without access", async () => {
    const response = await request(app).get(`/api/agents/${randomUUID()}`);
    expect(response.status).toBe(403);
  });

  it("marks agents for runtime upgrade for admin users", async () => {
    const orgId = await getDefaultOrgId();
    const adminEmail = "runtime-admin@mines.edu";
    await createTestUser(orgId, adminEmail, "Runtime Admin", "admin");

    const created = await request(app)
      .post("/api/agents")
      .set("X-Test-User-Email", adminEmail)
      .send({
        name: "Runtime Upgrade Agent",
        description: "agent for upgrade marking",
      });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;

    const mark = await request(app)
      .post("/api/agents/runtime/upgrade")
      .set("X-Test-User-Email", adminEmail)
      .send({ agentIds: [agentId] });
    expect(mark.status).toBe(200);
    expect(mark.body.updatedCount).toBe(1);
    expect(mark.body.agentIds).toEqual([agentId]);

    const row = await getTestPool().query<{
      needs_upgrade: boolean;
      next_reconcile_at: Date | null;
    }>("SELECT needs_upgrade, next_reconcile_at FROM agents WHERE id = $1", [
      agentId,
    ]);
    expect(row.rows[0]?.needs_upgrade).toBe(true);
    expect(row.rows[0]?.next_reconcile_at).toBeTruthy();
  });

  it("blocks runtime upgrade endpoint for non-admin users", async () => {
    const orgId = await getDefaultOrgId();
    const memberEmail = "runtime-member@mines.edu";
    await createTestUser(orgId, memberEmail, "Runtime Member", "member");

    const response = await request(app)
      .post("/api/agents/runtime/upgrade")
      .set("X-Test-User-Email", memberEmail)
      .send({});
    expect(response.status).toBe(403);
  });

  it("requires explicit confirmation when machine change has upgrade risk", async () => {
    const created = await request(app).post("/api/agents").send({
      name: "Risky Agent",
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;

    await getTestPool().query(
      `UPDATE agents
       SET upgrade_risk_detected = true,
           upgrade_risk_message = 'sudo apt install detected'
       WHERE id = $1`,
      [agentId],
    );

    const blocked = await request(app).put(`/api/agents/${agentId}`).send({
      machine_type: "n1-standard-4",
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("upgrade_risk_confirmation_required");
    expect(blocked.body.upgrade_risk_message).toContain("sudo apt");

    const allowed = await request(app).put(`/api/agents/${agentId}`).send({
      machine_type: "n1-standard-4",
      confirm_upgrade_risk: true,
    });
    expect(allowed.status).toBe(200);
  });

  it("marks agent as starting immediately when machine type changes", async () => {
    const created = await request(app).post("/api/agents").send({
      name: "Machine Switch Agent",
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;

    await getTestPool().query(
      `UPDATE agents
       SET observed_vm_state = 'running',
           desired_vm_state = 'running'
       WHERE id = $1`,
      [agentId],
    );

    const updated = await request(app).put(`/api/agents/${agentId}`).send({
      machine_type: "n1-standard-4",
    });

    expect(updated.status).toBe(200);
    expect(updated.body.agent.machine_type).toBe("n1-standard-4");
    expect(updated.body.agent.vm_status).toBe("starting");

    const row = await getTestPool().query(
      `SELECT observed_vm_state, desired_vm_state
       FROM agents
       WHERE id = $1`,
      [agentId],
    );
    expect(row.rows[0]?.observed_vm_state).toBe("starting");
    expect(row.rows[0]?.desired_vm_state).toBe("running");
  });

  it("rejects unsupported machine type updates", async () => {
    const created = await request(app).post("/api/agents").send({
      name: "Invalid Machine Type Agent",
    });
    expect(created.status).toBe(201);
    const agentId = created.body.agent.id as string;

    const response = await request(app).put(`/api/agents/${agentId}`).send({
      machine_type: "totally-not-a-real-machine",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Unsupported machine type");
    expect(Array.isArray(response.body.supported_machine_types)).toBe(true);
    expect(response.body.supported_machine_types).toContain("e2-medium");
    expect(response.body.supported_machine_types).toContain("a2-highgpu-1g");
    expect(response.body.supported_machine_types).toContain("a2-highgpu-8g");
  });
});
