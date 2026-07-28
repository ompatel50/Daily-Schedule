import { cn } from "@/lib/utils";

/**
 * Compact SVG completion ring. Used for the day score and macro progress —
 * no chart library needed for a single value.
 */
export function ProgressRing({
  value,
  size = 96,
  strokeWidth = 8,
  label,
  sublabel,
  className,
  trackClassName = "text-muted-foreground",
  indicatorClassName = "text-emerald-500",
}: {
  value: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
  className?: string;
  trackClassName?: string;
  indicatorClassName?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div className={cn("relative inline-flex items-center justify-center", className)}>
      <svg width={size} height={size} className="-rotate-90" role="img" aria-label={`${clamped}%`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className={cn("stroke-current opacity-20", trackClassName)}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn("stroke-current transition-[stroke-dashoffset] duration-700", indicatorClassName)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tabular text-xl font-semibold leading-none">{label ?? `${clamped}%`}</span>
        {sublabel && (
          <span className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}
