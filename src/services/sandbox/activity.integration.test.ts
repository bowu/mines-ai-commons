import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearCoreTables,
  closeTestPool,
  getDefaultOrgId,
  getTestPool,
} from "../../test/db-helper.js";
import { refreshStreamLease, touchActivityThrottled } from "./activity.js";

async function createAgent(): Promise<{ orgId: string; agentId: string }> {
  const orgId = await getDefaultOrgId();
  const agentId = randomUUID();
  await getTestPool().query(
    `INSERT INTO agents (
       id, org_id, name, description, icon, system_prompt,
       desired_vm_state, observed_vm_state
     )
     VALUES ($1, $2, 'Activity Agent', '', '🔬', '', 'running', 'running')`,
    [agentId, orgId],
  );
  return { orgId, agentId };
}

describe("sandbox activity integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("touchActivityThrottled refreshes stale last_activity_at", async () => {
    const { orgId, agentId } = await createAgent();
    await getTestPool().query(
      `UPDATE agents
       SET last_activity_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [agentId],
    );

    await touchActivityThrottled(orgId, agentId);

    const row = await getTestPool().query<{ fresh: boolean }>(
      `SELECT last_activity_at > NOW() - INTERVAL '2 seconds' AS fresh
       FROM agents
       WHERE id = $1`,
      [agentId],
    );
    expect(row.rows[0]?.fresh).toBe(true);
  });

  it("touchActivityThrottled does not rewrite a recently-touched row", async () => {
    const { orgId, agentId } = await createAgent();
    await getTestPool().query(
      `UPDATE agents
       SET last_activity_at = NOW() - INTERVAL '5 seconds'
       WHERE id = $1`,
      [agentId],
    );

    await touchActivityThrottled(orgId, agentId);

    const row = await getTestPool().query<{ stayed_old: boolean }>(
      `SELECT last_activity_at < NOW() - INTERVAL '1 second' AS stayed_old
       FROM agents
       WHERE id = $1`,
      [agentId],
    );
    expect(row.rows[0]?.stayed_old).toBe(true);
  });

  it("refreshStreamLease sets a future lease and updates last_activity_at", async () => {
    const { orgId, agentId } = await createAgent();

    await refreshStreamLease(orgId, agentId);

    const row = await getTestPool().query<{
      has_future_lease: boolean;
      fresh_activity: boolean;
    }>(
      `SELECT
         active_stream_lease_until > NOW() + INTERVAL '30 seconds' AS has_future_lease,
         last_activity_at > NOW() - INTERVAL '2 seconds' AS fresh_activity
       FROM agents
       WHERE id = $1`,
      [agentId],
    );
    expect(row.rows[0]?.has_future_lease).toBe(true);
    expect(row.rows[0]?.fresh_activity).toBe(true);
  });

  it("refreshStreamLease is monotonic and does not shorten an existing longer lease", async () => {
    const { orgId, agentId } = await createAgent();
    await getTestPool().query(
      `UPDATE agents
       SET active_stream_lease_until = NOW() + INTERVAL '10 minutes'
       WHERE id = $1`,
      [agentId],
    );

    await refreshStreamLease(orgId, agentId);

    const row = await getTestPool().query<{ still_long: boolean }>(
      `SELECT active_stream_lease_until > NOW() + INTERVAL '9 minutes' AS still_long
       FROM agents
       WHERE id = $1`,
      [agentId],
    );
    expect(row.rows[0]?.still_long).toBe(true);
  });
});
