import type { Metadata } from "next";
import { HeartPulse } from "lucide-react";

import { HealthGroupPage } from "@/components/health/group-page";
import { rangeFromParam } from "@/lib/health-ranges";
import { getGroupView } from "@/server/health-module";

export const metadata: Metadata = { title: "Heart · Health" };
export const dynamic = "force-dynamic";

export default async function HealthHeartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const view = await getGroupView("heart", range);

  return (
    <HealthGroupPage
      title="Heart"
      description="Heart rate, resting and walking rate, variability and VO₂ max"
      icon={HeartPulse}
      view={view}
      range={range}
      chart="line"
    />
  );
}
