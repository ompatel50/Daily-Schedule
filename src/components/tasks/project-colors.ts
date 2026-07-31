/**
 * The project colour set — the same palette the Tag colours use. A fixed
 * record (never `bg-${color}-500` template strings) so Tailwind's scanner sees
 * every class literally.
 */

export const PROJECT_COLORS = [
  "slate",
  "red",
  "orange",
  "amber",
  "emerald",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export const PROJECT_COLOR_CLASS: Record<ProjectColor, { label: string; dot: string }> = {
  slate: { label: "Slate", dot: "bg-slate-500" },
  red: { label: "Red", dot: "bg-red-500" },
  orange: { label: "Orange", dot: "bg-orange-500" },
  amber: { label: "Amber", dot: "bg-amber-500" },
  emerald: { label: "Emerald", dot: "bg-emerald-500" },
  teal: { label: "Teal", dot: "bg-teal-500" },
  sky: { label: "Sky", dot: "bg-sky-500" },
  blue: { label: "Blue", dot: "bg-blue-500" },
  violet: { label: "Violet", dot: "bg-violet-500" },
  pink: { label: "Pink", dot: "bg-pink-500" },
};

/** Narrow an untrusted colour string to a renderable dot/bar class. */
export function projectColorDot(color: string): string {
  return (PROJECT_COLOR_CLASS[color as ProjectColor] ?? PROJECT_COLOR_CLASS.slate).dot;
}
