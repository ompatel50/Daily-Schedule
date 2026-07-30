"use client";

/**
 * The shell's on-demand dialogs, loaded after hydration instead of inside
 * every route's first bundle. The command palette (cmdk) and quick-add form
 * only matter once the user reaches for them; splitting them out shaves the
 * JavaScript every single page ships. Keyboard shortcuts stay eager — they
 * are tiny and must be listening immediately.
 */
import dynamic from "next/dynamic";

export const CommandPalette = dynamic(
  () => import("@/components/layout/command-palette").then((mod) => mod.CommandPalette),
  { ssr: false },
);

export const QuickAddDialog = dynamic(
  () => import("@/components/planner/quick-add-dialog").then((mod) => mod.QuickAddDialog),
  { ssr: false },
);
