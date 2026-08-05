import type { Metadata } from "next";

import { AssistantChat } from "@/components/assistant/assistant-chat";
import { PageHeader } from "@/components/shared/page-header";
import { isAssistantMode } from "@/lib/logic/assistant";
import { listAuditEntries } from "@/server/ai/audit";
import { listRecentProposals } from "@/server/ai/proposals";
import { getUser } from "@/server/queries";

export const metadata: Metadata = { title: "Assistant" };
export const dynamic = "force-dynamic";

/**
 * The assistant page: a private chat over the user's own data, powered by
 * the user's own Ollama server. The server component loads settings and
 * recent activity; everything conversational is client state — transcripts
 * are deliberately not persisted.
 */
export default async function AssistantPage() {
  const user = await getUser();
  const [proposals, audit] = await Promise.all([
    listRecentProposals(user.id, 20),
    listAuditEntries(user.id, 20),
  ]);

  return (
    <div className="mx-auto max-w-4xl pb-safe">
      <PageHeader
        title="Assistant"
        description="Ask about your days, tasks, money and health. Runs only on your own Ollama server — nothing leaves your machines."
      />
      <AssistantChat
        configured={Boolean(user.assistantBaseUrl && user.assistantModel)}
        model={user.assistantModel}
        mode={isAssistantMode(user.assistantMode) ? user.assistantMode : "readonly"}
        initialProposals={proposals}
        initialAudit={audit}
      />
    </div>
  );
}
