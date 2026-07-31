import type { Metadata } from "next";
import { Scale } from "lucide-react";

import { HealthGroupPage } from "@/components/health/group-page";
import { rangeFromParam } from "@/lib/health-ranges";
import { getGroupView } from "@/server/health-module";

export const metadata: Metadata = { title: "Body · Health" };
export const dynamic = "force-dynamic";

export default async function HealthBodyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const view = await getGroupView("body", range);

  return (
    <HealthGroupPage
      title="Body"
      description="Weight, composition and measurements"
      icon={Scale}
      view={view}
      range={range}
      chart="line"
    />
  );
}
