import { type Request, type Response, Router } from "express";
import multer from "multer";
import { withOrgContextQuery } from "../db/index.js";
import { requireAuthContext } from "../middleware/auth.js";
import { invalidateSession } from "../services/pi-agent/session.js";
import {
  type SkillRecord,
  type UploadedSkillFile,
  installSkillPackage,
  listSkillSourceFiles,
  removeSkillSourcePackage,
  syncSkillSourcePackage,
  uninstallSkillPackage,
} from "../services/skills/packages.js";

const router = Router();

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 20 },
});

function getUploadedFiles(req: Request): UploadedSkillFile[] {
  const files = (req as any).files;
  if (!Array.isArray(files)) return [];
  return files
    .filter(
      (file) =>
        file &&
        typeof file.originalname === "string" &&
        Buffer.isBuffer(file.buffer),
    )
    .map((file) => ({
      originalname: file.originalname as string,
      buffer: file.buffer as Buffer,
    }));
}

async function syncInstalledSkillCopies(
  orgId: string,
  skill: SkillRecord,
): Promise<void> {
  const installsResult = await withOrgContextQuery(
    orgId,
    `SELECT agent_id, install_path
     FROM agent_skills
     WHERE skill_id = $1
       AND installed = true`,
    [skill.id],
  );

  for (const row of installsResult.rows) {
    const agentId = row.agent_id as string;
    const previousInstallPath = row.install_path as string | null;
    if (previousInstallPath) {
      await uninstallSkillPackage(orgId, agentId, previousInstallPath);
    }
    const { installPath } = await installSkillPackage(orgId, agentId, skill);
    await withOrgContextQuery(
      orgId,
      `UPDATE agent_skills
       SET install_path = $3,
           installed_at = NOW()
       WHERE agent_id = $1
         AND skill_id = $2`,
      [agentId, skill.id, installPath],
    );
    invalidateSession(orgId, agentId);
  }
}

// List all skills
router.get("/", async (_req: Request, res: Response) => {
  try {
    const { orgId } = requireAuthContext(_req);
    const result = await withOrgContextQuery(
      orgId,
      "SELECT * FROM skills ORDER BY created_at ASC",
    );
    const skills = await Promise.all(
      result.rows.map(async (skill: any) => ({
        ...skill,
        data_source_files: await listSkillSourceFiles(orgId, skill.id),
      })),
    );
    res.json({ skills });
  } catch (error) {
    console.error("List skills error:", error);
    res.status(500).json({ error: "Failed to list skills" });
  }
});

// Get single skill
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { orgId } = requireAuthContext(req);
    const skillId = getRouteParam(req.params.id);
    const result = await withOrgContextQuery(
      orgId,
      "SELECT * FROM skills WHERE id = $1",
      [skillId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }
    const skill = result.rows[0];
    res.json({
      skill: {
        ...skill,
        data_source_files: await listSkillSourceFiles(orgId, skill.id),
      },
    });
  } catch (error) {
    console.error("Get skill error:", error);
    res.status(500).json({ error: "Failed to get skill" });
  }
});

// Create skill
router.post(
  "/",
  upload.array("files", 20),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const { name, description, when_to_use, instructions, tool_type } =
        req.body;
      const trimmedName = typeof name === "string" ? name.trim() : "";
      if (!trimmedName) {
        return res.status(400).json({ error: "Name is required" });
      }
      const normalizedToolType =
        typeof tool_type === "string" && tool_type.trim()
          ? tool_type.trim()
          : null;
      const result = await withOrgContextQuery(
        orgId,
        `INSERT INTO skills (org_id, name, description, when_to_use, instructions, tool_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
        [
          orgId,
          trimmedName,
          description || "",
          when_to_use || "",
          instructions || "",
          normalizedToolType,
        ],
      );
      const skill = result.rows[0] as SkillRecord;
      await syncSkillSourcePackage(orgId, skill, getUploadedFiles(req));
      const dataSourceFiles = await listSkillSourceFiles(orgId, skill.id);

      res.status(201).json({
        skill: {
          ...skill,
          data_source_files: dataSourceFiles,
        },
      });
    } catch (error) {
      console.error("Create skill error:", error);
      res.status(500).json({ error: "Failed to create skill" });
    }
  },
);

// Update skill
router.put(
  "/:id",
  upload.array("files", 20),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const { name, description, when_to_use, instructions, tool_type } =
        req.body;
      const hasToolType = Object.prototype.hasOwnProperty.call(
        req.body,
        "tool_type",
      );
      const normalizedToolType =
        typeof tool_type === "string" && tool_type.trim()
          ? tool_type.trim()
          : null;
      const result = await withOrgContextQuery(
        orgId,
        `UPDATE skills SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         when_to_use = COALESCE($3, when_to_use),
         instructions = COALESCE($4, instructions),
         tool_type = CASE WHEN $6::boolean THEN $5 ELSE tool_type END
       WHERE id = $7
       RETURNING *`,
        [
          name,
          description,
          when_to_use,
          instructions,
          normalizedToolType,
          hasToolType,
          getRouteParam(req.params.id),
        ],
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Skill not found" });
      }
      const skill = result.rows[0] as SkillRecord;
      await syncSkillSourcePackage(orgId, skill, getUploadedFiles(req));
      await syncInstalledSkillCopies(orgId, skill);
      const dataSourceFiles = await listSkillSourceFiles(orgId, skill.id);
      res.json({
        skill: {
          ...skill,
          data_source_files: dataSourceFiles,
        },
      });
    } catch (error) {
      console.error("Update skill error:", error);
      res.status(500).json({ error: "Failed to update skill" });
    }
  },
);

// Delete skill
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const { orgId } = requireAuthContext(req);
    const skillId = getRouteParam(req.params.id);
    const result = await withOrgContextQuery(
      orgId,
      "DELETE FROM skills WHERE id = $1 RETURNING id",
      [skillId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Skill not found" });
    }
    await removeSkillSourcePackage(orgId, skillId);
    res.json({ deleted: true });
  } catch (error) {
    console.error("Delete skill error:", error);
    res.status(500).json({ error: "Failed to delete skill" });
  }
});

export default router;
