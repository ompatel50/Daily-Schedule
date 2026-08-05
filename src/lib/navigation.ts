import {
  Apple,
  Bot,
  CalendarDays,
  CalendarRange,
  CheckSquare,
  Dumbbell,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  LineChart,
  Repeat,
  Settings,
  Sun,
  Wallet,
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
    href: "/tasks",
    label: "Tasks",
    icon: CheckSquare,
    shortcut: "a",
    description: "Projects, next actions and due dates",
    accent: "text-domain-task",
  },
  {
    href: "/inbox",
    label: "Inbox",
    icon: Inbox,
    shortcut: "b",
    description: "One queue for life admin scraps",
    accent: "text-amber-500",
  },
  {
    href: "/finance",
    label: "Finance",
    icon: Wallet,
    shortcut: "f",
    description: "Accounts, bills and savings goals",
    accent: "text-domain-finance",
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
    href: "/assistant",
    label: "Assistant",
    icon: Bot,
    shortcut: "x",
    description: "Ask about your data — private, local Ollama only",
    accent: "text-violet-500",
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

/**
 * The one active-route rule, shared by the sidebar, the mobile drawer and the
 * topbar title. Root matches exactly; everything else matches its subtree.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

/**
 * Drawer sections. Everything stays one tap away — grouping is headings, not
 * folding — but the phone drawer reads as four short lists instead of one
 * fourteen-item column.
 */
export const NAV_GROUPS: Array<{ label: string; hrefs: string[] }> = [
  { label: "Plan", hrefs: ["/", "/today", "/planner", "/tasks", "/inbox"] },
  { label: "Track", hrefs: ["/habits", "/nutrition", "/workouts", "/health"] },
  { label: "Review", hrefs: ["/calendar", "/insights", "/finance"] },
  { label: "App", hrefs: ["/assistant", "/settings"] },
];

export const KEYBOARD_SHORTCUTS: Array<{ keys: string; action: string; group: string }> = [
  { keys: "⌘K / Ctrl K", action: "Open command palette", group: "Global" },
  { keys: "N", action: "Quick add to the planner", group: "Global" },
  { keys: "/", action: "Search everything", group: "Global" },
  { keys: "?", action: "Show keyboard shortcuts", group: "Global" },
  { keys: "G then D", action: "Go to dashboard", group: "Navigation" },
  { keys: "G then T", action: "Go to today", group: "Navigation" },
  { keys: "G then P", action: "Go to planner", group: "Navigation" },
  { keys: "G then A", action: "Go to tasks", group: "Navigation" },
  { keys: "G then B", action: "Go to inbox", group: "Navigation" },
  { keys: "G then F", action: "Go to finance", group: "Navigation" },
  { keys: "G then N", action: "Go to nutrition", group: "Navigation" },
  { keys: "G then W", action: "Go to workouts", group: "Navigation" },
  { keys: "G then H", action: "Go to habits", group: "Navigation" },
  { keys: "G then E", action: "Go to health", group: "Navigation" },
  { keys: "G then C", action: "Go to calendar", group: "Navigation" },
  { keys: "G then I", action: "Go to insights", group: "Navigation" },
  { keys: "G then X", action: "Go to assistant", group: "Navigation" },
  { keys: "J / K", action: "Previous / next day", group: "Planner" },
  { keys: "T", action: "Jump back to today", group: "Planner" },
];
