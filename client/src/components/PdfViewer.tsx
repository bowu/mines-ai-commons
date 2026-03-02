import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Use a bundled same-origin worker so production CSP (script-src 'self') does not block PDF rendering.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfViewerProps {
  url: string;
  scale?: number;
}

const PDF_RETRY_DELAY_MS = 1500;
const PDF_MAX_RETRY_ATTEMPTS = 40;

function isRetryablePdfLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("503") ||
    message.includes("Sandbox is starting") ||
    message.includes("vm_starting")
  );
}

export function PdfViewer({ url, scale }: PdfViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [internalScale] = useState(1.0);
  const [containerWidth, setContainerWidth] = useState<number | undefined>();
  const [retryCount, setRetryCount] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryPendingRef = useRef(false);

  const effectiveScale = scale ?? internalScale;

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryPendingRef.current = false;
  }, []);

  useEffect(() => {
    setRetryCount(0);
    setErrorText(null);
    clearRetryTimer();
    return clearRetryTimer;
  }, [url, clearRetryTimer]);

  useEffect(() => {
    retryPendingRef.current = false;
  }, [retryCount]);

  const onDocumentLoadSuccess = useCallback(
    ({ numPages }: { numPages: number }) => {
      clearRetryTimer();
      setErrorText(null);
      setNumPages(numPages);
    },
    [clearRetryTimer],
  );

  const onDocumentLoadError = useCallback(
    (error: unknown) => {
      if (
        isRetryablePdfLoadError(error) &&
        retryCount < PDF_MAX_RETRY_ATTEMPTS - 1 &&
        !retryPendingRef.current
      ) {
        retryPendingRef.current = true;
        setErrorText("Waking agent... retrying PDF preview.");
        retryTimerRef.current = window.setTimeout(() => {
          setRetryCount((value) => value + 1);
        }, PDF_RETRY_DELAY_MS);
        return;
      }

      const message =
        error instanceof Error && error.message
          ? error.message
          : "Failed to load PDF";
      setErrorText(message);
    },
    [retryCount],
  );

  const fileUrl = `${url}${url.includes("?") ? "&" : "?"}pdfRetry=${retryCount}`;
  const documentOptions = useMemo(() => ({ withCredentials: true }), []);
  const pageWidth = useMemo(() => {
    if (!containerWidth) return undefined;
    // Zoom is relative to fit-to-pane width so 110% is always visually larger than 100%.
    return Math.max(320, Math.round(containerWidth * effectiveScale));
  }, [containerWidth, effectiveScale]);

  useEffect(() => {
    if (!containerRef.current) return;
    const node = containerRef.current;
    const updateWidth = () => {
      setContainerWidth(Math.max(320, node.clientWidth - 48));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The parent is responsible for providing a scrollable container (overflow-y-auto).
  // PdfViewer only measures its own width and renders pages — no internal scroll wrapper.
  return (
    <div ref={containerRef} className="w-full">
      <Document
        file={fileUrl}
        options={documentOptions}
        onLoadSuccess={onDocumentLoadSuccess}
        onLoadError={onDocumentLoadError}
        loading={
          <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
            {retryCount > 0
              ? "Waking agent and loading PDF..."
              : "Loading PDF..."}
          </div>
        }
        error={
          <div className="flex items-center justify-center py-20 text-sm text-red-500">
            {errorText || "Failed to load PDF"}
          </div>
        }
      >
        <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center gap-4 p-6">
          {Array.from({ length: numPages }, (_, index) => index + 1).map(
            (pageNumber) => (
              <Page
                key={`${fileUrl}-page-${pageNumber}`}
                pageNumber={pageNumber}
                width={pageWidth}
                renderTextLayer={true}
                renderAnnotationLayer={true}
              />
            ),
          )}
        </div>
      </Document>
    </div>
  );
}
