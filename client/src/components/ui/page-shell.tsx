import { cn } from "@/lib/utils";

interface PageShellProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  maxWidth?: "narrow" | "wide" | "full";
}

export function PageShell({
  children,
  maxWidth = "wide",
  className,
  ...props
}: PageShellProps) {
  const widthClass = {
    narrow: "max-w-[760px]",
    wide: "max-w-[900px]",
    full: "max-w-none",
  }[maxWidth];

  return (
    <div
      className={cn(
        "h-full overflow-y-auto bg-page animate-fade-in",
        className,
      )}
      {...props}
    >
      <div className={cn("mx-auto px-6 py-6", widthClass)}>{children}</div>
    </div>
  );
}
