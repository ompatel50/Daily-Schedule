"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { WEEKDAY_NAMES } from "@/lib/logic/schedule";

const INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

export interface WeekdayPickerProps {
  value: number[];
  onChange: (weekdays: number[]) => void;
  /** 0 = Sunday first, 1 = Monday first. Matches the user's week-start setting. */
  weekStartsOn?: 0 | 1;
  disabled?: boolean;
  /** Rendered as the group's accessible name. */
  label?: string;
  describedBy?: string;
  invalid?: boolean;
}

/**
 * Seven toggle buttons for picking weekdays.
 *
 * The visible labels are single initials, which means two "T"s and two "S"s.
 * Each button therefore carries the full weekday name as its accessible name —
 * a screen reader announces "Tuesday, pressed", never "T, pressed".
 */
export function WeekdayPicker({
  value,
  onChange,
  weekStartsOn = 1,
  disabled = false,
  label = "Days of the week",
  describedBy,
  invalid = false,
}: WeekdayPickerProps) {
  const order = weekStartsOn === 1 ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6];
  const selected = new Set(value);

  function toggle(day: number) {
    const next = new Set(selected);
    if (next.has(day)) next.delete(day);
    else next.add(day);
    onChange(Array.from(next).sort((a, b) => a - b));
  }

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className="flex flex-wrap gap-1.5"
    >
      {order.map((day) => {
        const isOn = selected.has(day);
        return (
          <button
            key={day}
            type="button"
            disabled={disabled}
            aria-label={WEEKDAY_NAMES.full[day]}
            aria-pressed={isOn}
            aria-invalid={invalid && value.length === 0 ? true : undefined}
            onClick={() => toggle(day)}
            className={cn(
              "h-9 w-9 rounded-md border text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              isOn
                ? "border-primary bg-primary text-primary-foreground"
                : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              invalid && value.length === 0 && "border-destructive",
            )}
          >
            <span aria-hidden="true">{INITIALS[day]}</span>
          </button>
        );
      })}
    </div>
  );
}
