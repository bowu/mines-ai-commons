import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

type PillVariant = "active" | "loading" | "error" | "neutral";

interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant: PillVariant;
  children: React.ReactNode;
}

const variantStyles: Record<PillVariant, string> = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  loading: "bg-sky-50 text-sky-700 border-sky-200",
  error: "bg-rose-50 text-rose-700 border-rose-200",
  neutral: "bg-stone-50 text-stone-600 border-stone-200",
};

export function StatusPill({
  variant,
  children,
  className,
  ...props
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        variantStyles[variant],
        className,
      )}
      {...props}
    >
      {variant === "loading" && <Loader2 className="w-3 h-3 animate-spin" />}
      {children}
    </span>
  );
}
