import { useEffect, useRef, useState } from "react";

interface SandboxedHtmlPreviewProps {
  title: string;
  srcDoc: string;
  className?: string;
}

export function SandboxedHtmlPreview({
  title,
  srcDoc,
  className,
}: SandboxedHtmlPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    const node = containerRef.current;
    if (!node) {
      setReady(true);
      return;
    }

    const checkReady = () => {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setReady(true);
      }
    };

    checkReady();
    const frameId = window.requestAnimationFrame(checkReady);
    const fallbackTimer = window.setTimeout(() => {
      setReady(true);
    }, 400);
    const observer = new ResizeObserver(checkReady);
    observer.observe(node);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(fallbackTimer);
    };
  }, [srcDoc, title]);

  return (
    <div ref={containerRef} className={className || "h-full w-full"}>
      {ready ? (
        <iframe
          srcDoc={srcDoc}
          title={title}
          className="h-full w-full border-0 bg-white"
          sandbox="allow-scripts"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
          Preparing preview...
        </div>
      )}
    </div>
  );
}
