import type { Metadata } from "next";
import type { FoodItem } from "@prisma/client";
import { Apple, Bookmark, Flame, PieChart, Search, TrendingUp } from "lucide-react";

import { CustomFoodDialog } from "@/components/nutrition/custom-food-dialog";
import { FoodSearch, type FoodOption } from "@/components/nutrition/food-search";
import { MealList, type MealView } from "@/components/nutrition/meal-list";
import { MealTemplateBar } from "@/components/nutrition/meal-template-bar";
import { CategoryBarChart, MacroDonut } from "@/components/shared/charts";
import { DateNav } from "@/components/shared/date-nav";
import { PageHeader } from "@/components/shared/page-header";
import { SectionCard } from "@/components/shared/section-card";
import { StatCard } from "@/components/shared/stat-card";
import { formatDay, isDayKey, lastNDays, shiftDay } from "@/lib/date";
import { macroSplit, totalMacros } from "@/lib/logic/nutrition";
import { availableUnits } from "@/lib/logic/servings";
import { average, formatNumber, pct } from "@/lib/utils";
import {
  getToday,
  getDayNutrition,
  getFoodShortcuts,
  getGoalMap,
  getMealTemplates,
  getUser,
} from "@/server/queries";
import { getSummaries } from "@/server/summaries";
import { rowToNormalizedFood, toResultView } from "@/server/food";


export const metadata: Metadata = { title: "Nutrition" };
export const dynamic = "force-dynamic";

/**
 * Favourites and recents go through the same normaliser as a search result, so
 * a row rendered from the shortcuts list and the identical row rendered from a
 * search carry the same serving options, source label and completeness.
 */
function toFoodOption(food: FoodItem, isFavorite: boolean, isRecent: boolean): FoodOption {
  return toResultView({
    ...rowToNormalizedFood(food),
    isFavorite,
    isRecent,
    origin: isFavorite ? "favorite" : isRecent ? "recent" : food.cached ? "cache" : "local",
  });
}

