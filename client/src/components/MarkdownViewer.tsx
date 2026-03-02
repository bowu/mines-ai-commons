import { MarkdownImage } from "@/components/MarkdownImage";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PROSE_CLASSES } from "@/lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownViewerProps {
  content: string;
}

export function MarkdownViewer({ content }: MarkdownViewerProps) {
  const markdownComponents: Components = {
    img({ src, alt }) {
      return (
        <MarkdownImage
          src={src}
          alt={alt}
          className="h-auto max-w-full rounded"
        />
      );
    },
  };

  return (
    <ScrollArea className="h-full">
      <div className="px-8 py-6 mx-auto max-w-[800px]">
        <div className={PROSE_CLASSES}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
    </ScrollArea>
  );
}
