import { renderAsync } from "docx-preview";
import { useEffect, useRef, useState } from "react";

interface DocxViewerProps {
  url: string;
}

export function DocxViewer({ url }: DocxViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        const blob = await res.blob();

        if (cancelled || !containerRef.current) return;

        containerRef.current.innerHTML = "";

        await renderAsync(blob, containerRef.current, undefined, {
          className: "docx-preview",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          trimXmlDeclaration: true,
          useBase64URL: true,
        });
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to render document",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-500 p-8">
        Failed to render Word document: {error}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-[#e8e8e8]">
      {loading && (
        <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
          Loading document...
        </div>
      )}
      <div ref={containerRef} className="docx-viewer-container" />
      <style>{`
        .docx-viewer-container {
          min-height: 100%;
        }
        .docx-viewer-container > div {
          background: #e8e8e8 !important;
          padding: 30px !important;
          min-height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .docx-viewer-container > div > section {
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
          margin: 0 auto 20px auto !important;
          padding: 96px 120px !important;
          width: 816px !important;
          max-width: calc(100% - 60px) !important;
          box-sizing: border-box;
        }
      `}</style>
    </div>
  );
}
