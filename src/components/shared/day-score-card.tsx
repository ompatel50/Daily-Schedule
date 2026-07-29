import { Flame } from "lucide-react";

import { ProgressRing } from "@/components/shared/progress-ring";
import { ScoreExplanation } from "@/components/shared/score-explanation";
import { SectionCard } from "@/components/shared/section-card";
import type { DayScore } from "@/lib/logic/day-score";

/**
 * The day score, rendered identically wherever it appears.
 *
 * The ring, the null-vs-zero handling and the colour band used to be
 * copy-pasted between the dashboard and Today, which is how two surfaces drift
 * into disagreeing about the same number. There is one score service (see
 * `src/server/day-score.ts`) and now one card that draws it; a surface only
 * chooses its `sublabel` and what it puts underneath.
 */
export function DayScoreCard({
  score,
  size = 116,
  sublabel,
  children,
}: {
  score: DayScore;
  size?: number;
  /** Defaults to "open day" when nothing applied, since 0 would be a lie. */
  sublabel?: string;
  /** Surface-specific footer — the 7-day mini stats, the explanation line, … */
  children?: React.ReactNode;
}) {
  const empty = score.score === null;

  return (
    <SectionCard
      title="Day score"
      icon={Flame}
      accent="text-emerald-500"
      action={<ScoreExplanation score={score} />}
    >
      <div className="flex flex-col items-center gap-3 py-1">
        <ProgressRing
          value={score.score ?? 0}
          size={size}
          label={empty ? "—" : `${score.score}`}
          sublabel={empty ? "open day" : (sublabel ?? "out of 100")}
          indicatorClassName={scoreTone(score.score)}
        />
        {children}
      </div>
    </SectionCard>
  );
}

/**
 * Colour by band. Never the only signal — the number and the explanation text
 * carry the meaning, so this stays readable without colour vision.
 */
export function scoreTone(score: number | null): string {
  if (score === null) return "text-muted-foreground";
  if (score >= 80) return "text-emerald-500";
  if (score >= 50) return "text-amber-500";
  return "text-rose-500";
}
