"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Clock, Loader2, Plus, Search, Star } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MEAL_TYPE_META, MEAL_TYPES, SERVING_UNITS, type MealType, type ServingUnit } from "@/lib/enums";
import { describeServing, macrosFor } from "@/lib/logic/nutrition";
import { cn, formatNumber } from "@/lib/utils";
import { logFood, toggleFavoriteFood } from "@/server/actions/nutrition";
import { searchFoodsAction } from "@/server/actions/food-search";

export interface FoodOption {
  id: string;
  name: string;
  brand: string | null;
  basis: string;
  servingSize: number;
  servingUnit: string;
  servingLabel: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodium: number;
  category: string;
  isCustom: boolean;
}

/**
 * The food logging flow: search → pick → adjust serving → log. Favourites and
 * recents are shown up front, because in practice most days repeat the same
 * dozen foods and that's where the speed comes from.
 */
export function FoodSearch({
  date,
  defaultMealType = "breakfast",
  favorites,
  recent,
  favoriteIds,
}: {
  date: string;
  defaultMealType?: MealType;
  favorites: FoodOption[];
  recent: FoodOption[];
  favoriteIds: string[];
}) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<FoodOption[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [selected, setSelected] = React.useState<FoodOption | null>(null);

  const favoriteSet = React.useMemo(() => new Set(favoriteIds), [favoriteIds]);

  React.useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }

    setSearching(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const found = await searchFoodsAction(term);
        if (!cancelled) setResults(found);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query]);

  const showing = query.trim().length >= 2 ? results : [];

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search foods — chicken, oats, greek yogurt…"
          className="h-10 pl-9"
        />
        {searching && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {showing.length > 0 ? (
        <FoodList
          foods={showing}
          favoriteSet={favoriteSet}
          onPick={setSelected}
          onRouterRefresh={() => router.refresh()}
        />
      ) : query.trim().length >= 2 && !searching ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No matches. Add it as a custom food and it&apos;ll be searchable from now on.
        </p>
      ) : (
        <div className="space-y-4">
          {favorites.length > 0 && (
            <div>
              <p className="section-title mb-2 flex items-center gap-1.5">
                <Star className="h-3 w-3" /> Favourites
              </p>
              <FoodList
                foods={favorites}
                favoriteSet={favoriteSet}
                onPick={setSelected}
                onRouterRefresh={() => router.refresh()}
              />
            </div>
          )}
          {recent.length > 0 && (
            <div>
              <p className="section-title mb-2 flex items-center gap-1.5">
                <Clock className="h-3 w-3" /> Recent
              </p>
              <FoodList
                foods={recent}
                favoriteSet={favoriteSet}
                onPick={setSelected}
                onRouterRefresh={() => router.refresh()}
              />
            </div>
          )}
          {favorites.length === 0 && recent.length === 0 && (
            <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              Search for a food to log it. The ones you use most will show up here.
            </p>
          )}
        </div>
      )}

      <LogFoodDialog
        food={selected}
        date={date}
        defaultMealType={defaultMealType}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function FoodList({
  foods,
  favoriteSet,
  onPick,
  onRouterRefresh,
}: {
  foods: FoodOption[];
  favoriteSet: Set<string>;
  onPick: (food: FoodOption) => void;
  onRouterRefresh: () => void;
}) {
  const [, startTransition] = React.useTransition();

  return (
    <div className="space-y-1">
      {foods.map((food) => (
        <div
          key={food.id}
          className="group flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors hover:bg-accent/40"
        >
          <button type="button" onClick={() => onPick(food)} className="min-w-0 flex-1 text-left">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{food.name}</span>
              {food.isCustom && (
                <Badge variant="muted" className="shrink-0 text-[10px]">
                  Custom
                </Badge>
              )}
            </div>
            <p className="tabular truncate text-xs text-muted-foreground">
              {formatNumber(food.calories)} kcal · P {formatNumber(food.protein, 1)} · C{" "}
              {formatNumber(food.carbs, 1)} · F {formatNumber(food.fat, 1)}
              {food.basis === "per_100g" ? " per 100g" : " per serving"}
              {food.brand ? ` · ${food.brand}` : ""}
            </p>
          </button>

          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Toggle favourite"
            onClick={() =>
              startTransition(async () => {
                const result = await toggleFavoriteFood(food.id);
                if (result.ok) onRouterRefresh();
                else toast.error(result.error);
              })
            }
          >
            <Star
              className={cn(
                "h-3.5 w-3.5",
                favoriteSet.has(food.id)
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
              )}
            />
          </Button>

          <Button size="icon-sm" variant="secondary" onClick={() => onPick(food)} aria-label="Log food">
            <Plus />
          </Button>
        </div>
      ))}
    </div>
  );
}

function LogFoodDialog({
  food,
  date,
  defaultMealType,
  onClose,
}: {
  food: FoodOption | null;
  date: string;
  defaultMealType: MealType;
  onClose: () => void;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = React.useState(1);
  const [unit, setUnit] = React.useState<ServingUnit>("serving");
  const [mealType, setMealType] = React.useState<MealType>(defaultMealType);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!food) return;
    setQuantity(1);
    setUnit("serving");
    setMealType(defaultMealType);
  }, [food, defaultMealType]);

  if (!food) return null;

  const macros = macrosFor(food, quantity, unit);

  function submit() {
    if (!food) return;
    startTransition(async () => {
      const result = await logFood({
        date,
        mealType,
        foodItemId: food.id,
        quantity,
        unit,
      });
      if (result.ok) {
        toast.success(`Logged ${food.name}`, {
          description: `${formatNumber(macros.calories)} kcal to ${MEAL_TYPE_META[mealType].label.toLowerCase()}`,
        });
        onClose();
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{food.name}</DialogTitle>
          <DialogDescription>
            {food.servingLabel ??
              (food.basis === "per_100g"
                ? `Default serving ${food.servingSize} ${food.servingUnit}`
                : `Per ${food.servingUnit}`)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="qty">Quantity</Label>
              <Input
                id="qty"
                type="number"
                min={0.1}
                step={0.25}
                autoFocus
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value) || 0)}
                onKeyDown={(event) => event.key === "Enter" && submit()}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Unit</Label>
              <Select value={unit} onValueChange={(value) => setUnit(value as ServingUnit)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SERVING_UNITS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Meal</Label>
            <Select value={mealType} onValueChange={(value) => setMealType(value as MealType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEAL_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {MEAL_TYPE_META[value].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border bg-muted/40 px-3 py-3">
            <p className="text-xs text-muted-foreground">{describeServing(food, quantity, unit)}</p>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center">
              <MacroCell label="kcal" value={macros.calories} />
              <MacroCell label="protein" value={macros.protein} suffix="g" />
              <MacroCell label="carbs" value={macros.carbs} suffix="g" />
              <MacroCell label="fat" value={macros.fat} suffix="g" />
            </div>
          </div>

          <Button className="w-full" onClick={submit} disabled={pending || quantity <= 0}>
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            Log to {MEAL_TYPE_META[mealType].label.toLowerCase()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MacroCell({ label, value, suffix = "" }: { label: string; value: number; suffix?: string }) {
  return (
    <div>
      <p className="tabular text-sm font-semibold leading-none">
        {formatNumber(value, suffix ? 1 : 0)}
        {suffix}
      </p>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}
