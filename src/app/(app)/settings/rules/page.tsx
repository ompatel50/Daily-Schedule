import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { RulesBoard } from "@/components/automation/rules-board";
import { PageHeader } from "@/components/shared/page-header";
import { STARTER_RULES } from "@/lib/logic/automation-library";
import { getAutomationOverview } from "@/server/automation";
import { getUser } from "@/server/queries";

export const metadata: Metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

export default async function RulesPage() {
  const user = await getUser();
  const rules = await getAutomationOverview(user.id);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Automations"
        description="If-this-then-that over your own data. Every rule is reviewed with a dry run before it may run, every execution is logged, and everything a rule does can be undone."
      />
      <div className="space-y-4">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to settings
        </Link>
        <RulesBoard rules={rules} starters={STARTER_RULES} />
      </div>
    </div>
  );
}
