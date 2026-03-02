import path from "path";
import fs from "fs/promises";
import { getWorkspaceDir } from "../pi-agent/session.js";

const DATA_DIR = path.resolve(process.cwd(), "data");
const SKILLS_LIBRARY_DIR = path.join(DATA_DIR, "skills");
const SKILL_FILES_DIRNAME = "data-sources";

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  when_to_use?: string | null;
  instructions?: string | null;
  tool_type?: string | null;
};

export type UploadedSkillFile = {
  originalname: string;
  buffer: Buffer;
};

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "skill"
  );
}

function buildPackageDirName(skill: SkillRecord): string {
  return `${slugify(skill.name)}-${skill.id.slice(0, 8)}`;
}

function normalizeRelative(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

function getSkillSourceDir(orgId: string, skillId: string): string {
  return path.join(SKILLS_LIBRARY_DIR, orgId, skillId);
}

function getSkillDataSourcesDir(orgId: string, skillId: string): string {
  return path.join(getSkillSourceDir(orgId, skillId), SKILL_FILES_DIRNAME);
}

function resolveWorkspacePath(workspaceDir: string, relPath: string): string {
  const normalized = path.normalize(relPath);
  if (!normalized || normalized === "." || path.isAbsolute(normalized)) {
    throw new Error("Invalid install path");
  }
  const resolved = path.resolve(workspaceDir, normalized);
  const root = path.resolve(workspaceDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Install path is outside workspace");
  }
  return resolved;
}

function sanitizeFileName(name: string): string {
  const base = path
    .basename(name || "")
    .replace(/[^\w.\- ()]/g, "_")
    .trim();
  if (!base || base === "." || base === "..") {
    return "file";
  }
  return base;
}

async function writeUploadedFiles(
  orgId: string,
  skillId: string,
  files: UploadedSkillFile[],
): Promise<void> {
  if (files.length === 0) return;

  const dataSourcesDir = getSkillDataSourcesDir(orgId, skillId);
  await fs.mkdir(dataSourcesDir, { recursive: true });

  for (const file of files) {
    const ext = path.extname(file.originalname || "");
    const stem =
      path.basename(sanitizeFileName(file.originalname), ext) || "file";
    const safeExt = ext.replace(/[^\w.]/g, "");
    let candidate = `${stem}${safeExt}`;
    let attempt = 1;

    // Avoid accidental overwrites when users upload duplicate file names.
    // Keep the first file as-is and suffix subsequent collisions.
    while (true) {
      const destination = path.join(dataSourcesDir, candidate);
      try {
        await fs.access(destination);
        candidate = `${stem}-${attempt}${safeExt}`;
        attempt += 1;
      } catch {
        await fs.writeFile(destination, file.buffer);
        break;
      }
    }
  }
}

async function listDataSourceFiles(
  orgId: string,
  skillId: string,
): Promise<string[]> {
  const dataSourcesDir = getSkillDataSourcesDir(orgId, skillId);
  try {
    const entries = await fs.readdir(dataSourcesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function buildSkillMarkdown(
  skill: SkillRecord,
  dataSourceFiles: string[] = [],
): string {
  const whenToUse = (skill.when_to_use || "").trim();
  const instructions = (skill.instructions || "").trim();
  const description = (skill.description || "").trim();
  const toolType = skill.tool_type || "none";
  const dataSourcesSection =
    dataSourceFiles.length > 0
      ? dataSourceFiles
          .map((file) => `- ${SKILL_FILES_DIRNAME}/${file}`)
          .join("\n")
      : "_No attached data source files._";

  return `---
name: ${skill.name}
description: ${description || "No description"}
metadata:
  source: mines-ai
  skill_id: ${skill.id}
  tool_type: ${toolType}
  data_source_count: ${dataSourceFiles.length}
---

# ${skill.name}

## Description
${description || "No description provided."}

## When To Use
${whenToUse || "Use this skill when relevant to the user request."}

## Instructions
${instructions || "Follow general research best practices and cite sources."}

## Data Sources
${dataSourcesSection}
`;
}

async function writeManifest(
  destinationDir: string,
  skill: SkillRecord,
  dataSourceFiles: string[],
  extraFields?: Record<string, unknown>,
): Promise<void> {
  const manifestPath = path.join(destinationDir, "manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        id: skill.id,
        name: skill.name,
        description: skill.description || "",
        tool_type: skill.tool_type || null,
        data_source_files: dataSourceFiles,
        data_source_count: dataSourceFiles.length,
        updated_at: new Date().toISOString(),
        ...(extraFields || {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function copyDirectoryRecursive(
  sourceDir: string,
  destinationDir: string,
): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourcePath, destinationPath);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }
}

export async function syncSkillSourcePackage(
  orgId: string,
  skill: SkillRecord,
  uploadedFiles: UploadedSkillFile[] = [],
): Promise<void> {
  const sourceDir = getSkillSourceDir(orgId, skill.id);
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(getSkillDataSourcesDir(orgId, skill.id), { recursive: true });

  if (uploadedFiles.length > 0) {
    await writeUploadedFiles(orgId, skill.id, uploadedFiles);
  }

  const dataSourceFiles = await listDataSourceFiles(orgId, skill.id);
  const skillMdPath = path.join(sourceDir, "SKILL.md");
  await fs.writeFile(
    skillMdPath,
    buildSkillMarkdown(skill, dataSourceFiles),
    "utf-8",
  );
  await writeManifest(sourceDir, skill, dataSourceFiles, {
    source: "skill-library",
  });
}

export async function installSkillPackage(
  orgId: string,
  agentId: string,
  skill: SkillRecord,
): Promise<{
  installPath: string;
}> {
  const workspaceDir = getWorkspaceDir(orgId, agentId);
  const packageDirName = buildPackageDirName(skill);
  const relativeInstallPath = normalizeRelative(
    path.join("skills", packageDirName),
  );
  const fullInstallPath = resolveWorkspacePath(
    workspaceDir,
    relativeInstallPath,
  );
  const sourceDir = getSkillSourceDir(orgId, skill.id);

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(SKILLS_LIBRARY_DIR, { recursive: true });

  try {
    await fs.access(path.join(sourceDir, "SKILL.md"));
  } catch {
    await syncSkillSourcePackage(orgId, skill);
  }

  await fs.rm(fullInstallPath, { recursive: true, force: true });
  await copyDirectoryRecursive(sourceDir, fullInstallPath);
  const dataSourceFiles = await listDataSourceFiles(orgId, skill.id);
  await writeManifest(fullInstallPath, skill, dataSourceFiles, {
    source: "installed-skill-package",
    installed_at: new Date().toISOString(),
    install_path: relativeInstallPath,
  });

  return { installPath: relativeInstallPath };
}

export async function uninstallSkillPackage(
  orgId: string,
  agentId: string,
  installPath?: string | null,
): Promise<void> {
  if (!installPath) {
    return;
  }
  const workspaceDir = getWorkspaceDir(orgId, agentId);
  const fullInstallPath = resolveWorkspacePath(workspaceDir, installPath);
  await fs.rm(fullInstallPath, { recursive: true, force: true });
}

export async function removeSkillSourcePackage(
  orgId: string,
  skillId: string,
): Promise<void> {
  await fs.rm(getSkillSourceDir(orgId, skillId), {
    recursive: true,
    force: true,
  });
}

export async function listSkillSourceFiles(
  orgId: string,
  skillId: string,
): Promise<string[]> {
  return listDataSourceFiles(orgId, skillId);
}

export async function readInstalledSkillMarkdown(
  orgId: string,
  agentId: string,
  installPath?: string | null,
): Promise<string | null> {
  if (!installPath) {
    return null;
  }
  try {
    const workspaceDir = getWorkspaceDir(orgId, agentId);
    const fullInstallPath = resolveWorkspacePath(workspaceDir, installPath);
    const skillMdPath = path.join(fullInstallPath, "SKILL.md");
    const markdown = await fs.readFile(skillMdPath, "utf-8");
    return markdown.trim();
  } catch {
    return null;
  }
}
