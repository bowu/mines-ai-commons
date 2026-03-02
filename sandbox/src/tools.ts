import fs from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { jailPath, sanitizeRelativePath } from "./path-utils.js";

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}

interface SandboxToolContext {
  agentId: string;
  apiBaseUrl: string;
  getVmToken: () => string | null;
  ensureVmToken?: () => Promise<string | null>;
  refreshVmToken?: () => Promise<string | null>;
  getActiveGoalId?: () => string | null;
  completeGoal?: (options: {
    goalId: string;
  }) => Promise<
    | { ok: true; goal?: unknown }
    | { ok: false; error: string; statusCode?: number }
  >;
}

const WORKSPACE_ROOT = path.resolve(
  process.env.SANDBOX_WORKSPACE_DIR || "/workspace",
);

function internalHeaders(ctx: SandboxToolContext): HeadersInit {
  const token = ctx.getVmToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function maybeEnsureVmToken(ctx: SandboxToolContext): Promise<void> {
  if (ctx.getVmToken()) return;
  await ctx.ensureVmToken?.();
}

async function maybeRefreshVmToken(ctx: SandboxToolContext): Promise<void> {
  await ctx.refreshVmToken?.();
}

async function internalFetchWithVmAuth(
  ctx: SandboxToolContext,
  url: string,
  init: RequestInit,
): Promise<globalThis.Response> {
  await maybeEnsureVmToken(ctx);

  let res = await fetch(url, {
    ...init,
    headers: internalHeaders(ctx),
  });

  if (res.status === 401) {
    await maybeRefreshVmToken(ctx);
    res = await fetch(url, {
      ...init,
      headers: internalHeaders(ctx),
    });
  }

  return res;
}

function resolveWorkspacePath(
  rawPath: unknown,
): { workspacePath: string; fullPath: string } | { error: string } {
  try {
    const workspacePath = sanitizeRelativePath(String(rawPath || ""));
    const fullPath = jailPath(WORKSPACE_ROOT, workspacePath);
    return { workspacePath, fullPath };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid file path",
    };
  }
}

