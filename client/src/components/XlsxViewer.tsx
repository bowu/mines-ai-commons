import { cn } from "@/lib/utils";
import ExcelJS from "exceljs";
import { useEffect, useRef, useState } from "react";

interface SheetData {
  name: string;
  headers: string[];
  rows: CellData[][];
  colWidths: number[];
  merges: MergeRange[];
  rowCount: number;
  colCount: number;
}

interface CellData {
  value: string;
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  color?: string;
  align?: string;
  numFmt?: string;
  border?: boolean;
  merged?: boolean; // hidden by merge
  mergeSpan?: { cols: number; rows: number };
}

interface MergeRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface XlsxViewerProps {
  url: string;
}

function extractColor(
  color: Partial<ExcelJS.Color> | undefined,
): string | undefined {
  if (!color) return undefined;
  if (color.argb) {
    // ARGB format: first 2 chars are alpha
    const hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb;
    return `#${hex}`;
  }
  if (color.theme !== undefined) return undefined; // can't resolve theme colors easily
  return undefined;
}

function getCellValue(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("result" in v) return String((v as any).result ?? "");
    if ("text" in v) {
      // Rich text
      if ("richText" in v) {
        return (v as any).richText.map((r: any) => r.text).join("");
      }
      return String((v as any).text);
    }
    if (v instanceof Date) {
      return v.toLocaleDateString();
    }
    if ("richText" in v) {
      return (v as any).richText.map((r: any) => r.text).join("");
    }
  }
  return String(v);
}

export function XlsxViewer({ url }: XlsxViewerProps) {
  const [sheets, setSheets] = useState<SheetData[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(arrayBuffer);

        if (cancelled) return;

        const parsed: SheetData[] = [];

        for (const ws of workbook.worksheets) {
          const maxRows = Math.min(ws.rowCount, 500);
          const colCount = ws.columnCount || 1;

          // Get column widths
          const colWidths: number[] = [];
          for (let c = 1; c <= colCount; c++) {
            const col = ws.getColumn(c);
            colWidths.push(col.width ? Math.max(col.width * 8, 40) : 80);
          }

          // Parse merged cells
          const merges: MergeRange[] = [];
          const mergedCells = new Set<string>();
          const mergeSpans = new Map<string, { cols: number; rows: number }>();

          // ExcelJS stores merges as string ranges like "A1:C3"
          if ((ws as any)._merges) {
            for (const key of Object.keys((ws as any)._merges)) {
              const merge = (ws as any)._merges[key];
              if (merge && merge.model) {
                const m = merge.model;
                merges.push({
                  top: m.top,
                  left: m.left,
                  bottom: m.bottom,
                  right: m.right,
                });
                mergeSpans.set(`${m.top},${m.left}`, {
                  cols: m.right - m.left + 1,
                  rows: m.bottom - m.top + 1,
                });
                for (let r = m.top; r <= m.bottom; r++) {
                  for (let c = m.left; c <= m.right; c++) {
                    if (r !== m.top || c !== m.left) {
                      mergedCells.add(`${r},${c}`);
                    }
                  }
                }
              }
            }
          }

          // Extract headers (first row)
          const headers: string[] = [];
          for (let c = 1; c <= colCount; c++) {
            // Use column letters
            headers.push(getColumnLetter(c));
          }

          // Extract rows
          const rows: CellData[][] = [];
          for (let r = 1; r <= maxRows; r++) {
            const row = ws.getRow(r);
            const rowData: CellData[] = [];

            for (let c = 1; c <= colCount; c++) {
              const cellKey = `${r},${c}`;
              if (mergedCells.has(cellKey)) {
                rowData.push({ value: "", merged: true });
                continue;
              }

              const cell = row.getCell(c);
              const font = cell.font || {};
              const fill = cell.fill as any;
              const alignment = cell.alignment || {};

              let bgColor: string | undefined;
              if (fill?.type === "pattern" && fill.fgColor) {
                bgColor = extractColor(fill.fgColor);
              }

              const span = mergeSpans.get(cellKey);

              rowData.push({
                value: getCellValue(cell),
                bold: font.bold || false,
                italic: font.italic || false,
                fill: bgColor,
                color: extractColor(font.color),
                align: alignment.horizontal || undefined,
                numFmt: cell.numFmt || undefined,
                border: !!(cell.border && Object.keys(cell.border).length > 0),
                mergeSpan: span,
              });
            }

            rows.push(rowData);
          }

          parsed.push({
            name: ws.name,
            headers,
            rows,
            colWidths,
            merges,
            rowCount: ws.rowCount,
            colCount,
          });
        }

        if (!cancelled) {
          setSheets(parsed);
          setActiveSheet(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to parse Excel file",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [url]);

  const sheet = sheets[activeSheet];

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading spreadsheet...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-500 p-8">
        Failed to render spreadsheet: {error}
      </div>
    );
  }

  if (!sheet) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No sheets found
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Spreadsheet grid */}
      <div ref={tableRef} className="flex-1 overflow-auto bg-white">
        <table className="border-collapse" style={{ minWidth: "100%" }}>
          {/* Column headers (A, B, C, ...) */}
          <thead className="sticky top-0 z-10">
            <tr>
              {/* Row number header */}
              <th className="sticky left-0 z-20 bg-[#f0f0f0] border border-[#d4d4d4] text-[10px] text-[#666] font-normal w-[46px] min-w-[46px] px-1 py-0.5 text-center" />
              {sheet.headers.map((h, i) => (
                <th
                  key={i}
                  className="bg-[#f0f0f0] border border-[#d4d4d4] text-[10px] text-[#666] font-medium px-1 py-0.5 text-center select-none"
                  style={{
                    minWidth: sheet.colWidths[i] || 80,
                    width: sheet.colWidths[i] || 80,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri} className="group">
                {/* Row number */}
                <td className="sticky left-0 z-[5] bg-[#f0f0f0] border border-[#d4d4d4] text-[10px] text-[#666] font-normal px-1 py-0 text-center select-none">
                  {ri + 1}
                </td>
                {row.map((cell, ci) => {
                  if (cell.merged) return null;
                  return (
                    <td
                      key={ci}
                      colSpan={cell.mergeSpan?.cols}
                      rowSpan={cell.mergeSpan?.rows}
                      className={cn(
                        "border border-[#e2e2e2] text-[12px] px-1.5 py-0.5 truncate max-w-[300px]",
                        cell.bold && "font-semibold",
                        cell.italic && "italic",
                      )}
                      style={{
                        backgroundColor: cell.fill || undefined,
                        color: cell.color || undefined,
                        textAlign: (cell.align as any) || "left",
                        minWidth: sheet.colWidths[ci] || 80,
                      }}
                      title={cell.value}
                    >
                      {cell.value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {sheet.rowCount > 500 && (
          <div className="text-center text-xs text-muted-foreground py-3 bg-[#f8f8f8] border-t border-[#e2e2e2]">
            Showing 500 of {sheet.rowCount} rows &middot; Download for full data
          </div>
        )}
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="flex items-center gap-0 border-t border-[#d4d4d4] bg-[#f0f0f0] px-2 shrink-0">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActiveSheet(i)}
              className={cn(
                "px-3 py-1.5 text-[11px] border-r border-[#d4d4d4] transition-colors",
                i === activeSheet
                  ? "bg-white font-medium text-[#333] border-t-2 border-t-[#217346]"
                  : "text-[#666] hover:bg-[#e8e8e8]",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function getColumnLetter(n: number): string {
  let result = "";
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}
