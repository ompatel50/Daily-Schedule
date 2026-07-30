"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Clock,
  CloudOff,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
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
import { MEAL_TYPE_META, MEAL_TYPES, type MealType } from "@/lib/enums";
import { nutrientSnapshotFor } from "@/lib/logic/nutrition";
import { cn, formatNumber } from "@/lib/utils";
import { BarcodeScannerButton } from "@/components/nutrition/barcode-scanner";
import { logFood, toggleFavoriteFood } from "@/server/actions/nutrition";
import {
  loadRecentFoodsAction,
  searchFoodsAction,
  type FoodResultView,
  type ProviderNotice,
} from "@/server/actions/food-search";

/** Kept as the page's prop type; every row is now a normalised result. */
export type FoodOption = FoodResultView;

const MIN_QUERY = 2;
const DEBOUNCE_MS = 220;
/** The server's recent-foods page size; a full first page means "maybe more". */
const RECENT_PAGE_SIZE = 12;

/**
 * The food logging flow: search → pick → adjust serving → log.
 *
 * Favourites and recents are shown up front because in practice most days
 * repeat the same dozen foods, and those never need the network. Provider
 * results are additive: if USDA is unconfigured or Open Food Facts is down, the
 * local half of the answer still arrives and the page says why the rest did not.
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
  const [results, setResults] = React.useState<FoodResultView[]>([]);
  const [notices, setNotices] = React.useState<ProviderNotice[]>([]);
  const [setup, setSetup] = React.useState<Array<{ provider: string; label: string; hint: string }>>([]);
  const [searching, setSearching] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [selected, setSelected] = React.useState<FoodResultView | null>(null);
  const [online, setOnline] = React.useState(true);
  const [attempt, setAttempt] = React.useState(0);

  // Pages of recents past the dozen the server rendered. A full first page is
  // the only hint another one may exist.
  const [moreRecent, setMoreRecent] = React.useState<FoodResultView[]>([]);
  const [recentOffset, setRecentOffset] = React.useState<number | null>(
    recent.length >= RECENT_PAGE_SIZE ? RECENT_PAGE_SIZE : null,
  );
  const [loadingRecent, setLoadingRecent] = React.useState(false);

  const favoriteSet = React.useMemo(() => new Set(favoriteIds), [favoriteIds]);
  const term = query.trim();
  const active = term.length >= MIN_QUERY;

  // Offline is a first-class state: local food still works, so the message says
  // what is unavailable rather than implying the page is broken.
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  React.useEffect(() => {
    if (!active) {
      setResults([]);
      setNotices([]);
      setFailed(false);
      setSearching(false);
      return;
    }

    setSearching(true);
    setFailed(false);
    let cancelled = false;

    const handle = setTimeout(async () => {
      try {
        const response = await searchFoodsAction(term, { localOnly: !navigator.onLine });
        if (cancelled) return;
        setResults(response.results);
        setNotices(response.notices);
        setSetup(response.setup);
      } catch {
        // The action itself failed — a dropped connection mid-request, say.
        // Nothing typed is lost; the query stays and Retry re-runs it.
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [term, active, attempt]);

  const retry = () => setAttempt((value) => value + 1);

  const loadMoreRecent = () => {
    if (recentOffset === null || loadingRecent) return;
    setLoadingRecent(true);
    loadRecentFoodsAction(recentOffset)
      .then((page) => {
        setMoreRecent((current) => {
          // The list may have shifted since render; a food already shown stays shown once.
          const seen = new Set(
            [...recent, ...current].map((food) => food.id).filter((id): id is string => id !== null),
          );
          return [...current, ...page.foods.filter((food) => !food.id || !seen.has(food.id))];
        });
        setRecentOffset(page.nextOffset);
      })
      .catch(() => toast.error("Could not load more recent foods"))
      .finally(() => setLoadingRecent(false));
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search foods — chicken, oats, or a barcode…"
            className="h-10 pl-9"
            aria-label="Search foods"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        {/* A scanned product opens the same log dialog a picked result does. */}
        <BarcodeScannerButton onFound={setSelected} />
      </div>

      {!online && (
        <Notice
          icon={CloudOff}
          tone="muted"
          title="Online food search is unavailable"
          detail="Your foods, favourites, recents and everything you have logged still work normally."
        />
      )}

      {online && failed && (
        <Notice
          icon={AlertTriangle}
          tone="warn"
          title="That search could not be completed"
          detail="Nothing you typed was lost."
          action={
            <Button size="sm" variant="outline" onClick={retry}>
              <RefreshCw /> Retry
            </Button>
          }
        />
      )}

      {online && !failed && notices.length > 0 && (
        <div className="space-y-2">
          {notices.map((notice) => (
            <Notice
              key={notice.provider}
              icon={notice.reason === "rate_limited" ? Clock : AlertTriangle}
              tone="warn"
              title={`${notice.label} is unavailable`}
              detail={`${notice.message} Local results are unaffected.`}
              action={
                <Button size="sm" variant="outline" onClick={retry}>
                  <RefreshCw /> Retry
                </Button>
              }
            />
          ))}
        </div>
      )}

      {online && active && setup.length > 0 && (
        <div className="space-y-2">
          {setup.map((entry) => (
            <Notice
              key={entry.provider}
              icon={Info}
              tone="muted"
              title={`${entry.label} is not set up`}
              detail={entry.hint}
            />
          ))}
        </div>
      )}

      {active ? (
        results.length > 0 ? (
          <FoodList
            foods={results}
            favoriteSet={favoriteSet}
            onPick={setSelected}
            onRouterRefresh={() => router.refresh()}
          />
        ) : searching ? (
          <SkeletonRows />
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            No matches for “{term}”. Add it as a custom food and it&apos;ll be searchable from now on.
          </p>
        )
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
                foods={[...recent, ...moreRecent]}
                favoriteSet={favoriteSet}
                onPick={setSelected}
                onRouterRefresh={() => router.refresh()}
              />
              {recentOffset !== null && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onClick={loadMoreRecent}
                  disabled={loadingRecent}
                >
                  {loadingRecent && <Loader2 className="animate-spin" />}
                  Show more
                </Button>
              )}
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

function Notice({
  icon: Icon,
  tone,
  title,
  detail,
  action,
}: {
  icon: typeof Info;
  tone: "warn" | "muted";
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2.5",
        tone === "warn" ? "border-amber-500/30 bg-amber-500/5" : "bg-muted/40",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          tone === "warn" ? "text-amber-500" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      {action}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-1" aria-hidden>
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-lg border bg-muted/40" />
      ))}
    </div>
  );
}

