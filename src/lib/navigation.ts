import {
  Apple,
  CalendarDays,
  CalendarRange,
  Dumbbell,
  LayoutDashboard,
  LineChart,
  Repeat,
  Settings,
  Sun,
} from "lucide-react";

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
  {
    href: "/",
    label: "Dashboard",
    icon: LayoutDashboard,
    shortcut: "d",
    description: "Everything at a glance",
    accent: "text-domain-planner",
  },
  {
    href: "/today",
    label: "Today",
    icon: Sun,
    shortcut: "t",
    description: "Your timeline for the day",
    accent: "text-amber-500",
  },
  {
    href: "/planner",
    label: "Planner",
    icon: CalendarDays,
    shortcut: "p",
    description: "Day, week and month views",
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
  { keys: "G then C", action: "Go to calendar", group: "Navigation" },
  { keys: "G then I", action: "Go to insights", group: "Navigation" },
  { keys: "J / K", action: "Previous / next day", group: "Planner" },
  { keys: "T", action: "Jump back to today", group: "Planner" },
];
