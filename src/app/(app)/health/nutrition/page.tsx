import type { Metadata } from "next";
import Link from "next/link";
import { Utensils } from "lucide-react";

import { HealthGroupPage } from "@/components/health/group-page";
import { rangeFromParam } from "@/lib/health-ranges";
import { getGroupView } from "@/server/health-module";

export const metadata: Metadata = { title: "Nutrition · Health" };
export const dynamic = "force-dynamic";

export default async function HealthNutritionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const range = rangeFromParam((await searchParams).range);
  const view = await getGroupView("nutrition", range);

  return (
    <HealthGroupPage
      title="Nutrition"
      description="Energy, macronutrients, vitamins and minerals as your export recorded them"
      icon={Utensils}
      view={view}
      range={range}
    >
      <p className="mb-4 rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
        These are the nutrition figures <strong>imported from Apple Health</strong>. Meals you log
        in this app live in{" "}
        <Link href="/nutrition" className="underline underline-offset-2">
          Nutrition
        </Link>{" "}
        and are kept separate on purpose — the two are different records of the same days, and
        merging them would double-count every meal.
      </p>
    </HealthGroupPage>
  );
}