function createWebSearchTool(ctx: SandboxToolContext): ToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web for current information and recent publications.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      count: Type.Optional(Type.Number({ description: "Number of results" })),
      country: Type.Optional(Type.String({ description: "Country code" })),
      search_lang: Type.Optional(
        Type.String({ description: "Search language" }),
      ),
      ui_lang: Type.Optional(Type.String({ description: "UI language" })),
      freshness: Type.Optional(
        Type.String({ description: "Freshness filter" }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const res = await internalFetchWithVmAuth(
          ctx,
          `${ctx.apiBaseUrl}/api/internal/agents/${ctx.agentId}/brave/search`,
          {
            method: "POST",
            body: JSON.stringify(params || {}),
          },
        );
        if (!res.ok) {
          const text = await res.text();
          return jsonResult({ error: `Web search failed: ${text}` });
        }
        return jsonResult(await res.json());
      } catch (error) {
        return jsonResult({
          error: `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

function createReadDocxTool(): ToolDefinition {
  return {
    name: "read_docx",
    label: "Read Word Document",
    description:
      "Read and extract text content from a Word (.docx) file in the workspace.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the .docx file relative to workspace root",
      }),
    }),
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const resolved = resolveWorkspacePath(p.path);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      try {
        await fs.access(resolved.fullPath);
      } catch {
        return jsonResult({ error: `File not found: ${String(p.path || "")}` });
      }

      try {
        const mammoth = await import("mammoth");
        const buffer = await fs.readFile(resolved.fullPath);
        const result = await mammoth.extractRawText({ buffer });
        return {
          content: [
            {
              type: "text" as const,
              text: result.value || "(No text content found in document)",
            },
          ],
          details: { path: resolved.workspacePath, extracted: true },
        };
      } catch (error) {
        return jsonResult({
          error: `Failed to read Word file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

function createWriteDocxTool(): ToolDefinition {
  return {
    name: "create_docx",
    label: "Create Word Document",
    description:
      "Create a Word (.docx) file from markdown content using pandoc.",
    parameters: Type.Object({
      path: Type.String({
        description: 'Output path (e.g. "report.docx") relative to workspace',
      }),
      markdown: Type.String({ description: "Markdown content" }),
    }),
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const resolved = resolveWorkspacePath(p.path);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      const markdown = String(p.markdown || "");
      if (!markdown.trim()) {
        return jsonResult({ error: "Markdown content is required" });
      }

      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const os = await import("node:os");
        const crypto = await import("node:crypto");
        const execFileAsync = promisify(execFile);

        const tmpId = crypto.randomBytes(8).toString("hex");
        const tmpMd = path.join(os.tmpdir(), `sandbox-docx-${tmpId}.md`);
        const tmpDocx = path.join(os.tmpdir(), `sandbox-docx-${tmpId}.docx`);

        await fs.writeFile(tmpMd, markdown, "utf-8");
        try {
          await execFileAsync(
            "pandoc",
            [
              tmpMd,
              "-o",
              tmpDocx,
              "--from",
              "markdown+tex_math_dollars",
              "--standalone",
              "--resource-path",
              WORKSPACE_ROOT,
            ],
            { timeout: 30_000 },
          );

          const buffer = await fs.readFile(tmpDocx);
          await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
          await fs.writeFile(resolved.fullPath, buffer);

          return jsonResult({
            path: resolved.workspacePath,
            size: buffer.length,
            created: true,
          });
        } finally {
          await fs.unlink(tmpMd).catch(() => {});
          await fs.unlink(tmpDocx).catch(() => {});
        }
      } catch (error) {
        return jsonResult({
          error: `Failed to create Word file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

function createReadXlsxTool(): ToolDefinition {
  return {
    name: "read_xlsx",
    label: "Read Excel Spreadsheet",
    description:
      "Read and extract data from an Excel (.xlsx) file in the workspace.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the .xlsx file relative to workspace root",
      }),
      sheet: Type.Optional(Type.String({ description: "Sheet name" })),
      max_rows: Type.Optional(
        Type.Number({ description: "Maximum rows to read (default 200)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const resolved = resolveWorkspacePath(p.path);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      try {
        await fs.access(resolved.fullPath);
      } catch {
        return jsonResult({ error: `File not found: ${String(p.path || "")}` });
      }

      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(resolved.fullPath);

        const sheetNames = workbook.worksheets.map((ws) => ws.name);
        const targetSheet =
          typeof p.sheet === "string" && p.sheet
            ? workbook.getWorksheet(p.sheet)
            : workbook.worksheets[0];

        if (!targetSheet) {
          return jsonResult({
            error: `Sheet not found. Available: ${sheetNames.join(", ")}`,
          });
        }

        const maxRows = Math.min(Number(p.max_rows) || 200, 1000);
        const rows: string[] = [];
        let rowCount = 0;

        targetSheet.eachRow({ includeEmpty: false }, (row) => {
          if (rowCount >= maxRows) return;
          const cells = row.values as unknown[];
          const values = cells.slice(1).map((v) => {
            if (v === null || v === undefined) return "";
            if (
              typeof v === "object" &&
              v !== null &&
              "result" in (v as Record<string, unknown>)
            ) {
              return String((v as { result?: unknown }).result ?? "");
            }
            if (
              typeof v === "object" &&
              v !== null &&
              "text" in (v as Record<string, unknown>)
            ) {
              return String((v as { text?: unknown }).text ?? "");
            }
            return String(v);
          });
          rows.push(values.join("\t"));
          rowCount += 1;
        });

        const totalRows = targetSheet.rowCount;
        let text = `Sheet: ${targetSheet.name} (${totalRows} rows)\n`;
        text += `Sheets in workbook: ${sheetNames.join(", ")}\n\n`;
        text += rows.join("\n");
        if (totalRows > maxRows) {
          text += `\n\n[... ${totalRows - maxRows} more rows not shown]`;
        }

        return {
          content: [{ type: "text" as const, text }],
          details: {
            path: resolved.workspacePath,
            sheet: targetSheet.name,
            rowCount: totalRows,
          },
        };
      } catch (error) {
        return jsonResult({
          error: `Failed to read Excel file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

function createWriteXlsxTool(): ToolDefinition {
  return {
    name: "create_xlsx",
    label: "Create Excel Spreadsheet",
    description: "Create an Excel (.xlsx) file in the workspace.",
    parameters: Type.Object({
      path: Type.String({
        description: 'Output path (e.g. "data.xlsx") relative to workspace',
      }),
      sheet_name: Type.Optional(Type.String({ description: "Sheet name" })),
      headers: Type.Array(Type.String(), {
        description: "Column header names",
      }),
      rows: Type.Array(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Number(),
            Type.Boolean(),
            Type.Null(),
          ]),
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as {
        path?: unknown;
        sheet_name?: unknown;
        headers?: unknown;
        rows?: unknown;
      };
      const resolved = resolveWorkspacePath(p.path);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      const headers = Array.isArray(p.headers) ? p.headers.map(String) : [];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      if (headers.length === 0) {
        return jsonResult({ error: "Headers are required" });
      }

      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        const sheet = workbook.addWorksheet(
          typeof p.sheet_name === "string" && p.sheet_name
            ? p.sheet_name
            : "Sheet1",
        );

        const headerRow = sheet.addRow(headers);
        headerRow.font = { bold: true };

        for (const row of rows) {
          if (Array.isArray(row)) {
            sheet.addRow(row as Array<string | number | boolean | null>);
          }
        }

        sheet.columns.forEach((col) => {
          let maxLen = 10;
          col.eachCell?.({ includeEmpty: false }, (cell) => {
            const len = String(cell.value || "").length;
            if (len > maxLen) maxLen = len;
          });
          col.width = Math.min(maxLen + 2, 50);
        });

        await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
        await workbook.xlsx.writeFile(resolved.fullPath);

        const stat = await fs.stat(resolved.fullPath);
        return jsonResult({
          path: resolved.workspacePath,
          size: stat.size,
          headers: headers.length,
          rows: rows.length,
          created: true,
        });
      } catch (error) {
        return jsonResult({
          error: `Failed to create Excel file: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

function formatBullets(
  text: string,
): Array<{ text: string; options: unknown }> {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const isBullet = line.trimStart().startsWith("- ");
      return {
        text: isBullet ? line.trimStart().slice(2) : line,
        options: isBullet ? { bullet: true, indentLevel: 0 } : {},
      };
    });
}

function createWritePptxTool(): ToolDefinition {
  return {
    name: "create_pptx",
    label: "Create PowerPoint Presentation",
    description: "Create a PowerPoint (.pptx) presentation.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Output path for the .pptx file (e.g. "presentation.pptx")',
      }),
      title: Type.Optional(Type.String({ description: "Presentation title" })),
      author: Type.Optional(Type.String({ description: "Author name" })),
      slides: Type.Array(
        Type.Object({
          layout: Type.Optional(
            Type.String({
              description:
                'Slide layout: "title", "content", "section", "two_column", "blank"',
            }),
          ),
          title: Type.Optional(Type.String()),
          subtitle: Type.Optional(Type.String()),
          body: Type.Optional(Type.String()),
          body_right: Type.Optional(Type.String()),
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as {
        path?: unknown;
        title?: unknown;
        author?: unknown;
        slides?: unknown;
      };
      const resolved = resolveWorkspacePath(p.path);
      if ("error" in resolved) return jsonResult({ error: resolved.error });

      const slides = Array.isArray(p.slides) ? p.slides : [];
      if (slides.length === 0) {
        return jsonResult({ error: "At least one slide is required" });
      }

      try {
        const PptxGenJSImport = await import("pptxgenjs");
        const PptxGenJS = PptxGenJSImport.default as any;
        const pptx = new PptxGenJS();

        if (typeof p.title === "string" && p.title) pptx.title = p.title;
        if (typeof p.author === "string" && p.author) pptx.author = p.author;
        pptx.layout = "LAYOUT_WIDE";

        const COLOR_PRIMARY = "1F4E79";
        const COLOR_ACCENT = "C5B358";
        const COLOR_TEXT = "333333";
        const COLOR_LIGHT = "F2F2F2";

        for (const rawSlide of slides) {
          const slideData = (rawSlide || {}) as Record<string, unknown>;
          const slide = pptx.addSlide();
          const layout = String(slideData.layout || "content");
          const title =
            typeof slideData.title === "string" ? slideData.title : "";
          const subtitle =
            typeof slideData.subtitle === "string" ? slideData.subtitle : "";
          const body = typeof slideData.body === "string" ? slideData.body : "";
          const bodyRight =
            typeof slideData.body_right === "string"
              ? slideData.body_right
              : "";

          if (layout === "title") {
            slide.background = { color: COLOR_PRIMARY };
            if (title) {
              slide.addText(title, {
                x: 0.8,
                y: 1.8,
                w: 11.7,
                h: 1.5,
                fontSize: 36,
                fontFace: "Arial",
                color: "FFFFFF",
                bold: true,
              });
            }
            if (subtitle) {
              slide.addText(subtitle, {
                x: 0.8,
                y: 3.5,
                w: 11.7,
                h: 1.0,
                fontSize: 20,
                fontFace: "Arial",
                color: COLOR_ACCENT,
              });
            }
          } else if (layout === "section") {
            slide.background = { color: COLOR_LIGHT };
            slide.addShape(pptx.ShapeType.rect, {
              x: 0,
              y: 0,
              w: 0.4,
              h: 7.5,
              fill: { color: COLOR_PRIMARY },
            });
            if (title) {
              slide.addText(title, {
                x: 0.8,
                y: 2.5,
                w: 11.7,
                h: 1.2,
                fontSize: 32,
                fontFace: "Arial",
                color: COLOR_PRIMARY,
                bold: true,
              });
            }
            if (subtitle) {
              slide.addText(subtitle, {
                x: 0.8,
                y: 3.8,
                w: 11.7,
                h: 1.0,
                fontSize: 18,
                fontFace: "Arial",
                color: COLOR_TEXT,
              });
            }
          } else if (layout === "two_column") {
            if (title) {
              slide.addText(title, {
                x: 0.5,
                y: 0.3,
                w: 12.3,
                h: 0.8,
                fontSize: 24,
                fontFace: "Arial",
                color: COLOR_PRIMARY,
                bold: true,
              });
              slide.addShape(pptx.ShapeType.rect, {
                x: 0.5,
                y: 1.1,
                w: 3,
                h: 0.04,
                fill: { color: COLOR_ACCENT },
              });
            }
            const bodyY = title ? 1.4 : 0.5;
            if (body) {
              slide.addText(formatBullets(body), {
                x: 0.5,
                y: bodyY,
                w: 5.8,
                h: 5.5,
                fontSize: 14,
                fontFace: "Arial",
                color: COLOR_TEXT,
                valign: "top",
              });
            }
            if (bodyRight) {
              slide.addText(formatBullets(bodyRight), {
                x: 6.8,
                y: bodyY,
                w: 5.8,
                h: 5.5,
                fontSize: 14,
                fontFace: "Arial",
                color: COLOR_TEXT,
                valign: "top",
              });
            }
          } else if (layout === "blank") {
            // no default content
          } else {
            if (title) {
              slide.addText(title, {
                x: 0.5,
                y: 0.3,
                w: 12.3,
                h: 0.8,
                fontSize: 24,
                fontFace: "Arial",
                color: COLOR_PRIMARY,
                bold: true,
              });
              slide.addShape(pptx.ShapeType.rect, {
                x: 0.5,
                y: 1.1,
                w: 3,
                h: 0.04,
                fill: { color: COLOR_ACCENT },
              });
            }
            const bodyY = title ? 1.4 : 0.5;
            if (body) {
              slide.addText(formatBullets(body), {
                x: 0.5,
                y: bodyY,
                w: 12.3,
                h: 5.5,
                fontSize: 16,
                fontFace: "Arial",
                color: COLOR_TEXT,
                valign: "top",
              });
            }
          }
        }

        await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
        await pptx.writeFile({ fileName: resolved.fullPath });

        const stat = await fs.stat(resolved.fullPath);
        return jsonResult({
          path: resolved.workspacePath,
          size: stat.size,
          slides: slides.length,
          created: true,
        });
      } catch (error) {
        return jsonResult({
          error: `Failed to create PowerPoint: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

function createCompleteGoalTool(ctx: SandboxToolContext): ToolDefinition {
  return {
    name: "complete_goal",
    label: "Complete Goal",
    description:
      "Mark the active goal as completed once you believe the goal is fully done. This tool takes no parameters.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params) {
      if (!ctx.getActiveGoalId || !ctx.completeGoal) {
        return jsonResult({
          ok: false,
          error: "Goal completion is not available in this session.",
        });
      }

      const goalId = ctx.getActiveGoalId();
      if (!goalId) {
        return jsonResult({
          ok: false,
          error: "No active goal is attached to the current run.",
        });
      }

      const result = await ctx.completeGoal({
        goalId,
      });
      if (!result.ok) {
        return jsonResult({
          ok: false,
          error: result.error,
          statusCode: result.statusCode,
        });
      }

      return jsonResult({
        ok: true,
        goalId,
        status: "completed",
      });
    },
  };
}

export function createSandboxTools(ctx: SandboxToolContext): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createReadDocxTool(),
    createWriteDocxTool(),
    createReadXlsxTool(),
    createWriteXlsxTool(),
    createWritePptxTool(),
    createWebSearchTool(ctx),
  ];

  if (ctx.getActiveGoalId && ctx.completeGoal) {
    tools.push(createCompleteGoalTool(ctx));
  }

  return tools;
}
