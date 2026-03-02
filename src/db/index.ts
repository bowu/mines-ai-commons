import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { QueryResult, QueryResultRow } from "pg";
// @ts-ignore
import pg from "pg";
import { config } from "../config.js";
import { runMigrations } from "./migrate.js";
import { schema } from "./schema.js";

const { Pool } = pg;

function buildPool(connectionString: string) {
  return new Pool({
    connectionString,
    max: config.dbPoolMax,
    idleTimeoutMillis: config.dbPoolIdleTimeoutMs,
    connectionTimeoutMillis: config.dbPoolConnectionTimeoutMs,
  });
}

function attachPoolErrorLogging(name: string, candidate: any | null): void {
  if (!candidate) return;
  candidate.on("error", (error: unknown) => {
    // Keep the API alive across transient proxy/network disconnects.
    console.error(`[db] ${name} pool idle client error`, error);
  });
}

// Superuser/migration pool (DATABASE_URL)
export const pool = buildPool(config.databaseUrl);

// Tenant-scoped app pool (RLS applies if APP_DATABASE_URL is configured)
const appConnectionString = config.appDatabaseUrl || config.databaseUrl;
export const appPool = buildPool(appConnectionString);

// Optional privileged pools for later phases
export const vmInternalPool = config.vmInternalDatabaseUrl
  ? buildPool(config.vmInternalDatabaseUrl)
  : null;

export const authBootstrapPool = config.authBootstrapDatabaseUrl
  ? buildPool(config.authBootstrapDatabaseUrl)
  : null;

attachPoolErrorLogging("pool", pool);
attachPoolErrorLogging("appPool", appPool);
attachPoolErrorLogging("vmInternalPool", vmInternalPool);
attachPoolErrorLogging("authBootstrapPool", authBootstrapPool);

export const db = drizzle(appPool, { schema });
export type Db = typeof db;
export type OrgDbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function query(text: string, params?: any[]) {
  const client = await appPool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

export async function withOrgContext<T>(
  orgId: string,
  fn: (tx: OrgDbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.current_org_id', ${orgId}, true)`,
    );
    return fn(tx);
  });
}

export async function withOrgContextQuery<
  T extends QueryResultRow = QueryResultRow,
>(
  orgId: string,
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [
      orgId,
    ]);
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result as QueryResult<T>;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function authBootstrapQuery<
  T extends QueryResultRow = QueryResultRow,
>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
  const activePool = authBootstrapPool ?? pool;
  const client = await activePool.connect();
  try {
    const result = await client.query(text, params);
    return result as QueryResult<T>;
  } finally {
    client.release();
  }
}

export async function initDatabase() {
  await runMigrations(config.databaseUrl);
}

export async function closePools() {
  const pools = [pool, appPool, vmInternalPool, authBootstrapPool];
  await Promise.allSettled(
    pools
      .filter((candidate) => candidate !== null)
      .map((candidate) => candidate?.end()),
  );
}
