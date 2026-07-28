"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { WeekdayPicker } from "@/components/shared/weekday-picker";
import { minuteToTimeValue, parseTimeToMinute } from "@/lib/date";
import { describeSchedule, type ScheduleMode } from "@/lib/logic/schedule";
import { TIME_OF_DAY_META, TIMES_OF_DAY } from "@/lib/enums";

/**
 * The schedule half of the goal and habit forms.
 *
 * Deliberately one component: a goal scheduled Mon/Wed/Fri and a habit
 * scheduled Mon/Wed/Fri are the same question, and two copies of this form
 * would be two places for the answer to drift.
 */

export interface ScheduleDraft {
  mode: ScheduleMode;
  weekdays: number[];
  interval: number;
  timesPerWeek: number | null;
  monthDay: number | null;
  enabled: boolean;
  daypart: string;
  timeMinute: number | null;
  reminderEnabled: boolean;
  reminderMinute: number | null;
}

export function emptyScheduleDraft(): ScheduleDraft {
  return {
    mode: "every_day",
    weekdays: [],
    interval: 1,
    timesPerWeek: null,
    monthDay: null,
    enabled: true,
    daypart: "anytime",
    timeMinute: null,
    reminderEnabled: false,
    reminderMinute: null,
  };
}

const MODE_OPTIONS: Array<{ value: ScheduleMode; label: string; hint: string }> = [
  { value: "every_day", label: "Every day", hint: "Seven days a week" },
  { value: "weekdays", label: "Selected days", hint: "Pick the exact weekdays" },
  { value: "times_per_week", label: "Times per week", hint: "Any days — judged weekly" },
  { value: "one_time", label: "One time", hint: "A single date" },
  { value: "interval_days", label: "Every N days", hint: "Repeat on an interval" },
  { value: "interval_weeks", label: "Every N weeks", hint: "On chosen weekdays" },
  { value: "monthly", label: "Monthly", hint: "On a day of the month" },
];

const PRESETS: Array<{ label: string; mode: ScheduleMode; weekdays: number[] }> = [
  { label: "Every day", mode: "every_day", weekdays: [] },
  { label: "Weekdays", mode: "weekdays", weekdays: [1, 2, 3, 4, 5] },
  { label: "Weekends", mode: "weekdays", weekdays: [0, 6] },
];

export interface ScheduleEditorProps {
  value: ScheduleDraft;
  onChange: (draft: ScheduleDraft) => void;
  weekStartsOn?: 0 | 1;
  /** Habits use dayparts; goals mostly do not. */
  showDaypart?: boolean;
  showReminder?: boolean;
  idPrefix?: string;
  errors?: Record<string, string[] | undefined>;
}

