import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70" />
      <DialogPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 w-[min(34rem,calc(100%-1.5rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-2xl", className)}>
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 text-sm text-muted-foreground">Close</DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const DialogTitle = DialogPrimitive.Title;
