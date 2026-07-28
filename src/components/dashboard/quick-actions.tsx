"use client";

import Link from "next/link";
import { Apple, Dumbbell, LineChart, NotebookPen, Plus, Repeat } from "lucide-react";

import { SectionCard } from "@/components/shared/section-card";
import { useUIStore } from "@/store/ui-store";
import { Zap } from "lucide-react";

/**
 * The "what do I do next" strip. Everything here is one click from the home
 * screen — the app should never make the daily ritual feel like navigation.
 */
export function DashboardQuickActions({ date }: { date: string }) {
  const openQuickAdd = useUIStore((state) => state.openQuickAdd);
  const setCommandOpen = useUIStore((state) => state.setCommandOpen);

  const actions = [
    {
      label: "Add to planner",
      hint: "N",
      icon: Plus,
      accent: "text-domain-planner",
      onClick: () => openQuickAdd(date),
    },
    { label: "Log food", hint: "Nutrition", icon: Apple, accent: "text-domain-nutrition", href: "/nutrition" },
    {
      label: "Log workout",
      hint: "Workouts",
      icon: Dumbbell,
      accent: "text-domain-workout",
      href: "/workouts?new=1",
    },
    { label: "Check habits", hint: "Habits", icon: Repeat, accent: "text-domain-habit", href: "/habits" },
    { label: "Weekly review", hint: "Insights", icon: LineChart, accent: "text-domain-health", href: "/insights" },
    {
      label: "Search everything",
      hint: "⌘K",
      icon: NotebookPen,
      accent: "text-muted-foreground",
      onClick: () => setCommandOpen(true),
    },
  ];

  return (
    <SectionCard title="Quick actions" icon={Zap} accent="text-amber-500">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {actions.map((action) => {
          const content = (
            <>
              <action.icon className={`h-4 w-4 ${action.accent}`} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{action.label}</span>
              <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{action.hint}</span>
            </>
          );

          const className =
            "flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50";

          return action.href ? (
            <Link key={action.label} href={action.href} className={className}>
              {content}
            </Link>
          ) : (
            <button key={action.label} type="button" onClick={action.onClick} className={className}>
              {content}
            </button>
          );
        })}
      </div>
    </SectionCard>
  );
}
