import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn("flex min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus:ring-2", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";
