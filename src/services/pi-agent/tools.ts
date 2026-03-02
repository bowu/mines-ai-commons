/**
 * Custom tools for pi-coding-agent.
 * Follows the ToolDefinition interface from pi-coding-agent.
 */

import path from "path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "fs/promises";
import {
  performWebFetch,
  performWebSearch,
} from "../../services/web/web-tools.js";
import { getWorkspaceDir } from "./session.js";

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
    details: payload,
  };
}

/** Web search tool using Brave Search API */
export function createWebSearchTool(): ToolDefinition {
  return {
    name: "web_search",
    label: "Web Search",
    description:
      "Search the public web for current information and recent publications.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" }),
      count: Type.Optional(
        Type.Number({ description: "Number of results (1-10, default 5)" }),
      ),
      country: Type.Optional(
        Type.String({
          description: "2-letter country code (e.g. 'US', 'DE', 'ALL').",
        }),
      ),
      search_lang: Type.Optional(
        Type.String({ description: "Search language (e.g. 'en')." }),
      ),
      ui_lang: Type.Optional(
        Type.String({ description: "UI language (e.g. 'en')." }),
      ),
      freshness: Type.Optional(
        Type.String({
          description:
            "Freshness filter: 'pd', 'pw', 'pm', 'py', or 'YYYY-MM-DDtoYYYY-MM-DD'.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const p = params as any;
        const payload = await performWebSearch({
          query: String(p.query || ""),
          count: Number(p.count),
          country: typeof p.country === "string" ? p.country : undefined,
          searchLang:
            typeof p.search_lang === "string" ? p.search_lang : undefined,
          uiLang: typeof p.ui_lang === "string" ? p.ui_lang : undefined,
          freshness: typeof p.freshness === "string" ? p.freshness : undefined,
        });
        return jsonResult(payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Web search failed: ${message}` });
      }
    },
  };
}

/** Web fetch tool for reading page content from a URL */
export function createWebFetchTool(): ToolDefinition {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract readable text content from the page. Returns the page text directly for easy processing.",
    parameters: Type.Object({
      url: Type.String({ description: "HTTP/HTTPS URL to fetch." }),
      max_chars: Type.Optional(
        Type.Number({
          description: "Maximum characters in extracted text (500-100000).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const p = params as any;
        const payload = await performWebFetch({
          url: String(p.url || ""),
          maxChars: Number(p.max_chars),
        });
        // Return text directly as content so the agent can process it without JSON overhead
        const header = payload.title
          ? `# ${payload.title}\nSource: ${payload.finalUrl}\n\n`
          : `Source: ${payload.finalUrl}\n\n`;
        const footer = payload.truncated ? "\n\n[... content truncated]" : "";
        return {
          content: [
            { type: "text" as const, text: header + payload.text + footer },
          ],
          details: {
            url: payload.url,
            finalUrl: payload.finalUrl,
            title: payload.title,
            length: payload.length,
            truncated: payload.truncated,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Web fetch failed: ${message}` });
      }
    },
  };
}

// ==================== Document helpers ====================

/** Resolve and validate a workspace-relative path */
function resolveWorkspacePath(
  orgId: string,
  agentId: string,
  filePath: string,
): { fullPath: string; workspaceDir: string } | { error: string } {
  if (!filePath.trim()) return { error: "Path is required" };
  const workspaceDir = getWorkspaceDir(orgId, agentId);
  const normalized = path.normalize(filePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized))
    return { error: "Invalid path" };
  const fullPath = path.join(workspaceDir, normalized);
  if (!fullPath.startsWith(workspaceDir))
    return { error: "Path outside workspace" };
  return { fullPath, workspaceDir };
}

// ==================== PDF ====================

/** Extract text from a PDF file using pdfjs-dist */
async function extractPdfText(
  filePath: string,
  maxPagesInput = 20,
  maxCharsInput = 120_000,
): Promise<{
  text: string;
  pagesRead: number;
  totalPages: number;
  truncated: boolean;
}> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await pdfjsLib.getDocument({
    data,
    verbosity: pdfjsLib.VerbosityLevel.ERRORS,
  } as any).promise;

  const pages: string[] = [];
  const maxPages = Math.min(doc.numPages, Math.max(1, maxPagesInput)); // Cap pages
  const maxChars = Math.max(1_000, maxCharsInput);
  let charsUsed = 0;
  let truncated = false;
  let pagesRead = 0;

  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = textContent.items
      .map((item: any) => ("str" in item ? item.str : ""))
      .join(" ");
    if (text.trim()) {
      const block = `--- Page ${i} ---\n${text}`;
      const remaining = maxChars - charsUsed;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (block.length > remaining) {
        pages.push(
          `${block.slice(0, remaining)}\n\n[... output truncated due to max_chars limit ...]`,
        );
        charsUsed = maxChars;
        truncated = true;
        pagesRead = i;
        break;
      }
      pages.push(block);
      charsUsed += block.length;
    }
    pagesRead = i;
  }

  if (!truncated && doc.numPages > maxPages) {
    pages.push(`\n[... ${doc.numPages - maxPages} more pages not shown]`);
    truncated = true;
  }

  return {
    text: pages.join("\n\n") || "(No text content found in PDF)",
    pagesRead,
    totalPages: doc.numPages,
    truncated,
  };
}

/** Read PDF tool — extracts text content from PDF files in the workspace */
export function createReadPdfTool(
  orgId: string,
  agentId: string,
): ToolDefinition {
  return {
    name: "read_pdf",
    label: "Read PDF",
    description:
      "Read and extract text content from a PDF file in the workspace. Use this instead of read_file for .pdf files. Returns the text content of each page.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the PDF file relative to the workspace root",
      }),
      max_pages: Type.Optional(
        Type.Number({
          description: "Maximum pages to extract (default 20, max 100)",
        }),
      ),
      max_chars: Type.Optional(
        Type.Number({
          description:
            "Maximum characters to return (default 120000, min 1000)",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const resolved = resolveWorkspacePath(
        orgId,
        agentId,
        String((params as any).path || ""),
      );
      if ("error" in resolved) return jsonResult(resolved);

      try {
        await fs.access(resolved.fullPath);
      } catch {
        return jsonResult({ error: `File not found: ${(params as any).path}` });
      }

      try {
        const reqPages = Math.floor(Number((params as any).max_pages));
        const reqChars = Math.floor(Number((params as any).max_chars));
        const maxPages = Number.isFinite(reqPages)
          ? Math.min(Math.max(reqPages, 1), 100)
          : 20;
        const maxChars = Number.isFinite(reqChars)
          ? Math.max(reqChars, 1000)
          : 120_000;
        const result = await extractPdfText(
          resolved.fullPath,
          maxPages,
          maxChars,
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: {
            path: (params as any).path,
            extracted: true,
            pages_read: result.pagesRead,
            total_pages: result.totalPages,
            truncated: result.truncated,
            max_pages: maxPages,
            max_chars: maxChars,
          },
        };
      } catch (err) {
        return jsonResult({
          error: `Failed to read PDF: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  };
}

// ==================== Word (.docx) ====================

/** Read Word tool — extracts text from .docx files using mammoth */
export function createReadDocxTool(
  orgId: string,
  agentId: string,
): ToolDefinition {
  return {
    name: "read_docx",
    label: "Read Word Document",
    description:
      "Read and extract text content from a Word (.docx) file in the workspace. Use this instead of read_file for .docx files. Returns the document text.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the .docx file relative to the workspace root",
      }),
    }),
    async execute(_toolCallId, params) {
      const resolved = resolveWorkspacePath(
        orgId,
        agentId,
        String((params as any).path || ""),
      );
      if ("error" in resolved) return jsonResult(resolved);

      try {
        await fs.access(resolved.fullPath);
      } catch {
        return jsonResult({ error: `File not found: ${(params as any).path}` });
      }

      try {
        const mammoth = await import("mammoth");
        const buffer = await fs.readFile(resolved.fullPath);
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value || "(No text content found in document)";
        return {
          content: [{ type: "text" as const, text }],
          details: { path: (params as any).path, extracted: true },
        };
      } catch (err) {
        return jsonResult({
          error: `Failed to read Word file: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  };
}

/** Create Word tool — generates .docx files from markdown via pandoc */
export function createWriteDocxTool(
  orgId: string,
  agentId: string,
): ToolDefinition {
  return {
    name: "create_docx",
    label: "Create Word Document",
    description:
      "Create a Word (.docx) file from markdown content. Supports headings, bold, italic, lists, tables, code blocks, LaTeX math equations (both inline $...$ and display $$...$$), and images from the workspace. Uses pandoc for conversion.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Output path for the .docx file relative to workspace root (e.g. "report.docx")',
      }),
      markdown: Type.String({
        description:
          "The document content in markdown format. Supports headings (#), bold (**), italic (*), bullet lists (-), numbered lists (1.), tables (| col |), code blocks (```), horizontal rules (---), LaTeX math ($E=mc^2$ for inline, $$\\\\int_0^1 f(x)dx$$ for display), and images (![caption](path/to/image.png) — paths relative to workspace root).",
      }),
    }),
    async execute(_toolCallId, params) {
      const p = params as any;
      const resolved = resolveWorkspacePath(
        orgId,
        agentId,
        String(p.path || ""),
      );
      if ("error" in resolved) return jsonResult(resolved);

      const markdown = String(p.markdown || "");
      if (!markdown.trim()) {
        return jsonResult({ error: "Markdown content is required" });
      }

      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const os = await import("os");
        const crypto = await import("crypto");

        // Write markdown to a temp file, run pandoc, read the output
        const tmpId = crypto.randomBytes(8).toString("hex");
        const tmpMd = path.join(os.tmpdir(), `mines-docx-${tmpId}.md`);
        const tmpDocx = path.join(os.tmpdir(), `mines-docx-${tmpId}.docx`);

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
              resolved.workspaceDir,
            ],
            { timeout: 30000 },
          );

          const buffer = await fs.readFile(tmpDocx);
          await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
          await fs.writeFile(resolved.fullPath, buffer);

          return jsonResult({
            path: p.path,
            size: buffer.length,
            created: true,
          });
        } finally {
          // Clean up temp files
          await fs.unlink(tmpMd).catch(() => {});
          await fs.unlink(tmpDocx).catch(() => {});
        }
      } catch (err: any) {
        if (err?.stderr) {
          return jsonResult({ error: `Pandoc error: ${err.stderr}` });
        }
        return jsonResult({
          error: `Failed to create Word file: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  };
}

// ==================== Excel (.xlsx) ====================

/** Read Excel tool — extracts data from .xlsx files using exceljs */
export function createReadXlsxTool(
  orgId: string,
  agentId: string,
): ToolDefinition {
  return {
    name: "read_xlsx",
    label: "Read Excel Spreadsheet",
    description:
      "Read and extract data from an Excel (.xlsx) file in the workspace. Use this instead of read_file for .xlsx files. Returns sheet names and cell data as structured text.",
    parameters: Type.Object({
      path: Type.String({
        description: "Path to the .xlsx file relative to the workspace root",
      }),
      sheet: Type.Optional(
        Type.String({
          description: "Sheet name to read (default: first sheet)",
        }),
      ),
      max_rows: Type.Optional(
        Type.Number({ description: "Maximum rows to read (default 200)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as any;
      const resolved = resolveWorkspacePath(
        orgId,
        agentId,
        String(p.path || ""),
      );
      if ("error" in resolved) return jsonResult(resolved);

      try {
        await fs.access(resolved.fullPath);
      } catch {
        return jsonResult({ error: `File not found: ${p.path}` });
      }

      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(resolved.fullPath);

        const sheetNames = workbook.worksheets.map((ws) => ws.name);
        const targetSheet = p.sheet
          ? workbook.getWorksheet(p.sheet)
          : workbook.worksheets[0];

        if (!targetSheet) {
          return jsonResult({
            error: `Sheet not found: ${p.sheet}. Available: ${sheetNames.join(", ")}`,
          });
        }

        const maxRows = Math.min(Number(p.max_rows) || 200, 1000);
        const rows: string[] = [];
        let rowCount = 0;

        targetSheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowCount >= maxRows) return;
          const cells = row.values as any[];
          // row.values is 1-indexed, first element is undefined
          const values = cells.slice(1).map((v) => {
            if (v === null || v === undefined) return "";
            if (typeof v === "object" && "result" in v) return String(v.result); // formula
            if (typeof v === "object" && "text" in v) return String(v.text); // rich text
            return String(v);
          });
          rows.push(values.join("\t"));
          rowCount++;
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
            path: p.path,
            sheet: targetSheet.name,
            rowCount: totalRows,
          },
        };
      } catch (err) {
        return jsonResult({
          error: `Failed to read Excel file: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  };
}

/** Create Excel tool — generates .xlsx files using exceljs */
export function createWriteXlsxTool(
  orgId: string,
  agentId: string,
): ToolDefinition {
  return {
    name: "create_xlsx",
    label: "Create Excel Spreadsheet",
    description:
      "Create an Excel (.xlsx) file in the workspace. Provide headers and rows of data. The file will be saved to the specified path.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Output path for the .xlsx file relative to workspace root (e.g. "data.xlsx")',
      }),
      sheet_name: Type.Optional(
        Type.String({ description: 'Sheet name (default "Sheet1")' }),
      ),
      headers: Type.Array(Type.String(), {
        description: 'Column header names (e.g. ["Name", "Age", "Email"])',
      }),
      rows: Type.Array(
        Type.Array(
          Type.Union([
            Type.String(),
            Type.Number(),
            Type.Boolean(),
            Type.Null(),
          ]),
          { description: "Row values" },
        ),
        { description: "Array of rows, each row is an array of cell values" },
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as any;
      const resolved = resolveWorkspacePath(
        orgId,
        agentId,
        String(p.path || ""),
      );
      if ("error" in resolved) return jsonResult(resolved);

      const headers: string[] = p.headers;
      const rows: any[][] = p.rows;
      if (!headers || headers.length === 0) {
        return jsonResult({ error: "Headers are required" });
      }

      try {
        const ExcelJS = await import("exceljs");
        const workbook = new ExcelJS.default.Workbook();
        const sheet = workbook.addWorksheet(p.sheet_name || "Sheet1");

        // Add header row with bold styling
        const headerRow = sheet.addRow(headers);
        headerRow.font = { bold: true };

        // Add data rows
        for (const row of rows || []) {
          sheet.addRow(row);
        }

        // Auto-fit column widths (approximate)
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
          path: p.path,
          size: stat.size,
          headers: headers.length,
          rows: (rows || []).length,
          created: true,
        });
      } catch (err) {
        return jsonResult({
          error: `Failed to create Excel file: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  };
}

// ==================== PowerPoint (.pptx) ====================

/** Create PowerPoint tool — generates .pptx files from structured slide data */
export function createWritePptxTool(
  orgId: string,
  agentId: string,
): ToolDefinition {
  return {
    name: "create_pptx",
    label: "Create PowerPoint Presentation",
    description:
      'Create a PowerPoint (.pptx) presentation. Provide an array of slides with titles, body text, and optional tables/images. Each slide can have a layout: "title" (title slide with subtitle), "content" (title + bullet points), "section" (section header), "two_column" (two-column layout), or "blank".',
    parameters: Type.Object({
      path: Type.String({
        description:
          'Output path for the .pptx file (e.g. "presentation.pptx")',
      }),
      title: Type.Optional(
        Type.String({ description: "Presentation title (metadata)" }),
      ),
      author: Type.Optional(
        Type.String({ description: "Author name (metadata)" }),
      ),
      slides: Type.Array(
        Type.Object({
          layout: Type.Optional(
            Type.String({
              description:
                'Slide layout: "title", "content" (default), "section", "two_column", or "blank"',
            }),
          ),
          title: Type.Optional(Type.String({ description: "Slide title" })),
          subtitle: Type.Optional(
            Type.String({ description: "Subtitle (for title/section slides)" }),
          ),
          body: Type.Optional(
            Type.String({
              description:
                'Body text. Use newlines for bullet points. Use "- " prefix for bullet markers.',
            }),
          ),
          body_right: Type.Optional(
            Type.String({
              description: "Right column text (for two_column layout only)",
            }),
          ),
          notes: Type.Optional(Type.String({ description: "Speaker notes" })),
          table: Type.Optional(
            Type.Object(
              {
                headers: Type.Array(Type.String(), {
                  description: "Column headers",
                }),
                rows: Type.Array(Type.Array(Type.String()), {
                  description: "Table row data",
                }),
              },
              { description: "Optional table to display on the slide" },
            ),
          ),
          image: Type.Optional(
            Type.Object(
              {
                path: Type.String({
                  description: "Image file path relative to workspace",
                }),
                width: Type.Optional(
                  Type.Number({ description: "Width in inches (default 6)" }),
                ),
                height: Type.Optional(
                  Type.Number({ description: "Height in inches (default 4)" }),
                ),
              },
              { description: "Optional image to display on the slide" },
            ),
          ),
        }),
        { description: "Array of slide definitions" },
      ),
    }),
    async execute(_toolCallId, params) {
      const p = params as any;
      const resolved = resolveWorkspacePath(
        orgId,
        agentId,
        String(p.path || ""),
      );
      if ("error" in resolved) return jsonResult(resolved);

      const slides: any[] = p.slides;
      if (!slides || slides.length === 0) {
        return jsonResult({ error: "At least one slide is required" });
      }

      try {
        const PptxGenJS = (await import("pptxgenjs")).default;
        const pptx = new PptxGenJS();

        if (p.title) pptx.title = p.title;
        if (p.author) pptx.author = p.author;
        pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 inches

        // Theme colors
        const COLOR_PRIMARY = "1F4E79";
        const COLOR_ACCENT = "C5B358"; // Mines gold
        const COLOR_TEXT = "333333";
        const COLOR_LIGHT = "F2F2F2";

        for (const slideData of slides) {
          const slide = pptx.addSlide();
          const layout = slideData.layout || "content";

          if (slideData.notes) {
            slide.addNotes(slideData.notes);
          }

          if (layout === "title") {
            // Title slide
            slide.background = { color: COLOR_PRIMARY };
            if (slideData.title) {
              slide.addText(slideData.title, {
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
            if (slideData.subtitle) {
              slide.addText(slideData.subtitle, {
                x: 0.8,
                y: 3.5,
                w: 11.7,
                h: 1.0,
                fontSize: 20,
                fontFace: "Arial",
                color: COLOR_ACCENT,
              });
            }
            // Bottom accent bar
            slide.addShape(pptx.ShapeType.rect, {
              x: 0.8,
              y: 5.5,
              w: 4,
              h: 0.06,
              fill: { color: COLOR_ACCENT },
            });
          } else if (layout === "section") {
            // Section header slide
            slide.background = { color: COLOR_LIGHT };
            slide.addShape(pptx.ShapeType.rect, {
              x: 0,
              y: 0,
              w: 0.4,
              h: 7.5,
              fill: { color: COLOR_PRIMARY },
            });
            if (slideData.title) {
              slide.addText(slideData.title, {
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
            if (slideData.subtitle) {
              slide.addText(slideData.subtitle, {
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
            // Two-column layout
            if (slideData.title) {
              slide.addText(slideData.title, {
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
            const bodyY = slideData.title ? 1.4 : 0.5;
            if (slideData.body) {
              slide.addText(formatBullets(slideData.body), {
                x: 0.5,
                y: bodyY,
                w: 5.8,
                h: 5.5,
                fontSize: 14,
                fontFace: "Arial",
                color: COLOR_TEXT,
                valign: "top",
                paraSpaceAfter: 6,
              });
            }
            if (slideData.body_right) {
              slide.addText(formatBullets(slideData.body_right), {
                x: 6.8,
                y: bodyY,
                w: 5.8,
                h: 5.5,
                fontSize: 14,
                fontFace: "Arial",
                color: COLOR_TEXT,
                valign: "top",
                paraSpaceAfter: 6,
              });
            }
          } else if (layout === "blank") {
            // Blank slide — only add explicit content below
          } else {
            // Default "content" layout: title + body
            if (slideData.title) {
              slide.addText(slideData.title, {
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
            const bodyY = slideData.title ? 1.4 : 0.5;
            if (slideData.body) {
              slide.addText(formatBullets(slideData.body), {
                x: 0.5,
                y: bodyY,
                w: 12.3,
                h: 5.5,
                fontSize: 16,
                fontFace: "Arial",
                color: COLOR_TEXT,
                valign: "top",
                paraSpaceAfter: 8,
              });
            }
          }

          // Add table if specified (on any layout)
          if (slideData.table?.headers && slideData.table?.rows) {
            const tableRows = [
              slideData.table.headers.map((h: string) => ({
                text: h,
                options: {
                  bold: true,
                  color: "FFFFFF",
                  fill: { color: COLOR_PRIMARY },
                  fontSize: 12,
                },
              })),
              ...slideData.table.rows.map((row: string[]) =>
                row.map((cell: string) => ({
                  text: cell,
                  options: { fontSize: 11 },
                })),
              ),
            ];
            const tableY =
              slideData.title && slideData.body
                ? 4.5
                : slideData.title
                  ? 1.5
                  : 0.5;
            slide.addTable(tableRows, {
              x: 0.5,
              y: tableY,
              w: 12.3,
              border: { type: "solid", pt: 0.5, color: "CCCCCC" },
              colW: Array(slideData.table.headers.length).fill(
                12.3 / slideData.table.headers.length,
              ),
              autoPage: false,
            });
          }

          // Add image if specified
          if (slideData.image?.path) {
            const imgResolved = resolveWorkspacePath(
              orgId,
              agentId,
              slideData.image.path,
            );
            if (!("error" in imgResolved)) {
              try {
                await fs.access(imgResolved.fullPath);
                const imgW = slideData.image.width || 6;
                const imgH = slideData.image.height || 4;
                const imgX = (13.33 - imgW) / 2; // center horizontally
                const imgY = slideData.title ? 1.5 : 0.5;
                slide.addImage({
                  path: imgResolved.fullPath,
                  x: imgX,
                  y: imgY,
                  w: imgW,
                  h: imgH,
                });
              } catch {
                // Image not found — skip silently
              }
            }
          }
        }

        await fs.mkdir(path.dirname(resolved.fullPath), { recursive: true });
        await pptx.writeFile({ fileName: resolved.fullPath });

        const stat = await fs.stat(resolved.fullPath);
        return jsonResult({
          path: p.path,
          size: stat.size,
          slides: slides.length,
          created: true,
        });
      } catch (err) {
        return jsonResult({
          error: `Failed to create PowerPoint: ${err instanceof Error ? err.message : err}`,
        });
      }
    },
  };
}

/** Convert body text with "- " prefixed lines into pptxgenjs bullet text objects */
function formatBullets(text: string): any[] {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.map((line) => {
    const isBullet = line.trimStart().startsWith("- ");
    const cleanText = isBullet ? line.trimStart().slice(2) : line;
    return {
      text: cleanText,
      options: isBullet ? { bullet: true, indentLevel: 0 } : {},
    };
  });
}

// ==================== Tool Builders ====================

/** Get all document tools (always available for every agent) */
export function getDocumentTools(
  orgId: string,
  agentId: string,
): ToolDefinition[] {
  return [
    createReadPdfTool(orgId, agentId),
    createReadDocxTool(orgId, agentId),
    createWriteDocxTool(orgId, agentId),
    createReadXlsxTool(orgId, agentId),
    createWriteXlsxTool(orgId, agentId),
    createWritePptxTool(orgId, agentId),
  ];
}

/** Map of tool_type values to tool factory functions */
const TOOL_REGISTRY: Record<string, Array<() => ToolDefinition | null>> = {
  web_search: [createWebSearchTool, createWebFetchTool],
};

/** Build custom tools based on enabled skills (uses tool_type field) */
export function getCustomToolsForSkills(
  enabledSkills: Array<{ name: string; tool_type?: string | null }>,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const addedToolNames = new Set<string>();

  for (const skill of enabledSkills) {
    const toolType = skill.tool_type;
    if (!toolType) continue;

    const factories = TOOL_REGISTRY[toolType];
    if (factories) {
      for (const factory of factories) {
        const tool = factory();
        if (!tool || addedToolNames.has(tool.name)) continue;
        tools.push(tool);
        addedToolNames.add(tool.name);
      }
    }
  }

  return tools;
}
