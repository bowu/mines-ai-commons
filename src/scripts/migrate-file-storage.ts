import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
const DATA_DIR = path.resolve(process.cwd(), "data");
const SKILLS_DIR = path.join(DATA_DIR, "skills");
const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function moveWithFallback(source: string, destination: string) {
  try {
    await fs.rename(source, destination);
    return;
  } catch (error: any) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }

  await fs.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  await fs.rm(source, { recursive: true, force: true });
}

async function planSkillMoves(
  defaultOrgId: string,
): Promise<Array<{ from: string; to: string }>> {
  if (!(await exists(SKILLS_DIR))) return [];

  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const moves: Array<{ from: string; to: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === defaultOrgId) continue;

    const sourceDir = path.join(SKILLS_DIR, entry.name);
    const targetDir = path.join(SKILLS_DIR, defaultOrgId, entry.name);

    const looksLikeOldSkillDir =
      (await exists(path.join(sourceDir, "SKILL.md"))) ||
      (await exists(path.join(sourceDir, "manifest.json"))) ||
      (await exists(path.join(sourceDir, "data-sources")));

    if (!looksLikeOldSkillDir) {
      continue;
    }

    if (await exists(targetDir)) {
      continue;
    }

    moves.push({ from: sourceDir, to: targetDir });
  }

  return moves;
}

async function planWorkspaceMoves(
  defaultOrgId: string,
  knownOrgIds: Set<string>,
): Promise<Array<{ from: string; to: string }>> {
  if (!(await exists(WORKSPACES_DIR))) return [];

  const entries = await fs.readdir(WORKSPACES_DIR, { withFileTypes: true });
  const moves: Array<{ from: string; to: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === defaultOrgId) continue;
    if (knownOrgIds.has(entry.name)) continue;

    const sourceDir = path.join(WORKSPACES_DIR, entry.name);
    const targetDir = path.join(WORKSPACES_DIR, defaultOrgId, entry.name);
    if (await exists(targetDir)) {
      continue;
    }

    moves.push({ from: sourceDir, to: targetDir });
  }

  return moves;
}

async function applyMoves(
  label: string,
  moves: Array<{ from: string; to: string }>,
  dryRun: boolean,
) {
  if (moves.length === 0) {
    console.log(`[${label}] nothing to migrate`);
    return;
  }

  for (const move of moves) {
    console.log(
      `${dryRun ? "[dry-run]" : "[move]"} ${move.from} -> ${move.to}`,
    );

    if (dryRun) continue;

    await fs.mkdir(path.dirname(move.to), { recursive: true });
    await moveWithFallback(move.from, move.to);
  }
}

async function main() {
  const dryRun = hasFlag("--dry-run");
  const pool = new Pool({ connectionString: config.databaseUrl });

  try {
    const orgsResult = await pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM organizations`,
    );

    const defaultOrg = orgsResult.rows.find(
      (row) => row.slug === config.defaultOrgSlug,
    );
    if (!defaultOrg) {
      throw new Error(
        `Default org '${config.defaultOrgSlug}' not found in organizations table`,
      );
    }

    const knownOrgIds = new Set(orgsResult.rows.map((row) => row.id));

    const skillMoves = await planSkillMoves(defaultOrg.id);
    const workspaceMoves = await planWorkspaceMoves(defaultOrg.id, knownOrgIds);

    await applyMoves("skills", skillMoves, dryRun);
    await applyMoves("workspaces", workspaceMoves, dryRun);

    console.log(
      `Completed file storage migration (${dryRun ? "dry-run" : "apply"}).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
