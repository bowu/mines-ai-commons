import { type Request, type Response, Router } from "express";
import multer from "multer";
import { requireAuthContext } from "../middleware/auth.js";
import { requireAgentAccess } from "../services/auth/acl.js";
import {
  SandboxNotReadyError,
  deleteFile,
  listFiles,
  mkdir,
  move,
  readFile,
  stats,
  uploadFile,
} from "../services/sandbox/client.js";

const router = Router();

function getRouteParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function getQueryParam(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

function getBooleanQueryParam(value: unknown, defaultValue: boolean): boolean {
  const raw = getQueryParam(value).trim().toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return defaultValue;
}

function normalizeWorkspacePath(rawPath: string): string | null {
  if (!rawPath) return null;

  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw value when malformed percent encoding is present
  }

  let normalized = decoded
    .replace(/^file:\/\//i, "")
    .replace(/\\/g, "/")
    .replace(/^['"`(\[]+|['"`)\],;:]+$/g, "")
    .trim();

  if (!normalized) return null;

  const sandboxWorkspaceMarker = "/sandbox-workspace/";
  const markerIndex = normalized.lastIndexOf(sandboxWorkspaceMarker);
  if (markerIndex >= 0) {
    normalized = normalized.slice(markerIndex + sandboxWorkspaceMarker.length);
  }

  if (normalized.startsWith("/workspace/")) {
    normalized = normalized.slice("/workspace/".length);
  }

  normalized = normalized.replace(/^\/+/, "").replace(/^\.\/+/, "");
  if (!normalized) return null;
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  return normalized;
}

function handleSandboxError(error: unknown, res: Response): boolean {
  if (error instanceof SandboxNotReadyError) {
    res.status(error.statusCode).json({
      error: "Sandbox is starting",
      reason: error.reason,
      retryAfterMs: error.retryAfterMs,
    });
    return true;
  }
  if (error instanceof Error && error.message === "Agent not found") {
    res.status(404).json({ error: "Agent not found" });
    return true;
  }
  return false;
}

router.get(
  "/:agentId/files",
  requireAgentAccess("viewer"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const rawPath = getQueryParam(req.query.path);
      const normalizedPath = rawPath ? normalizeWorkspacePath(rawPath) : "";
      if (rawPath && !normalizedPath) {
        return res.status(400).json({ error: "Invalid path" });
      }
      const filePath = normalizedPath || undefined;
      const recursive = getBooleanQueryParam(req.query.recursive, true);
      const includeStats = getBooleanQueryParam(req.query.includeStats, false);
      const data = await listFiles(orgId, agentId, {
        path: filePath,
        recursive,
        includeStats,
      });
      res.json(data);
    } catch (error) {
      if (handleSandboxError(error, res)) return;
      console.error("List workspace files error:", error);
      res.status(500).json({ error: "Failed to list files" });
    }
  },
);

router.get(
  "/:agentId/stats",
  requireAgentAccess("viewer"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const data = await stats(orgId, agentId);
      res.json(data);
    } catch (error) {
      if (handleSandboxError(error, res)) return;
      console.error("Get workspace stats error:", error);
      res.status(500).json({ error: "Failed to get stats" });
    }
  },
);

router.get(
  "/:agentId/file",
  requireAgentAccess("viewer"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const rawPath = getQueryParam(req.query.path);
      const filePath = normalizeWorkspacePath(rawPath);
      if (!filePath) {
        return res.status(400).json({ error: "Path is required" });
      }

      const raw = req.query.raw === "true";
      const download = req.query.download === "true";
      const upstream = await readFile(orgId, agentId, filePath, {
        raw,
        download,
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        try {
          const payload = JSON.parse(text);
          return res.status(upstream.status).json(payload);
        } catch {
          return res.status(upstream.status).json({
            error: text || "Failed to read file",
          });
        }
      }

      if (raw || download) {
        const arrayBuffer = await upstream.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const contentType = upstream.headers.get("content-type");
        const contentLength = upstream.headers.get("content-length");
        const contentDisposition = upstream.headers.get("content-disposition");
        if (contentType) res.setHeader("Content-Type", contentType);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        if (contentDisposition) {
          res.setHeader("Content-Disposition", contentDisposition);
        }
        return res.send(buffer);
      }

      const data = await upstream.json();
      return res.json(data);
    } catch (error) {
      if (handleSandboxError(error, res)) return;
      console.error("Read workspace file error:", error);
      return res.status(500).json({ error: "Failed to read file" });
    }
  },
);

const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

router.post(
  "/:agentId/upload",
  requireAgentAccess("editor"),
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const file = (req as any).file;
      if (!file) {
        return res.status(400).json({ error: "No file provided" });
      }

      const formData = new FormData();
      const blob = new Blob([file.buffer], {
        type: file.mimetype || "application/octet-stream",
      });
      formData.append("file", blob, file.originalname);

      const pathValue = typeof req.body?.path === "string" ? req.body.path : "";
      if (pathValue) {
        formData.append("path", pathValue);
      }

      const result = await uploadFile(orgId, agentId, formData);
      return res.status(201).json(result);
    } catch (error) {
      if (handleSandboxError(error, res)) return;
      console.error("Upload workspace file error:", error);
      return res.status(500).json({ error: "Failed to upload file" });
    }
  },
);

router.post(
  "/:agentId/mkdir",
  requireAgentAccess("editor"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const dirPath = typeof req.body?.path === "string" ? req.body.path : "";
      if (!dirPath) {
        return res.status(400).json({ error: "Path is required" });
      }

      const result = await mkdir(orgId, agentId, dirPath);
      return res.status(201).json(result);
    } catch (error) {
      if (handleSandboxError(error, res)) return;
      console.error("Create workspace dir error:", error);
      return res.status(500).json({ error: "Failed to create directory" });
    }
  },
);

router.post(
  "/:agentId/move",
  requireAgentAccess("editor"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const fromPath = typeof req.body?.from === "string" ? req.body.from : "";
      const toDirPath = typeof req.body?.to === "string" ? req.body.to : "";
      if (!fromPath || !toDirPath) {
        return res.status(400).json({ error: "Both from and to are required" });
      }

      const result = await move(orgId, agentId, fromPath, toDirPath);
      return res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message) {
        if (error.message === "Destination already exists") {
          return res.status(409).json({ error: error.message });
        }
      }
      if (handleSandboxError(error, res)) return;
      console.error("Move workspace file error:", error);
      return res.status(500).json({ error: "Failed to move file" });
    }
  },
);

router.delete(
  "/:agentId/file",
  requireAgentAccess("editor"),
  async (req: Request, res: Response) => {
    try {
      const { orgId } = requireAuthContext(req);
      const agentId = getRouteParam(req.params.agentId);
      const filePath = getQueryParam(req.query.path);
      if (!filePath) {
        return res.status(400).json({ error: "Path is required" });
      }

      await deleteFile(orgId, agentId, filePath);
      return res.json({ deleted: true });
    } catch (error) {
      if (handleSandboxError(error, res)) return;
      console.error("Delete workspace file error:", error);
      return res.status(500).json({ error: "Failed to delete file" });
    }
  },
);

export default router;
