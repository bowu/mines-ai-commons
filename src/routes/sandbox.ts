import { type Request, type Response, Router } from "express";
import { requireAuthContext } from "../middleware/auth.js";
import { requireAgentAccess } from "../services/auth/acl.js";
import {
  SandboxNotReadyError,
  ensureSandbox,
} from "../services/sandbox/client.js";

const router = Router();

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

router.post(
  "/:agentId/ensure",
  requireAgentAccess("viewer"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const touchActivity = req.body?.touchActivity === true;
      const ensured = await ensureSandbox(orgId, agentId, { touchActivity });
      if (ensured.status === "starting") {
        return res.status(503).json({
          status: "starting",
          reason: ensured.reason,
          retryAfterMs: ensured.retryAfterMs,
        });
      }
      return res.json({ status: "ready" });
    } catch (error) {
      if (error instanceof SandboxNotReadyError) {
        return res.status(error.statusCode).json({
          status: "starting",
          reason: error.reason,
          retryAfterMs: error.retryAfterMs,
        });
      }
      if (error instanceof Error && error.message === "Agent not found") {
        return res.status(404).json({ error: "Agent not found" });
      }
      console.error("Sandbox ensure error:", error);
      return res.status(500).json({ error: "Failed to ensure sandbox" });
    }
  },
);

export default router;
