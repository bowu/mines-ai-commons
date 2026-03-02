import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { readWorkspaceFile } from "@/lib/api";
import {
  getFileTypeBadge,
  getMonacoLanguage,
  getRawUrl,
  isCode,
  isDocx,
  isHtml,
  isImage,
  isMd,
  isPdf,
  isPptx,
  isRichDoc,
  isXlsx,
} from "@/lib/file-utils";
import { Download, FolderOpen, Loader2, X } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { CodeViewer } from "./CodeViewer";
import { PdfZoomControls } from "./PdfZoomControls";
import { SandboxedHtmlPreview } from "./SandboxedHtmlPreview";

const PdfViewer = lazy(() =>
  import("./PdfViewer").then((m) => ({ default: m.PdfViewer })),
);
const DocxViewer = lazy(() =>
  import("./DocxViewer").then((m) => ({ default: m.DocxViewer })),
);
const XlsxViewer = lazy(() =>
  import("./XlsxViewer").then((m) => ({ default: m.XlsxViewer })),
);
const PptxViewer = lazy(() =>
  import("./PptxViewer").then((m) => ({ default: m.PptxViewer })),
);
const MarkdownViewer = lazy(() =>
  import("./MarkdownViewer").then((m) => ({ default: m.MarkdownViewer })),
);

interface FilePreviewOverlayProps {
  agentId: string;
  filePath: string;
  onClose: () => void;
  onOpenInWorkspace: () => void;
}

export function FilePreviewOverlay({
  agentId,
  filePath,
  onClose,
  onOpenInWorkspace,
}: FilePreviewOverlayProps) {
  const [textContent, setTextContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [pdfScale, setPdfScale] = useState(1.0);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    // Rich docs (PDF, DOCX, etc.) load via their own viewers using rawUrl — skip text fetch
    // But HTML needs text content for srcdoc rendering
    if (isRichDoc(filePath) && !isHtml(filePath)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    readWorkspaceFile(agentId, filePath)
      .then((data) => setTextContent(data.content))
      .catch(() => setTextContent("Error reading file"))
      .finally(() => setLoading(false));
  }, [agentId, filePath]);

  useEffect(() => {
    setPdfScale(1.0);
  }, [filePath]);

  const rawUrl = getRawUrl(agentId, filePath);
  const badge = getFileTypeBadge(filePath);
  const fileName = filePath.split("/").pop() || filePath;
  const isDocumentPreview =
    isPdf(filePath) ||
    isDocx(filePath) ||
    isXlsx(filePath) ||
    isPptx(filePath) ||
    isHtml(filePath) ||
    isCode(filePath);

  const handleDownload = () => {
    const url = `/api/workspace/${agentId}/file?path=${encodeURIComponent(filePath)}&download=true`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filePath.split("/").pop() || "download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`bg-white rounded-xl shadow-2xl h-[80vh] flex flex-col overflow-hidden ${
          isDocumentPreview
            ? "w-[96vw] max-w-[1200px]"
            : "w-[90vw] max-w-[900px]"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <span
            className="text-sm font-medium text-foreground truncate flex-1"
            title={filePath}
          >
            {filePath}
          </span>
          {badge && (
            <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-blue-100 text-blue-700">
              {badge}
            </span>
          )}
          {isPdf(filePath) && (
            <PdfZoomControls scale={pdfScale} onScaleChange={setPdfScale} />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenInWorkspace}
            className="h-7 text-xs"
          >
            <FolderOpen className="w-3.5 h-3.5 mr-1" />
            Open in Workspace
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            className="h-7 text-xs"
          >
            <Download className="w-3.5 h-3.5 mr-1" />
            Download
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Body — flex-col so children can use min-h-0 flex-1 for proper scroll containment */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : isImage(filePath) ? (
            <div className="min-h-0 flex-1 overflow-auto flex items-center justify-center bg-[#f0f0f0] p-6">
              <img
                src={rawUrl}
                alt={fileName}
                className="max-w-full max-h-full object-contain rounded shadow-sm"
              />
            </div>
          ) : isPdf(filePath) ? (
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-auto bg-muted/30">
              <Suspense
                fallback={
                  <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
                    Loading viewer...
                  </div>
                }
              >
                <PdfViewer url={rawUrl} scale={pdfScale} />
              </Suspense>
            </div>
          ) : isDocx(filePath) ? (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Loading viewer...
                  </div>
                }
              >
                <DocxViewer url={rawUrl} />
              </Suspense>
            </div>
          ) : isXlsx(filePath) ? (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Loading viewer...
                  </div>
                }
              >
                <XlsxViewer url={rawUrl} />
              </Suspense>
            </div>
          ) : isPptx(filePath) ? (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Loading viewer...
                  </div>
                }
              >
                <PptxViewer url={rawUrl} />
              </Suspense>
            </div>
          ) : isHtml(filePath) ? (
            <SandboxedHtmlPreview
              title={fileName}
              srcDoc={textContent}
              className="min-h-0 flex-1 w-full"
            />
          ) : isMd(filePath) ? (
            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                    Loading viewer...
                  </div>
                }
              >
                <MarkdownViewer content={textContent} />
              </Suspense>
            </div>
          ) : isCode(filePath) ? (
            <div className="min-h-0 flex-1">
              <CodeViewer
                content={textContent}
                language={getMonacoLanguage(filePath)}
              />
            </div>
          ) : (
            <ScrollArea className="h-full p-4">
              <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-words">
                {textContent}
              </pre>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
