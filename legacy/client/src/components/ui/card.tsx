import { cn } from "@/lib/utils";

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border border-border bg-card text-card-foreground", className)}>{children}</div>;
}
