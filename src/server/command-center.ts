import "server-only";

import { getFinanceSummary, type FinanceSummary } from "@/server/finance";
import { getInboxSummary, type InboxSummary } from "@/server/inbox";
import { getTaskSummary, type TaskSummary } from "@/server/tasks";

/**
 * The dashboard's life-admin summary — tasks, money, inbox — assembled in one
 * place so the command center and any future surface read identical numbers.
 * Each piece is bounded at its source; nothing here loads full histories.
 */
export interface CommandCenterSummary {
  tasks: TaskSummary;
  finance: FinanceSummary;
  inbox: InboxSummary;
}

export async function getCommandCenterSummary(): Promise<CommandCenterSummary> {
  const [tasks, finance, inbox] = await Promise.all([
    getTaskSummary(),
    getFinanceSummary(),
    getInboxSummary(),
  ]);
  return { tasks, finance, inbox };
}
