import { cn } from "@/lib/utils";

export function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground", className)}>{children}</span>;
}