export function ScheduleEditor({
  value,
  onChange,
  weekStartsOn = 1,
  showDaypart = true,
  showReminder = true,
  idPrefix = "schedule",
  errors,
}: ScheduleEditorProps) {
  const patch = (changes: Partial<ScheduleDraft>) => onChange({ ...value, ...changes });

  const activePreset = PRESETS.find(
    (preset) =>
      preset.mode === value.mode &&
      (preset.mode !== "weekdays" ||
        (preset.weekdays.length === value.weekdays.length &&
          preset.weekdays.every((day) => value.weekdays.includes(day)))),
  );

  const summary = describeSchedule({
    id: "preview",
    effectiveFrom: "1970-01-01",
    effectiveTo: null,
    mode: value.mode,
    interval: value.interval,
    timesPerWeek: value.timesPerWeek,
    monthDay: value.monthDay,
    enabled: value.enabled,
    daypart: value.daypart,
    timeMinute: value.timeMinute,
    reminderEnabled: value.reminderEnabled,
    reminderMinute: value.reminderMinute,
    weekdays: value.weekdays,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            size="sm"
            variant={activePreset?.label === preset.label ? "default" : "outline"}
            aria-pressed={activePreset?.label === preset.label}
            onClick={() => patch({ mode: preset.mode, weekdays: preset.weekdays })}
          >
            {preset.label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant={value.mode === "weekdays" && !activePreset ? "default" : "outline"}
          aria-pressed={value.mode === "weekdays" && !activePreset}
          onClick={() => patch({ mode: "weekdays" })}
        >
          Custom days
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-mode`}>Repeats</Label>
          <Select
            value={value.mode}
            onValueChange={(next) =>
              patch({
                mode: next as ScheduleMode,
                timesPerWeek:
                  next === "times_per_week" ? (value.timesPerWeek ?? 3) : value.timesPerWeek,
              })
            }
          >
            <SelectTrigger id={`${idPrefix}-mode`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {MODE_OPTIONS.find((option) => option.value === value.mode)?.hint}
          </p>
        </div>

        {(value.mode === "interval_days" || value.mode === "interval_weeks") && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-interval`}>
              Every {value.mode === "interval_days" ? "N days" : "N weeks"}
            </Label>
            <Input
              id={`${idPrefix}-interval`}
              type="number"
              min={1}
              max={365}
              value={value.interval}
              onChange={(event) => patch({ interval: Math.max(1, Number(event.target.value) || 1) })}
            />
          </div>
        )}

        {value.mode === "times_per_week" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-tpw`}>Times per week</Label>
            <Input
              id={`${idPrefix}-tpw`}
              type="number"
              min={1}
              max={7}
              value={value.timesPerWeek ?? 3}
              aria-invalid={Boolean(errors?.timesPerWeek)}
              onChange={(event) =>
                patch({
                  timesPerWeek: Math.min(7, Math.max(1, Number(event.target.value) || 1)),
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Judged over the whole week — no single day is required.
            </p>
          </div>
        )}

        {value.mode === "monthly" && (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-monthday`}>Day of the month</Label>
            <Input
              id={`${idPrefix}-monthday`}
              type="number"
              min={1}
              max={31}
              value={value.monthDay ?? 1}
              onChange={(event) =>
                patch({ monthDay: Math.min(31, Math.max(1, Number(event.target.value) || 1)) })
              }
            />
          </div>
        )}
      </div>

      {(value.mode === "weekdays" || value.mode === "interval_weeks") && (
        <div className="space-y-1.5">
          <Label id={`${idPrefix}-days-label`}>Days</Label>
          <WeekdayPicker
            value={value.weekdays}
            onChange={(weekdays) => patch({ weekdays })}
            weekStartsOn={weekStartsOn}
            label="Days of the week"
            describedBy={`${idPrefix}-days-help`}
            invalid={Boolean(errors?.weekdays)}
          />
          <p id={`${idPrefix}-days-help`} className="text-xs text-muted-foreground">
            {errors?.weekdays?.[0] ??
              "Days you do not select are rest days — they never count as missed."}
          </p>
        </div>
      )}

      {showDaypart && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-daypart`}>Time of day</Label>
            <Select value={value.daypart} onValueChange={(next) => patch({ daypart: next })}>
              <SelectTrigger id={`${idPrefix}-daypart`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMES_OF_DAY.map((slot) => (
                  <SelectItem key={slot} value={slot}>
                    {TIME_OF_DAY_META[slot].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-time`}>Specific time (optional)</Label>
            <Input
              id={`${idPrefix}-time`}
              type="time"
              value={value.timeMinute === null ? "" : minuteToTimeValue(value.timeMinute)}
              onChange={(event) =>
                patch({
                  timeMinute: event.target.value ? parseTimeToMinute(event.target.value) : null,
                })
              }
            />
          </div>
        </div>
      )}

      {showReminder && (
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor={`${idPrefix}-reminder`}>Reminder</Label>
              <p className="text-xs text-muted-foreground">
                Only fires on days this is actually scheduled, and never once it is done.
              </p>
            </div>
            <Switch
              id={`${idPrefix}-reminder`}
              checked={value.reminderEnabled}
              onCheckedChange={(checked) =>
                patch({
                  reminderEnabled: checked,
                  reminderMinute: checked ? (value.reminderMinute ?? 9 * 60) : value.reminderMinute,
                })
              }
            />
          </div>
          {value.reminderEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-reminder-time`}>Remind me at</Label>
              <Input
                id={`${idPrefix}-reminder-time`}
                type="time"
                className="max-w-40"
                value={
                  value.reminderMinute === null ? "" : minuteToTimeValue(value.reminderMinute)
                }
                onChange={(event) =>
                  patch({
                    reminderMinute: event.target.value
                      ? parseTimeToMinute(event.target.value)
                      : null,
                  })
                }
              />
            </div>
          )}
        </div>
      )}

      <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        Schedule preview: <span className="font-medium text-foreground">{summary}</span>
      </p>
    </div>
  );
}
