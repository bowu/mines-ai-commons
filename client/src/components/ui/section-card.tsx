import { cn } from "@/lib/utils";
import { Slot } from "@radix-ui/react-slot";

interface SectionCardProps {
  children: React.ReactNode;
  interactive?: boolean;
  asChild?: boolean;
  className?: string;
  onClick?: () => void;
}

export function SectionCard({
  children,
  interactive,
  asChild,
  className,
  onClick,
}: SectionCardProps) {
  const baseStyles = "rounded-xl border border-stroke bg-white shadow-sm";
  const interactiveStyles =
    "cursor-pointer hover:shadow-md hover:border-stroke-strong active:scale-[0.995] focus-visible:ring-2 focus-visible:ring-mines-light-blue/30 focus-visible:outline-none transition-all duration-150";

  const classes = cn(
    baseStyles,
    interactive && interactiveStyles,
    interactive && !asChild && "w-full text-left",
    className,
  );

  if (asChild) {
    return <Slot className={classes}>{children}</Slot>;
  }

  if (interactive) {
    return (
      <button type="button" className={classes} onClick={onClick}>
        {children}
      </button>
    );
  }

  return <div className={classes}>{children}</div>;
}
