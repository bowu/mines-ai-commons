import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { schema } from "../db/schema.js";

const { Pool } = pg;

const defaultIntegrationDatabaseUrl =
  "postgresql://mines_ai:mines_ai_password@localhost:5435/mines_ai_integration";
const DEFAULT_TEST_EMAIL = "admin@mines.edu";
const DEFAULT_TEST_NAME = "Default Admin";

let testPool: pg.Pool | null = null;

export function getIntegrationDatabaseUrl(): string {
  return process.env.INTEGRATION_DATABASE_URL || defaultIntegrationDatabaseUrl;
}

export function getTestPool(): pg.Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: getIntegrationDatabaseUrl() });
  }
  return testPool;
}

export function getTestDb() {
  return drizzle(getTestPool(), { schema });
}

export async function cleanTable(tableName: string): Promise<void> {
  if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
    throw new Error(`Unsafe table name: ${tableName}`);
  }
  await getTestPool().query(`DELETE FROM "${tableName}"`);
}

export async function clearCoreTables(): Promise<void> {
  const orderedTables = [
    "agent_access",
    "agent_chat_messages",
    "agent_chat_sessions",
    "agent_skills",
    "users",
    "skills",
    "agents",
  ];

  for (const tableName of orderedTables) {
    await cleanTable(tableName);
  }

  await getTestPool().query(
    `DELETE FROM organizations
     WHERE slug <> 'mines'`,
  );

  const defaultOrgId = await getDefaultOrgId();
  await createTestUser(
    defaultOrgId,
    DEFAULT_TEST_EMAIL,
    DEFAULT_TEST_NAME,
    "admin",
  );
}

export async function getDefaultOrgId(): Promise<string> {
  const result = await getTestPool().query<{ id: string }>(
    `SELECT id
     FROM organizations
     WHERE slug = 'mines'
     LIMIT 1`,
  );

  const orgId = result.rows[0]?.id;
  if (!orgId) {
    throw new Error("Default org not found in integration database");
  }

  return orgId;
}

export async function createTestUser(
  orgId: string,
  email: string,
  name: string,
  role = "member",
): Promise<string> {
  const result = await getTestPool().query<{ id: string }>(
    `INSERT INTO users (org_id, email, name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ((LOWER(email)))
     DO UPDATE SET
       org_id = EXCLUDED.org_id,
       name = EXCLUDED.name,
       role = EXCLUDED.role
     RETURNING id`,
    [orgId, email.toLowerCase(), name, role],
  );

  const userId = result.rows[0]?.id;
  if (!userId) {
    throw new Error("Failed to create test user");
  }
  return userId;
}

export async function getDefaultUserId(): Promise<string> {
  const result = await getTestPool().query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE LOWER(email) = $1
     LIMIT 1`,
    [DEFAULT_TEST_EMAIL],
  );

  const userId = result.rows[0]?.id;
  if (!userId) {
    throw new Error("Default user not found in integration database");
  }

  return userId;
}

export async function closeTestPool(): Promise<void> {
  if (!testPool) return;
  await testPool.end();
  testPool = null;
}
