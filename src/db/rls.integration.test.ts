import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearCoreTables,
  closeTestPool,
  getDefaultOrgId,
  getTestPool,
} from "../test/db-helper.js";

async function appUserQuery<T extends QueryResultRow = QueryResultRow>(
  sqlText: string,
  params: unknown[] = [],
  orgId?: string,
) {
  const client = await getTestPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE app_user");
    if (orgId !== undefined) {
      await client.query("SELECT set_config('app.current_org_id', $1, true)", [
        orgId,
      ]);
    }
    const result = await client.query<T>(sqlText, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("RLS integration", () => {
  beforeEach(async () => {
    await clearCoreTables();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("isolates agents by org and fails closed without org context", async () => {
    const orgA = await getDefaultOrgId();
    const orgB = randomUUID();

    await getTestPool().query(
      `INSERT INTO organizations (id, name, slug, domain)
       VALUES ($1, 'Org B', 'org-b', 'org-b.edu')`,
      [orgB],
    );

    await getTestPool().query(
      `INSERT INTO agents (id, org_id, name)
       VALUES ($1, $2, 'Agent A'), ($3, $4, 'Agent B')`,
      [randomUUID(), orgA, randomUUID(), orgB],
    );

    const scopedRows = await appUserQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM agents`,
      [],
      orgA,
    );
    expect(scopedRows.rows[0]?.count).toBe("1");

    const failClosedRows = await appUserQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM agents`,
    );
    expect(failClosedRows.rows[0]?.count).toBe("0");
  });

  it("allows global skills and own-org skills only", async () => {
    const orgA = await getDefaultOrgId();
    const orgB = randomUUID();

    await getTestPool().query(
      `INSERT INTO organizations (id, name, slug, domain)
       VALUES ($1, 'Org B', 'org-b-skills', 'org-b-skills.edu')`,
      [orgB],
    );

    await getTestPool().query(
      `INSERT INTO skills (id, org_id, name)
       VALUES
         ($1, NULL, 'Global Skill'),
         ($2, $3, 'Org A Skill'),
         ($4, $5, 'Org B Skill')`,
      [randomUUID(), randomUUID(), orgA, randomUUID(), orgB],
    );

    const result = await appUserQuery<{ name: string }>(
      `SELECT name FROM skills ORDER BY name ASC`,
      [],
      orgA,
    );

    expect(result.rows.map((row) => row.name)).toEqual([
      "Global Skill",
      "Org A Skill",
    ]);
  });

  it("enforces join-scoped visibility for sessions and messages", async () => {
    const orgA = await getDefaultOrgId();
    const orgB = randomUUID();

    await getTestPool().query(
      `INSERT INTO organizations (id, name, slug, domain)
       VALUES ($1, 'Org B', 'org-b-chat', 'org-b-chat.edu')`,
      [orgB],
    );

    const agentA = randomUUID();
    const agentB = randomUUID();
    const sessionA = randomUUID();
    const sessionB = randomUUID();

    await getTestPool().query(
      `INSERT INTO agents (id, org_id, name)
       VALUES ($1, $2, 'Agent A'), ($3, $4, 'Agent B')`,
      [agentA, orgA, agentB, orgB],
    );

    await getTestPool().query(
      `INSERT INTO agent_chat_sessions (id, agent_id)
       VALUES ($1, $2), ($3, $4)`,
      [sessionA, agentA, sessionB, agentB],
    );

    await getTestPool().query(
      `INSERT INTO agent_chat_messages (id, session_id, role, content)
       VALUES
         ($1, $2, 'user', 'hello from org A'),
         ($3, $4, 'user', 'hello from org B')`,
      [randomUUID(), sessionA, randomUUID(), sessionB],
    );

    const sessionRows = await appUserQuery<{ id: string }>(
      `SELECT id FROM agent_chat_sessions ORDER BY id`,
      [],
      orgA,
    );
    expect(sessionRows.rows).toHaveLength(1);
    expect(sessionRows.rows[0]?.id).toBe(sessionA);

    const messageRows = await appUserQuery<{ content: string }>(
      `SELECT content FROM agent_chat_messages ORDER BY content`,
      [],
      orgA,
    );
    expect(messageRows.rows).toHaveLength(1);
    expect(messageRows.rows[0]?.content).toBe("hello from org A");
  });
});