export default async function NutritionPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const params = await searchParams;
  const todayKey = await getToday();
  const date = params.date && isDayKey(params.date) ? params.date : todayKey;

  const user = await getUser();
  const [{ meals, totals }, shortcuts, templates, goals, weekSummaries] = await Promise.all([
    getDayNutrition(date),
    getFoodShortcuts(),
    getMealTemplates(),
    getGoalMap(),
    getSummaries(user.id, shiftDay(date, -13), date),
  ]);

  const calorieGoal = goals.get("calories")?.target ?? 0;
  const proteinGoal = goals.get("protein")?.target ?? 0;
  const carbGoal = goals.get("carbs")?.target ?? 0;
  const fatGoal = goals.get("fat")?.target ?? 0;

  const split = macroSplit(totals);
  const summaryByDate = new Map(weekSummaries.map((summary) => [summary.date, summary]));

  const trend = lastNDays(14, date).map((day) => {
    const summary = summaryByDate.get(day);
    return {
      label: formatDay(day, "M/d"),
      calories: summary?.calories ?? 0,
      day,
    };
  });

  const loggedDays = trend.filter((point) => point.calories > 0);
  const avgCalories = average(loggedDays.map((point) => point.calories));
  const avgProtein = average(
    weekSummaries.filter((summary) => summary.calories > 0).map((summary) => summary.protein),
  );

  const mealViews: MealView[] = meals.map((meal) => ({
    id: meal.id,
    type: meal.type,
    label: meal.label,
    totals: meal.totals,
    entries: meal.entries.map((entry) => ({
      id: entry.id,
      // The name recorded at log time wins: a food renamed later must not
      // rewrite what a past day says was eaten.
      foodName: entry.foodNameAtLog ?? entry.foodItem.name,
      quantity: entry.quantity,
      unit: entry.unit,
      units: availableUnits(rowToNormalizedFood(entry.foodItem)),
      mealType: meal.type,
      date,
      calories: entry.calories,
      protein: entry.protein,
      carbs: entry.carbs,
      fat: entry.fat,
    })),
  }));

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Nutrition"
        description="Search, log, and keep an eye on the trend — not just the day."
        actions={
          <div className="flex items-center gap-2">
            <CustomFoodDialog />
            <DateNav date={date} weekStartsOn={user.weekStartsOn === 0 ? 0 : 1} />
          </div>
        }
      />

      <div className="stat-grid mb-6">
        <StatCard
          label="Calories"
          value={formatNumber(totals.calories)}
          hint={calorieGoal > 0 ? `of ${formatNumber(calorieGoal)} kcal` : "set a goal in Settings"}
          icon={Flame}
          accent="text-domain-nutrition"
          progress={pct(totals.calories, calorieGoal)}
          progressClassName="bg-domain-nutrition"
        />
        <StatCard
          label="Protein"
          value={`${formatNumber(totals.protein, 1)} g`}
          hint={proteinGoal > 0 ? `of ${formatNumber(proteinGoal)} g` : `${split.protein}% of calories`}
          icon={Apple}
          accent="text-domain-health"
          progress={pct(totals.protein, proteinGoal)}
          progressClassName="bg-domain-health"
        />
        <StatCard
          label="Carbs"
          value={`${formatNumber(totals.carbs, 1)} g`}
          hint={carbGoal > 0 ? `of ${formatNumber(carbGoal)} g` : `${split.carbs}% of calories`}
          icon={PieChart}
          accent="text-amber-500"
          progress={pct(totals.carbs, carbGoal)}
          progressClassName="bg-amber-500"
        />
        <StatCard
          label="Fat"
          value={`${formatNumber(totals.fat, 1)} g`}
          hint={fatGoal > 0 ? `of ${formatNumber(fatGoal)} g` : `${split.fat}% of calories`}
          icon={PieChart}
          accent="text-domain-workout"
          progress={pct(totals.fat, fatGoal)}
          progressClassName="bg-domain-workout"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <SectionCard title="Log food" icon={Search} accent="text-domain-nutrition">
            <FoodSearch
              date={date}
              favorites={shortcuts.favorites.map((food) => toFoodOption(food, true, true))}
              recent={shortcuts.recent.map((food) =>
                toFoodOption(food, shortcuts.favoriteIds.has(food.id), true),
              )}
              favoriteIds={Array.from(shortcuts.favoriteIds)}
            />
          </SectionCard>

          {templates.length > 0 && (
            <SectionCard
              title="Meal templates"
              icon={Bookmark}
              accent="text-domain-nutrition"
              description="One click to log a repeat meal"
            >
              <MealTemplateBar
                date={date}
                templates={templates.map((template) => ({
                  id: template.id,
                  name: template.name,
                  mealType: template.mealType,
                  itemCount: template.items.length,
                  calories: totalMacros(
                    template.items.map((item) => ({
                      calories: item.foodItem.calories * (item.quantity || 1),
                    })),
                  ).calories,
                  useCount: template.useCount,
                }))}
              />
            </SectionCard>
          )}

          <SectionCard
            title="Today's meals"
            icon={Apple}
            accent="text-domain-nutrition"
            description={
              totals.calories > 0
                ? `${formatNumber(totals.calories)} kcal across ${meals.length} ${meals.length === 1 ? "meal" : "meals"}`
                : "Nothing logged yet"
            }
          >
            <MealList meals={mealViews} />
          </SectionCard>
        </div>

        <div className="space-y-6 lg:col-span-2">
          <SectionCard title="Macro split" icon={PieChart} accent="text-domain-nutrition">
            <MacroDonut protein={totals.protein} carbs={totals.carbs} fat={totals.fat} />
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <SplitCell label="Protein" value={split.protein} color="bg-domain-health" />
              <SplitCell label="Carbs" value={split.carbs} color="bg-domain-nutrition" />
              <SplitCell label="Fat" value={split.fat} color="bg-domain-workout" />
            </div>
          </SectionCard>

          <SectionCard
            title="14-day trend"
            icon={TrendingUp}
            accent="text-domain-nutrition"
            description={
              loggedDays.length > 0
                ? `${formatNumber(avgCalories)} kcal average on logged days`
                : "Log a few days to see the trend"
            }
          >
            <CategoryBarChart
              data={trend}
              dataKey="calories"
              height={180}
              unit=" kcal"
              color="hsl(var(--domain-nutrition))"
              highlight={date}
            />
          </SectionCard>

          <SectionCard title="Other nutrients" icon={Apple} accent="text-muted-foreground">
            <div className="space-y-2 text-sm">
              <NutrientRow label="Fiber" value={`${formatNumber(totals.fiber, 1)} g`} />
              <NutrientRow label="Sugar" value={`${formatNumber(totals.sugar, 1)} g`} />
              <NutrientRow label="Sodium" value={`${formatNumber(totals.sodium)} mg`} />
              <NutrientRow
                label="Protein avg (14d)"
                value={avgProtein > 0 ? `${formatNumber(avgProtein, 1)} g` : "—"}
              />
              <NutrientRow
                label="Days logged (14d)"
                value={`${loggedDays.length}/14`}
              />
            </div>
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

function SplitCell({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-2">
      <div className="flex items-center justify-center gap-1.5">
        <span className={`h-2 w-2 rounded-full ${color}`} />
        <span className="tabular text-sm font-semibold">{value}%</span>
      </div>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

function NutrientRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b pb-1.5 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-medium">{value}</span>
    </div>
  );
}
