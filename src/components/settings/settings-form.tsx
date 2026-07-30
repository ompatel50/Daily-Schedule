"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/shared/section-card";
import { estimateDailyCalories, lbToKg, suggestMacroGoals } from "@/lib/logic/nutrition";
import { formatMinute } from "@/lib/date";
import { saveGoal, saveSettings } from "@/server/actions/health";
import { User } from "lucide-react";

export interface SettingsValues {
  name: string;
  timezone: string;
  birthDate: string | null;
  heightCm: number | null;
  sex: string | null;
  activityLevel: string;
  weekStartsOn: number;
  unitSystem: string;
  dayStartHour: number;
  dayEndHour: number;
}

export function SettingsForm({
  initial,
  latestWeight,
}: {
  initial: SettingsValues;
  /** Latest logged body weight, in the user's display unit. */
  latestWeight: number | null;
}) {
  const router = useRouter();
  const [form, setForm] = React.useState(initial);
  const [pending, startTransition] = React.useTransition();

  function set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    startTransition(async () => {
      const result = await saveSettings(form);
      if (result.ok) {
        toast.success("Settings saved");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  /** Fill calorie/macro goals from the profile using Mifflin–St Jeor. */
  function suggestGoals() {
    if (!form.birthDate || !form.heightCm || latestWeight === null) {
      toast.error("Add your birth date, height and a body weight entry first");
      return;
    }

    const age = new Date().getFullYear() - new Date(form.birthDate).getFullYear();
    const weightKg = form.unitSystem === "metric" ? latestWeight : lbToKg(latestWeight);
    const calories = estimateDailyCalories({
      weightKg,
      heightCm: form.heightCm,
      age,
      sex: form.sex,
      activityLevel: form.activityLevel,
    });
    const macros = suggestMacroGoals(calories);

    startTransition(async () => {
      const results = await Promise.all([
        saveGoal({ domain: "nutrition", metric: "calories", label: "Daily calories", target: calories, unit: "kcal", direction: "gte", period: "daily", active: true }),
        saveGoal({ domain: "nutrition", metric: "protein", label: "Daily protein", target: macros.protein, unit: "g", direction: "gte", period: "daily", active: true }),
        saveGoal({ domain: "nutrition", metric: "carbs", label: "Daily carbs", target: macros.carbs, unit: "g", direction: "gte", period: "daily", active: true }),
        saveGoal({ domain: "nutrition", metric: "fat", label: "Daily fat", target: macros.fat, unit: "g", direction: "gte", period: "daily", active: true }),
      ]);

      if (results.every((result) => result.ok)) {
        toast.success(`Goals set to ${calories} kcal`, {
          description: `${macros.protein}g protein · ${macros.carbs}g carbs · ${macros.fat}g fat`,
        });
        router.refresh();
      } else {
        toast.error("Couldn't save all goals");
      }
    });
  }

  return (
    <SectionCard
      title="Profile & preferences"
      icon={User}
      accent="text-domain-planner"
      action={
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Save />}
          Save
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={form.name} onChange={(event) => set("name", event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-tz">Timezone</Label>
            <Input
              id="s-tz"
              value={form.timezone}
              onChange={(event) => set("timezone", event.target.value)}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="s-birth">Birth date</Label>
            <Input
              id="s-birth"
              type="date"
              value={form.birthDate ?? ""}
              onChange={(event) => set("birthDate", event.target.value || null)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-height">Height (cm)</Label>
            <Input
              id="s-height"
              type="number"
              min={0}
              value={form.heightCm ?? ""}
              onChange={(event) =>
                set("heightCm", event.target.value === "" ? null : Number(event.target.value))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-sex">Sex</Label>
            <Select
              value={form.sex ?? "unset"}
              onValueChange={(value) => set("sex", value === "unset" ? null : value)}
            >
              <SelectTrigger id="s-sex">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unset">Not set</SelectItem>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-activity">Activity level</Label>
            <Select
              value={form.activityLevel}
              onValueChange={(value) => set("activityLevel", value)}
            >
              <SelectTrigger id="s-activity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sedentary">Sedentary</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="athlete">Athlete</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="s-units">Units</Label>
            <Select value={form.unitSystem} onValueChange={(value) => set("unitSystem", value)}>
              <SelectTrigger id="s-units">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="imperial">Imperial (lb, mi)</SelectItem>
                <SelectItem value="metric">Metric (kg, km)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-weekstart">Week starts on</Label>
            <Select
              value={String(form.weekStartsOn)}
              onValueChange={(value) => set("weekStartsOn", Number(value))}
            >
              <SelectTrigger id="s-weekstart">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Monday</SelectItem>
                <SelectItem value="0">Sunday</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-daystart">Day starts</Label>
            <Select
              value={String(form.dayStartHour)}
              onValueChange={(value) => set("dayStartHour", Number(value))}
            >
              <SelectTrigger id="s-daystart">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, hour) => (
                  <SelectItem key={hour} value={String(hour)}>
                    {formatMinute(hour * 60)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-dayend">Day ends</Label>
            <Select
              value={String(form.dayEndHour)}
              onValueChange={(value) => set("dayEndHour", Number(value))}
            >
              <SelectTrigger id="s-dayend">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, index) => index + 1).map((hour) => (
                  <SelectItem key={hour} value={String(hour)}>
                    {formatMinute((hour % 24) * 60)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-3">
          <div>
            <p className="text-sm font-medium">Suggest nutrition goals</p>
            <p className="text-xs text-muted-foreground">
              Estimates daily calories and a 30/40/30 macro split from your profile and latest weight.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={suggestGoals} disabled={pending}>
            <Sparkles /> Calculate
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
