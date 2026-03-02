import { Button } from "@/components/ui/button";
import JSZip from "jszip";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface PptxViewerProps {
  url: string;
}

interface SlideText {
  text: string;
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  color?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

interface SlideGroup {
  texts: SlideText[];
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SlideData {
  index: number;
  groups: SlideGroup[];
  bgColor?: string;
}

/** Parse EMU (English Metric Units) to percentage of slide dimensions */
function emuToPct(emu: string | undefined, total: number): number {
  if (!emu) return 0;
  return (Number.parseInt(emu, 10) / total) * 100;
}

/** Parse OOXML color (may have leading/trailing chars) */
function parseColor(colorEl: Element | null): string | undefined {
  if (!colorEl) return undefined;

  // <a:srgbClr val="1F4E79"/>
  const srgb = colorEl.querySelector("srgbClr");
  if (srgb) return "#" + srgb.getAttribute("val");

  // <a:schemeClr val="dk1"/>
  const scheme = colorEl.querySelector("schemeClr");
  if (scheme) {
    const schemeMap: Record<string, string> = {
      dk1: "#333333",
      dk2: "#1F4E79",
      lt1: "#FFFFFF",
      lt2: "#E8E8E8",
      accent1: "#1F4E79",
      accent2: "#C5B358",
      tx1: "#333333",
      tx2: "#666666",
      bg1: "#FFFFFF",
      bg2: "#F2F2F2",
    };
    return schemeMap[scheme.getAttribute("val") || ""] || undefined;
  }

  return undefined;
}

/** Parse a single slide XML */
function parseSlide(xml: string, parser: DOMParser): SlideData {
  const doc = parser.parseFromString(xml, "application/xml");
  const groups: SlideGroup[] = [];

  // Slide dimensions (default 16:9 widescreen in EMU)
  const SLIDE_W = 12192000; // 13.33 inches
  const SLIDE_H = 6858000; // 7.5 inches

  // Check background
  let bgColor: string | undefined;
  const bgFill = doc.querySelector("cSld > bg solidFill srgbClr");
  if (bgFill) bgColor = "#" + bgFill.getAttribute("val");

  // Find all shape trees
  const spList = doc.querySelectorAll("cSld spTree sp");

  spList.forEach((sp) => {
    const txBody = sp.querySelector("txBody");
    if (!txBody) return;

    // Get position/size from spPr > xfrm
    const off = sp.querySelector("spPr xfrm off");
    const ext = sp.querySelector("spPr xfrm ext");

    const x = emuToPct(off?.getAttribute("x") || undefined, SLIDE_W);
    const y = emuToPct(off?.getAttribute("y") || undefined, SLIDE_H);
    const w = emuToPct(ext?.getAttribute("cx") || undefined, SLIDE_W);
    const h = emuToPct(ext?.getAttribute("cy") || undefined, SLIDE_H);

    const texts: SlideText[] = [];
    const paragraphs = txBody.querySelectorAll("p");

    paragraphs.forEach((p) => {
      const runs = p.querySelectorAll("r");
      if (runs.length === 0) {
        // Empty paragraph (spacing)
        texts.push({ text: "" });
        return;
      }

      runs.forEach((r) => {
        const rPr = r.querySelector("rPr");
        const t = r.querySelector("t");
        if (!t?.textContent) return;

        const bold = rPr?.getAttribute("b") === "1";
        const italic = rPr?.getAttribute("i") === "1";
        const fontSizeRaw = rPr?.getAttribute("sz");
        const fontSize = fontSizeRaw
          ? Number.parseInt(fontSizeRaw, 10) / 100
          : undefined;
        const color = parseColor(rPr);

        texts.push({ text: t.textContent, bold, italic, fontSize, color });
      });

      // Add line break between paragraphs
      texts.push({ text: "\n" });
    });

    if (texts.length > 0) {
      groups.push({ texts, x, y, w, h });
    }
  });

  return { index: 0, groups, bgColor };
}

export function PptxViewer({ url }: PptxViewerProps) {
  const [slides, setSlides] = useState<SlideData[]>([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const slideAreaRef = useRef<HTMLDivElement>(null);
  const [slideViewport, setSlideViewport] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
        const blob = await res.blob();
        const zip = await JSZip.loadAsync(blob);

        const parser = new DOMParser();
        const slideFiles: string[] = [];

        // Find slide files (ppt/slides/slide1.xml, slide2.xml, ...)
        zip.forEach((path) => {
          if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) {
            slideFiles.push(path);
          }
        });

        // Sort by slide number
        slideFiles.sort((a, b) => {
          const numA = Number.parseInt(a.match(/slide(\d+)/)?.[1] || "0", 10);
          const numB = Number.parseInt(b.match(/slide(\d+)/)?.[1] || "0", 10);
          return numA - numB;
        });

        const parsed: SlideData[] = [];
        for (let i = 0; i < slideFiles.length; i++) {
          const xml = await zip.file(slideFiles[i])?.async("string");
          if (!xml) continue;
          const slide = parseSlide(xml, parser);
          slide.index = i;
          parsed.push(slide);
        }

        if (!cancelled) {
          setSlides(parsed);
          setCurrentSlide(0);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load presentation",
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

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        setCurrentSlide((c) => Math.min(c + 1, slides.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        setCurrentSlide((c) => Math.max(c - 1, 0));
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [slides.length]);

  useEffect(() => {
    const el = slideAreaRef.current;
    if (!el) return;

    const update = () => {
      const rect = el.getBoundingClientRect();
      setSlideViewport({
        width: Math.max(0, Math.floor(rect.width)),
        height: Math.max(0, Math.floor(rect.height)),
      });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-500 p-8">
        Failed to load presentation: {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Loading presentation...
      </div>
    );
  }

  if (slides.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        No slides found
      </div>
    );
  }

  const slide = slides[currentSlide];
  const fittedWidth = Math.min(
    slideViewport.width,
    (slideViewport.height * 16) / 9,
  );
  const fittedHeight = (fittedWidth * 9) / 16;

  return (
    <div className="h-full flex flex-col bg-[#2b2b2b]">
      {/* Slide area */}
      <div
        ref={slideAreaRef}
        className="flex-1 flex items-center justify-center p-2 min-h-0"
      >
        <div
          className="relative w-full shadow-2xl rounded overflow-hidden"
          style={{
            width: fittedWidth > 0 ? `${fittedWidth}px` : "100%",
            height: fittedHeight > 0 ? `${fittedHeight}px` : undefined,
            aspectRatio: fittedHeight > 0 ? undefined : "16 / 9",
            backgroundColor: slide.bgColor || "#FFFFFF",
          }}
        >
          {slide.groups.map((group, gi) => (
            <div
              key={gi}
              className="absolute overflow-hidden"
              style={{
                left: `${group.x}%`,
                top: `${group.y}%`,
                width: group.w ? `${group.w}%` : "auto",
                height: group.h ? `${group.h}%` : "auto",
              }}
            >
              {group.texts.map((t, ti) => {
                if (t.text === "\n") return <br key={ti} />;
                if (t.text === "") return <div key={ti} className="h-1" />;

                // Scale font sizes relative to slide
                const baseFontSize = t.fontSize || 14;
                const scaledSize = Math.max(baseFontSize * 0.55, 6);

                return (
                  <span
                    key={ti}
                    style={{
                      fontSize: `${scaledSize}px`,
                      fontWeight: t.bold ? 700 : 400,
                      fontStyle: t.italic ? "italic" : "normal",
                      color:
                        t.color ||
                        (slide.bgColor && isColorDark(slide.bgColor)
                          ? "#FFFFFF"
                          : "#333333"),
                      fontFamily: "Arial, sans-serif",
                      lineHeight: 1.4,
                    }}
                  >
                    {t.text}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Navigation bar */}
      <div className="flex items-center justify-center gap-4 py-2 bg-[#1e1e1e]">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCurrentSlide((c) => Math.max(c - 1, 0))}
          disabled={currentSlide === 0}
          className="text-white hover:bg-white/10 disabled:opacity-30"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <span className="text-white/80 text-sm font-mono min-w-[80px] text-center">
          {currentSlide + 1} / {slides.length}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setCurrentSlide((c) => Math.min(c + 1, slides.length - 1))
          }
          disabled={currentSlide === slides.length - 1}
          className="text-white hover:bg-white/10 disabled:opacity-30"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {/* Slide thumbnails */}
      {slides.length > 1 && (
        <div className="flex items-center gap-2 px-4 py-1 bg-[#1e1e1e] border-t border-white/10 overflow-x-auto">
          {slides.map((s, i) => (
            <button
              key={i}
              onClick={() => setCurrentSlide(i)}
              className={`flex-shrink-0 rounded border-2 transition-all ${
                i === currentSlide
                  ? "border-blue-400 shadow-lg"
                  : "border-transparent opacity-60 hover:opacity-90"
              }`}
            >
              <div
                className="w-[80px] h-[45px] rounded-sm overflow-hidden relative"
                style={{ backgroundColor: s.bgColor || "#FFFFFF" }}
              >
                {/* Mini preview: just show first text group */}
                {s.groups.slice(0, 2).map((g, gi) => (
                  <div
                    key={gi}
                    className="absolute overflow-hidden"
                    style={{
                      left: `${g.x}%`,
                      top: `${g.y}%`,
                      width: g.w ? `${g.w}%` : "auto",
                    }}
                  >
                    <div
                      className="truncate"
                      style={{
                        fontSize: "4px",
                        fontFamily: "Arial, sans-serif",
                        color:
                          s.bgColor && isColorDark(s.bgColor)
                            ? "#FFFFFF"
                            : "#333333",
                        lineHeight: 1.2,
                      }}
                    >
                      {g.texts
                        .filter((t) => t.text !== "\n" && t.text !== "")
                        .map((t) => t.text)
                        .join(" ")
                        .slice(0, 50)}
                    </div>
                  </div>
                ))}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Check if a hex color is dark */
function isColorDark(hex: string): boolean {
  const c = hex.replace("#", "");
  const r = Number.parseInt(c.substring(0, 2), 16);
  const g = Number.parseInt(c.substring(2, 4), 16);
  const b = Number.parseInt(c.substring(4, 6), 16);
  return r * 0.299 + g * 0.587 + b * 0.114 < 128;
}