function FoodList({
  foods,
  favoriteSet,
  onPick,
  onRouterRefresh,
}: {
  foods: FoodResultView[];
  favoriteSet: Set<string>;
  onPick: (food: FoodResultView) => void;
  onRouterRefresh: () => void;
}) {
  const [, startTransition] = React.useTransition();

  return (
    <div className="space-y-1">
      {foods.map((food) => {
        const key = food.id ?? `${food.provider}:${food.externalId}`;
        const favorite = food.id ? favoriteSet.has(food.id) || food.isFavorite : false;

        return (
          <div
            key={key}
            className="group flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors hover:bg-accent/40"
          >
            <button type="button" onClick={() => onPick(food)} className="min-w-0 flex-1 text-left">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-sm font-medium">{food.name}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {food.kind === "branded" ? "Branded" : "Generic"}
                </Badge>
                <Badge variant="muted" className="shrink-0 text-[10px]">
                  {food.sourceLabel}
                </Badge>
                {food.cached && (
                  <Badge variant="muted" className="shrink-0 text-[10px]">
                    Saved
                  </Badge>
                )}
                {food.completeness < 1 && (
                  <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-500">
                    partial data
                  </span>
                )}
              </div>
              <p className="tabular truncate text-xs text-muted-foreground">
                {formatNumber(food.calories)} kcal · P {formatNumber(food.protein, 1)} · C{" "}
                {formatNumber(food.carbs, 1)} · F {formatNumber(food.fat, 1)} · {food.basisLabel}
                {food.brand ? ` · ${food.brand}` : ""}
              </p>
            </button>

            {food.id && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Toggle favourite"
                onClick={() =>
                  startTransition(async () => {
                    const result = await toggleFavoriteFood(food.id as string);
                    if (result.ok) onRouterRefresh();
                    else toast.error(result.error);
                  })
                }
              >
                <Star
                  className={cn(
                    "h-3.5 w-3.5",
                    favorite
                      ? "fill-amber-400 text-amber-400"
                      : "text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100",
                  )}
                />
              </Button>
            )}

            <Button
              size="icon-sm"
              variant="secondary"
              onClick={() => onPick(food)}
              aria-label={`Log ${food.name}`}
            >
              <Plus />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function LogFoodDialog({
  food,
  date,
  defaultMealType,
  onClose,
}: {
  food: FoodResultView | null;
  date: string;
  defaultMealType: MealType;
  onClose: () => void;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = React.useState(1);
  const [unit, setUnit] = React.useState<string>("serving");
  const [mealType, setMealType] = React.useState<MealType>(defaultMealType);
  const [pending, startTransition] = React.useTransition();

  // One key per opening of the dialog. A double-click, a retry after a timeout
  // and a resubmitted form all carry this same value, and the database rejects
  // the second write — the disabled button is only the first line of defence.
  const [idempotencyKey, setIdempotencyKey] = React.useState(newIdempotencyKey);

  const options = food?.servingOptions ?? [];

  React.useEffect(() => {
    if (!food) return;
    setQuantity(1);
    setUnit(food.servingOptions[0]?.unit ?? "g");
    setMealType(defaultMealType);
    setIdempotencyKey(newIdempotencyKey());
  }, [food, defaultMealType]);

  if (!food) return null;

  // The same maths the server will run, so the preview cannot disagree with
  // what gets saved.
  const snapshot = nutrientSnapshotFor(
    {
      name: food.name,
      basis: food.basis,
      servingSize: food.servingSize,
      servingUnit: food.servingUnit,
      servingLabel: food.servingLabel,
      gramsPerMl: food.gramsPerMl,
      servingOptions: food.servingOptions,
      calories: food.calories,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
      fiber: food.fiber,
      sugar: food.sugar,
      sodium: food.sodium,
      extraNutrients: food.extraNutrients,
    },
    quantity,
    unit,
  );

  function submit() {
    if (!food || !snapshot.convertible) return;
    startTransition(async () => {
      const result = await logFood({
        date,
        mealType,
        foodItemId: food.id ?? undefined,
        provider: food.id ? undefined : food.provider,
        externalId: food.id ? undefined : food.externalId ?? undefined,
        quantity,
        unit,
        idempotencyKey,
      });

      if (result.ok) {
        if (result.data.duplicate) {
          toast.info("Already logged", {
            description: "That exact entry was saved a moment ago.",
          });
        } else {
          toast.success(`Logged ${food.name}`, {
            description: `${formatNumber(snapshot.macros.calories)} kcal to ${MEAL_TYPE_META[
              mealType
            ].label.toLowerCase()}`,
          });
        }
        onClose();
        router.refresh();
      } else {
        // The dialog stays open and the values stay put — a failed save must
        // never cost the user what they typed.
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{food.name}</DialogTitle>
          <DialogDescription>
            {food.sourceDetail ?? food.sourceLabel} · nutrients {food.basisLabel}
            {food.brand ? ` · ${food.brand}` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {food.completeness < 1 && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
              This record is incomplete — some nutrients were not published. Missing values are shown
              as blank, not zero.
            </p>
          )}

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
              <Label>Serving</Label>
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Only units this food can honestly be converted to. A
                      volume is offered only when a real density is known. */}
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.unit}>
                      {option.label}
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
            <p className="text-xs text-muted-foreground">{snapshot.description}</p>
            <div className="mt-2 grid grid-cols-4 gap-2 text-center">
              <MacroCell label="kcal" value={snapshot.macros.calories} />
              <MacroCell label="protein" value={snapshot.macros.protein} suffix="g" />
              <MacroCell label="carbs" value={snapshot.macros.carbs} suffix="g" />
              <MacroCell label="fat" value={snapshot.macros.fat} suffix="g" />
            </div>
          </div>

          <Button
            className="w-full"
            onClick={submit}
            disabled={pending || quantity <= 0 || !snapshot.convertible}
          >
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
