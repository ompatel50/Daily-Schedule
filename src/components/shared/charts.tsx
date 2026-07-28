"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { cn } from "@/lib/utils";

/**
 * Thin Recharts wrappers with one shared visual language: no chart junk, muted
 * axes, tabular numbers, and a tooltip that matches the app's popover styling.
 * Every chart reads its colours from CSS variables so dark mode just works.
 */

const AXIS = {
  stroke: "hsl(var(--muted-foreground))",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

/** Keep Y-axis labels narrow: 2400 → "2.4k", so they never clip. */
function compactTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 10000) return `${Math.round(value / 1000)}k`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(value));
}

function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string; dataKey?: string }>;
  label?: string | number;
  formatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      {label !== undefined && <p className="mb-1 font-medium">{label}</p>}
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
          <span className="text-muted-foreground">{entry.name}</span>
          <span className="tabular ml-auto font-medium">
            {formatter && typeof entry.value === "number"
              ? formatter(entry.value, String(entry.name))
              : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface SeriesPoint {
  label: string;
  [key: string]: string | number | null;
}

export function TrendAreaChart({
  data,
  dataKey,
  color = "hsl(var(--domain-planner))",
  height = 200,
  goal,
  unit = "",
  className,
}: {
  data: SeriesPoint[];
  dataKey: string;
  color?: string;
  height?: number;
  goal?: number;
  unit?: string;
  className?: string;
}) {
  const gradientId = React.useId();

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="label" {...AXIS} minTickGap={24} />
          <YAxis {...AXIS} width={40} tickFormatter={compactTick} />
          <Tooltip
            content={<ChartTooltip formatter={(value) => `${Math.round(value)}${unit}`} />}
            cursor={{ stroke: "hsl(var(--border))" }}
          />
          {goal !== undefined && goal > 0 && (
            <ReferenceLine
              y={goal}
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="4 4"
              strokeOpacity={0.6}
            />
          )}
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            connectNulls
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendLineChart({
  data,
  lines,
  height = 220,
  unit = "",
  className,
}: {
  data: SeriesPoint[];
  lines: Array<{ dataKey: string; name: string; color: string }>;
  height?: number;
  unit?: string;
  className?: string;
}) {
  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="label" {...AXIS} minTickGap={24} />
          <YAxis {...AXIS} width={40} tickFormatter={compactTick} />
          <Tooltip content={<ChartTooltip formatter={(value) => `${value}${unit}`} />} />
          {lines.map((line) => (
            <Line
              key={line.dataKey}
              type="monotone"
              dataKey={line.dataKey}
              name={line.name}
              stroke={line.color}
              strokeWidth={2}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryBarChart({
  data,
  dataKey,
  color = "hsl(var(--domain-workout))",
  height = 200,
  unit = "",
  /**
   * Value of `highlightField` to render at full opacity (everything else is
   * dimmed). Declarative rather than a render callback, because these charts
   * are rendered from Server Components and functions can't cross that
   * boundary.
   */
  highlight,
  highlightField = "day",
  className,
}: {
  data: SeriesPoint[];
  dataKey: string;
  color?: string;
  height?: number;
  unit?: string;
  highlight?: string;
  highlightField?: string;
  className?: string;
}) {
  const dimmed = highlight !== undefined;

  return (
    <div className={cn("w-full", className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="label" {...AXIS} minTickGap={8} />
          <YAxis {...AXIS} width={40} tickFormatter={compactTick} />
          <Tooltip
            content={<ChartTooltip formatter={(value) => `${Math.round(value)}${unit}`} />}
            cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
          />
          <Bar dataKey={dataKey} radius={[4, 4, 0, 0]} fill={color}>
            {dimmed &&
              data.map((point, index) => (
                <Cell
                  key={index}
                  fill={color}
                  fillOpacity={point[highlightField] === highlight ? 1 : 0.4}
                />
              ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MacroDonut({
  protein,
  carbs,
  fat,
  height = 180,
}: {
  protein: number;
  carbs: number;
  fat: number;
  height?: number;
}) {
  const data = [
    { name: "Protein", value: Math.max(0, protein), color: "hsl(var(--domain-health))" },
    { name: "Carbs", value: Math.max(0, carbs), color: "hsl(var(--domain-nutrition))" },
    { name: "Fat", value: Math.max(0, fat), color: "hsl(var(--domain-workout))" },
  ].filter((slice) => slice.value > 0);

  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground"
        style={{ height }}
      >
        No macros logged yet
      </div>
    );
  }

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={2}
            strokeWidth={0}
          >
            {data.map((slice) => (
              <Cell key={slice.name} fill={slice.color} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip formatter={(value) => `${Math.round(value)}g`} />} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
