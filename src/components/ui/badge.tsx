import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        success:
          "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        warning: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        danger: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * A `span`, not a `div`, and that is load-bearing.
 *
 * A badge is inline content — it is captioned by a sentence about as often as
 * it sits in a row of its own. As a `div` it was a block element, so writing
 * `<p>…<Badge/>…</p>` produced invalid HTML: the parser hoists the block out of
 * the paragraph, the DOM stops matching what the server rendered, React
 * discards the tree and re-renders, and any click landing in that window is
 * silently lost. That happened — an undo button stopped opening its dialog,
 * deterministically, with no symptom anywhere but a minified hydration error.
 *
 * The base class is already `inline-flex`, so the two render identically; the
 * span simply makes the mistake impossible instead of leaving it to be
 * rediscovered.
 */
function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
