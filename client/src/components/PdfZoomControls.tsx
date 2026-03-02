import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut } from "lucide-react";

interface PdfZoomControlsProps {
  scale: number;
  onScaleChange: (next: number) => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.0;
const SCALE_STEP = 0.25;

export function PdfZoomControls({
  scale,
  onScaleChange,
}: PdfZoomControlsProps) {
  const zoomOut = () => onScaleChange(Math.max(MIN_SCALE, scale - SCALE_STEP));
  const zoomIn = () => onScaleChange(Math.min(MAX_SCALE, scale + SCALE_STEP));

  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1 py-0.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={zoomOut}
        disabled={scale <= MIN_SCALE}
        className="h-6 w-6 p-0"
        aria-label="Zoom out PDF"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <span className="min-w-[42px] text-center text-[11px] text-muted-foreground">
        {Math.round(scale * 100)}%
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={zoomIn}
        disabled={scale >= MAX_SCALE}
        className="h-6 w-6 p-0"
        aria-label="Zoom in PDF"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
