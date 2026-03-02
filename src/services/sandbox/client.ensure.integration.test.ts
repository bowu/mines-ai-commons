import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCoreTables,
  closeTestPool,
  getDefaultOrgId,
  getTestPool,
} from "../../test/db-helper.js";
import { ensureSandbox } from "./client.js";
import * as reconciler from "./reconciler.js";

describe("ensureSandbox integration (reconciler mode)", () => {
  const nudgeSpy = vi
    .spyOn(reconciler, "nudgeReconcilerNow")
    .mockImplementation(() => {});

  beforeEach(async () => {
    nudgeSpy.mockClear();
    await clearCoreTables();
  });

  afterAll(async () => {
    nudgeSpy.mockRestore();
    await closeTestPool();
  });

  it("throws Agent not found for unknown agentId", async () => {
    const orgId = await getDefaultOrgId();

    await expect(ensureSandbox(orgId, randomUUID())).rejects.toThrow(
      "Agent not found",
    );
  });

  it("returns ready when observed_vm_state is running without touching activity by default", async () => {
    const orgId = await getDefaultOrgId();
    const agentId = randomUUID();

    await getTestPool().query(
      `INSERT INTO agents (
         id, org_id, name, description, icon, system_prompt,
         desired_vm_state, observed_vm_state, last_activity_at
       )
       VALUES (
         $1, $2, 'Ensure Running Agent', '', '🔬', '',
         'running', 'running', NOW() - INTERVAL '2 hours'
       )`,
      [agentId, orgId],
    );

    const before = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [agentId],
    );

    const result = await ensureSandbox(orgId, agentId);
    expect(result.status).toBe("ready");
    expect(nudgeSpy).not.toHaveBeenCalled();

    const after = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [agentId],
    );
    expect(after.rows[0]?.last_activity_at.getTime()).toBe(
      before.rows[0]?.last_activity_at.getTime(),
    );
  });

  it("touches activity when touchActivity is explicitly true", async () => {
    const orgId = await getDefaultOrgId();
    const agentId = randomUUID();

    await getTestPool().query(
      `INSERT INTO agents (
         id, org_id, name, description, icon, system_prompt,
         desired_vm_state, observed_vm_state, last_activity_at
       )
       VALUES (
         $1, $2, 'Ensure Running Agent', '', '🔬', '',
         'running', 'running', NOW() - INTERVAL '2 hours'
       )`,
      [agentId, orgId],
    );

    const before = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [agentId],
    );

    const result = await ensureSandbox(orgId, agentId, { touchActivity: true });
    expect(result.status).toBe("ready");

    const after = await getTestPool().query<{ last_activity_at: Date }>(
      "SELECT last_activity_at FROM agents WHERE id = $1",
      [agentId],
    );
    expect(after.rows[0]?.last_activity_at.getTime()).toBeGreaterThan(
      before.rows[0]?.last_activity_at.getTime() ?? 0,
    );
  });

  it("returns vm_starting for non-running observed state and sets desired intent", async () => {
    const orgId = await getDefaultOrgId();
    const agentId = randomUUID();

    await getTestPool().query(
      `INSERT INTO agents (
         id, org_id, name, description, icon, system_prompt,
         desired_vm_state, observed_vm_state
       )
       VALUES (
         $1, $2, 'Ensure Starting Agent', '', '🔬', '',
         'stopped', 'starting'
       )`,
      [agentId, orgId],
    );

    const result = await ensureSandbox(orgId, agentId);
    expect(result.status).toBe("starting");
    if (result.status === "starting") {
      expect(result.reason).toBe("vm_starting");
    }
    expect(nudgeSpy).toHaveBeenCalledTimes(1);

    const row = await getTestPool().query<{
      desired_vm_state: string;
      next_reconcile_at: Date | null;
    }>("SELECT desired_vm_state, next_reconcile_at FROM agents WHERE id = $1", [
      agentId,
    ]);
    expect(row.rows[0]?.desired_vm_state).toBe("running");
    expect(row.rows[0]?.next_reconcile_at).toBeTruthy();
  });

  it("returns vm_error_retrying when last_provision_error is set", async () => {
    const orgId = await getDefaultOrgId();
    const agentId = randomUUID();

    await getTestPool().query(
      `INSERT INTO agents (
         id, org_id, name, description, icon, system_prompt,
         desired_vm_state, observed_vm_state, last_provision_error
       )
       VALUES (
         $1, $2, 'Ensure Error Agent', '', '🔬', '',
         'stopped', 'stopped', 'quota exceeded'
       )`,
      [agentId, orgId],
    );

    const result = await ensureSandbox(orgId, agentId);
    expect(result.status).toBe("starting");
    if (result.status === "starting") {
      expect(result.reason).toBe("vm_error_retrying");
    }
    expect(nudgeSpy).toHaveBeenCalledTimes(1);
  });

  it("concurrent ensure calls keep desired_vm_state running", async () => {
    const orgId = await getDefaultOrgId();
    const agentId = randomUUID();

    await getTestPool().query(
      `INSERT INTO agents (
         id, org_id, name, description, icon, system_prompt,
         desired_vm_state, observed_vm_state
       )
       VALUES (
         $1, $2, 'Ensure Concurrent Agent', '', '🔬', '',
         'stopped', 'stopped'
       )`,
      [agentId, orgId],
    );

    const [r1, r2] = await Promise.all([
      ensureSandbox(orgId, agentId),
      ensureSandbox(orgId, agentId),
    ]);

    expect(r1.status).toBe("starting");
    expect(r2.status).toBe("starting");

    const row = await getTestPool().query<{ desired_vm_state: string }>(
      "SELECT desired_vm_state FROM agents WHERE id = $1",
      [agentId],
    );
    expect(row.rows[0]?.desired_vm_state).toBe("running");
  });
});
