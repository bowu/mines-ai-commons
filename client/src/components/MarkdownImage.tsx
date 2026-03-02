import { Image as ImageIcon } from "lucide-react";
import { useMemo, useState } from "react";

const failedImageSrcs = new Set<string>();

function getImageLabel(src: string, alt?: string): string {
  const trimmedAlt = alt?.trim();
  if (trimmedAlt) return trimmedAlt;
  try {
    const url = new URL(src);
    const fileName = url.pathname.split("/").pop();
    if (fileName) return fileName;
    return url.hostname;
  } catch {
    return src;
  }
}

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  className?: string;
  onFileClick?: (filePath: string) => void;
}

export function MarkdownImage({
  src,
  alt,
  className,
  onFileClick,
}: MarkdownImageProps) {
  const normalizedSrc = useMemo(() => src?.trim() ?? "", [src]);
  const [failed, setFailed] = useState<boolean>(() =>
    normalizedSrc ? failedImageSrcs.has(normalizedSrc) : false,
  );

  if (!normalizedSrc) return null;

  if (normalizedSrc.startsWith("file://") && onFileClick) {
    const filePath = normalizedSrc.slice("file://".length);
    const label = getImageLabel(filePath, alt);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          onFileClick(filePath);
        }}
        className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 no-underline transition-colors hover:bg-emerald-100"
      >
        <ImageIcon className="h-3 w-3 shrink-0" />
        {label}
      </button>
    );
  }

  if (failed) {
    const label = getImageLabel(normalizedSrc, alt);
    return (
      <a
        href={normalizedSrc}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 no-underline"
      >
        <ImageIcon className="h-3 w-3 shrink-0" />
        Image unavailable: {label}
      </a>
    );
  }

  return (
    <img
      src={normalizedSrc}
      alt={alt || ""}
      className={className}
      loading="lazy"
      decoding="async"
      onError={() => {
        failedImageSrcs.add(normalizedSrc);
        setFailed(true);
      }}
    />
  );
}
