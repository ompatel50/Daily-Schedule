"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { FOOD_CATEGORIES, type FoodCategory } from "@/lib/enums";
import { titleCase } from "@/lib/utils";
import { saveFoodItem } from "@/server/actions/nutrition";

/**
 * Anything the bundled database doesn't have can be added here in ~20 seconds.
 * Custom foods behave exactly like built-in ones everywhere else.
 */
export function CustomFoodDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  const [form, setForm] = React.useState({
    name: "",
    brand: "",
    basis: "per_serving" as "per_100g" | "per_serving",
    servingSize: 1,
    servingUnit: "serving",
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sugar: 0,
    sodium: 0,
    category: "other" as FoodCategory,
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    startTransition(async () => {
      const result = await saveFoodItem({ ...form, brand: form.brand || null });
      if (result.ok) {
        toast.success(`${form.name} added to your food list`);
        setOpen(false);
        setForm((current) => ({ ...current, name: "", brand: "", calories: 0, protein: 0, carbs: 0, fat: 0 }));
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus /> Custom food
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a custom food</DialogTitle>
          <DialogDescription>
            Enter the nutrition panel exactly as it&apos;s printed, then pick which basis it uses.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="food-name">Name</Label>
              <Input
                id="food-name"
                autoFocus
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Overnight oats"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="food-brand">Brand (optional)</Label>
              <Input
                id="food-brand"
                value={form.brand}
                onChange={(event) => set("brand", event.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Values are</Label>
              <Select
                value={form.basis}
                onValueChange={(value) => set("basis", value as "per_100g" | "per_serving")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_serving">Per serving</SelectItem>
                  <SelectItem value="per_100g">Per 100 g</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="serving-size">Serving size</Label>
              <Input
                id="serving-size"
                type="number"
                min={0.1}
                step={0.1}
                value={form.servingSize}
                onChange={(event) => set("servingSize", Number(event.target.value) || 0)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="serving-unit">Unit</Label>
              <Input
                id="serving-unit"
                value={form.servingUnit}
                onChange={(event) => set("servingUnit", event.target.value)}
                placeholder="g"
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <NumberField label="Calories" value={form.calories} onChange={(value) => set("calories", value)} />
            <NumberField label="Protein (g)" value={form.protein} onChange={(value) => set("protein", value)} />
            <NumberField label="Carbs (g)" value={form.carbs} onChange={(value) => set("carbs", value)} />
            <NumberField label="Fat (g)" value={form.fat} onChange={(value) => set("fat", value)} />
            <NumberField label="Fiber (g)" value={form.fiber} onChange={(value) => set("fiber", value)} />
            <NumberField label="Sugar (g)" value={form.sugar} onChange={(value) => set("sugar", value)} />
            <NumberField label="Sodium (mg)" value={form.sodium} onChange={(value) => set("sodium", value)} />
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={form.category} onValueChange={(value) => set("category", value as FoodCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOOD_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {titleCase(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !form.name.trim()}>
            {pending && <Loader2 className="animate-spin" />}
            Add food
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        min={0}
        step={0.1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) || 0)}
      />
    </div>
  );
}
