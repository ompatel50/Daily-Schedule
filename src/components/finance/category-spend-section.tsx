"use client";

import * as React from "react";
import { PieChart } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { SectionCard } from "@/components/shared/section-card";
import { formatMoney } from "@/lib/logic/finance";

export interface CategoryTotalView {
  category: string;
  label: string;
  total: number;
}

/** This month's spending by category — income and bookkeeping stay out. */
export function CategorySpendSection({
  categories,
  currency,
}: {
  categories: CategoryTotalView[];
  currency: string;
}) {
  return (
    <SectionCard
      title="This month by category"
      icon={PieChart}
      accent="text-domain-finance"
      description="Spending only — income, transfers and adjustments stay out"
    >
      {categories.length === 0 ? (
        <EmptyState icon={PieChart} title="No spending recorded yet" className="py-6" />
      ) : (
        <CategoryBars categories={categories} currency={currency} />
      )}
    </SectionCard>
  );
}

function CategoryBars({
  categories,
  currency,
}: {
  categories: CategoryTotalView[];
  currency: string;
}) {
  const max = Math.max(...categories.map((category) => category.total), 1);

  return (
    <div className="space-y-3">
      {categories.map((category) => (
        <div key={category.category}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{category.label}</span>
            <span className="tabular shrink-0 font-medium">
              {formatMoney(category.total, currency)}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-domain-finance"
              style={{ width: `${Math.max(2, (category.total / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
