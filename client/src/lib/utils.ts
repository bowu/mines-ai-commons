import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Shared prose className for markdown rendering in both ChatView and MarkdownViewer.
// Extra classes can be appended per-callsite.
export const PROSE_CLASSES =
  "prose prose-sm max-w-none prose-headings:font-semibold prose-headings:text-foreground " +
  "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 " +
  "[&_pre]:my-2.5 [&_pre]:bg-zinc-100 [&_pre]:text-zinc-800 [&_pre]:p-3 [&_pre]:rounded-lg " +
  "[&_pre_code]:bg-transparent [&_pre_code]:text-inherit " +
  "[&_code]:text-[12px] [&_code]:bg-zinc-100 [&_code]:text-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/20 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground " +
  "[&_table]:w-full [&_table]:my-2.5 [&_table]:border-collapse [&_table]:text-[13px] " +
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium " +
  "[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5 " +
  "[&_del]:line-through";
