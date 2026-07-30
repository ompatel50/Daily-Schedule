import {
  Apple,
  CalendarDays,
  CalendarRange,
  Dumbbell,
  HeartPulse,
  LayoutDashboard,
  LineChart,
  Repeat,
  Settings,
  Sun,
} from "lucide-react";

import { SURFACE_ROLES } from "@/lib/logic/surfaces";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof Sun;
  /** Single-key shortcut, pressed after `g` (e.g. `g d` → Dashboard). */
  shortcut: string;
  description: string;
  accent: string;
}

export const NAV_ITEMS: NavItem[] = [
  // Dashboard / Today / Planner take their wording from the one ownership table
  // in `lib/logic/surfaces`, so the sidebar and the command palette can never
  // describe a surface as doing something it no longer does.
  {
    href: SURFACE_ROLES.dashboard.href,
    label: SURFACE_ROLES.dashboard.label,
    icon: LayoutDashboard,
    shortcut: "d",
    description: SURFACE_ROLES.dashboard.purpose,
    accent: "text-domain-planner",
  },
  {
    href: SURFACE_ROLES.today.href,
    label: SURFACE_ROLES.today.label,
    icon: Sun,
    shortcut: "t",
    description: SURFACE_ROLES.today.purpose,
    accent: "text-amber-500",
  },
  {
    href: SURFACE_ROLES.planner.href,
    label: SURFACE_ROLES.planner.label,
    icon: CalendarDays,
    shortcut: "p",
    description: SURFACE_ROLES.planner.purpose,
    accent: "text-domain-planner",
  },
  {
    href: "/nutrition",
    label: "Nutrition",
    icon: Apple,
    shortcut: "n",
    description: "Log meals and track macros",
    accent: "text-domain-nutrition",
  },
  {
    href: "/workouts",
    label: "Workouts",
    icon: Dumbbell,
    shortcut: "w",
    description: "Training log and trends",
    accent: "text-domain-workout",
  },
  {
    href: "/habits",
    label: "Habits",
    icon: Repeat,
    shortcut: "h",
    description: "Streaks and consistency",
    accent: "text-domain-habit",
  },
  {
    href: "/health",
    label: "Health",
    icon: HeartPulse,
    shortcut: "e",
    description: "Metrics, trends and private imports",
    accent: "text-domain-health",
  },
  {
    href: "/calendar",
    label: "Calendar",
    icon: CalendarRange,
    shortcut: "c",
    description: "Consistency heatmap",
    accent: "text-domain-health",
  },
  {
    href: "/insights",
    label: "Insights",
    icon: LineChart,
    shortcut: "i",
    description: "Weekly review and trends",
    accent: "text-domain-workout",
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    shortcut: "s",
    description: "Goals, profile and backups",
    accent: "text-muted-foreground",
  },
];

export const KEYBOARD_SHORTCUTS: Array<{ keys: string; action: string; group: string }> = [
  { keys: "⌘K / Ctrl K", action: "Open command palette", group: "Global" },
  { keys: "N", action: "Quick add to the planner", group: "Global" },
  { keys: "/", action: "Search everything", group: "Global" },
  { keys: "?", action: "Show keyboard shortcuts", group: "Global" },
  { keys: "G then D", action: "Go to dashboard", group: "Navigation" },
  { keys: "G then T", action: "Go to today", group: "Navigation" },
  { keys: "G then P", action: "Go to planner", group: "Navigation" },
  { keys: "G then N", action: "Go to nutrition", group: "Navigation" },
  { keys: "G then W", action: "Go to workouts", group: "Navigation" },
  { keys: "G then H", action: "Go to habits", group: "Navigation" },
  { keys: "G then E", action: "Go to health", group: "Navigation" },
  { keys: "G then C", action: "Go to calendar", group: "Navigation" },
  { keys: "G then I", action: "Go to insights", group: "Navigation" },
  { keys: "J / K", action: "Previous / next day", group: "Planner" },
  { keys: "T", action: "Jump back to today", group: "Planner" },
];
