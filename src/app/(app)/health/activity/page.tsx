import type { Metadata } from "next";
import { Activity } from "lucide-react";

import { HealthGroupPage } from "@/components/health/group-page";
import { rangeFromParam } from "@/lib/health-ranges";
import { getGroupView } from "@/server/health-module";

export const metadata: Metadata = { title: "Activity · Health" };
export const dynamic = "force-dynamic";

export default async function HealthActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const view = await getGroupView("activity", range);

  return (
    <HealthGroupPage
      title="Activity"
      description="Steps, distance, calories, exercise and stand time"
      icon={Activity}
      view={view}
      range={range}
    />
  );
}
