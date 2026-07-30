"use client";

/**
 * Lazy facade over the chart implementations.
 *
 * Recharts is ~100 kB of client JavaScript that six routes were paying for
 * on first load. Splitting it behind next/dynamic keeps route bundles lean:
 * the page paints immediately (charts show a quiet placeholder box) and the
 * chart chunk loads right after hydration. The implementations — and their
 * shared visual language — live unchanged in charts-impl.tsx.
 */
import dynamic from "next/dynamic";

import { Skeleton } from "@/components/ui/skeleton";

export type { SeriesPoint } from "./charts-impl";

const chartLoading = () => <Skeleton className="h-full min-h-24 w-full" />;

export const TrendAreaChart = dynamic(
  () => import("./charts-impl").then((mod) => mod.TrendAreaChart),
  { ssr: false, loading: chartLoading },
);

export const TrendLineChart = dynamic(
  () => import("./charts-impl").then((mod) => mod.TrendLineChart),
  { ssr: false, loading: chartLoading },
);

export const CategoryBarChart = dynamic(
  () => import("./charts-impl").then((mod) => mod.CategoryBarChart),
  { ssr: false, loading: chartLoading },
);

export const MacroDonut = dynamic(
  () => import("./charts-impl").then((mod) => mod.MacroDonut),
  { ssr: false, loading: chartLoading },
);
