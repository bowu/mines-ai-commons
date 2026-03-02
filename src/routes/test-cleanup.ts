/**
 * Test-only cleanup routes. Mounted exclusively when NODE_ENV === 'test'.
 *
 * These endpoints bypass per-agent ACL so the Playwright helpers can
 * reliably delete leftover [e2e] data regardless of agent_access state.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { withOrgContextQuery } from "../db/index.js";
import { requireAuthContext } from "../middleware/auth.js";
import { removeAgentDirs } from "../services/pi-agent/session.js";

const router = Router();

router.delete("/agents", async (req: Request, res: Response) => {
  const { orgId } = requireAuthContext(req);
  const result = await withOrgContextQuery<{ id: string }>(
    orgId,
    `DELETE FROM agents WHERE name LIKE '[e2e]%' RETURNING id`,
    [],
  );

  // Best-effort filesystem cleanup
  for (const row of result.rows) {
    try {
      await removeAgentDirs(orgId, row.id);
    } catch {
      // ignore — dir may not exist
    }
  }

  res.json({ deleted: result.rows.length });
});

router.delete("/skills", async (req: Request, res: Response) => {
  const { orgId } = requireAuthContext(req);
  const result = await withOrgContextQuery(
    orgId,
    `DELETE FROM skills WHERE name LIKE '[e2e]%' RETURNING id`,
    [],
  );
  res.json({ deleted: result.rows.length });
});

export default router;
