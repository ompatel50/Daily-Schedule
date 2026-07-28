import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function SectionCard({
  title,
  icon: Icon,
  accent,
  action,
  children,
  className,
  contentClassName,
  description,
}: {
  title: string;
  icon?: LucideIcon;
  accent?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  description?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {Icon && <Icon className={cn("h-4 w-4 shrink-0", accent)} />}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{title}</p>
            {description && (
              <p className="truncate text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        {action}
      </CardHeader>
      <CardContent className={cn("pt-0", contentClassName)}>{children}</CardContent>
    </Card>
  );
}
