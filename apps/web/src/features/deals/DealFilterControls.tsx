"use client";

import { useId, useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { BottomSheet } from "@/components/beui/components/motion/bottom-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/beui/components/motion/select";
import {
  MultiSelect,
  MultiSelectContent,
  MultiSelectEmpty,
  MultiSelectInput,
  MultiSelectItem,
  MultiSelectList,
  MultiSelectTrigger,
  MultiSelectValue,
} from "@/components/beui/components/motion/multi-select";
import { Button } from "@/components/ui/button";
import { DiscountFields, DiscountSelect } from "../dashboard/DiscountSelect";
import { faNumber } from "../dashboard/format";
import type { DealFeed } from "./DealShelf";
import type { useDealFilters } from "./useDealFilters";

const sortOptions = [
  ["wishlist", "پیشنهادهای شخصی"],
  ["discount", "بیشترین تخفیف"],
  ["price", "کمترین قیمت"],
] as const;

const facetLabels = { removeValue: "حذف {label}", empty: "گزینه‌ای پیدا نشد." };

function SortPicker({
  filters,
}: {
  filters: ReturnType<typeof useDealFilters>;
}) {
  return (
    <Select
      className="sort-control"
      value={filters.sort}
      onValueChange={filters.setSort}
    >
      <span
        aria-hidden="true"
        className="mb-1.5 block text-xs font-medium text-muted-foreground min-[769px]:hidden"
      >
        مرتب‌سازی
      </span>
      <SelectTrigger
        aria-label="مرتب‌سازی"
        className="min-h-11 border-muted-foreground/55 bg-card"
      >
        <SelectValue
          placeholder={
            sortOptions.find(([value]) => value === filters.sort)?.[1]
          }
        />
      </SelectTrigger>
      <SelectContent className="z-30">
        {sortOptions.map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FacetPicker({
  label,
  searchPlaceholder,
  values,
  options,
  onChange,
  inline = false,
}: {
  label: string;
  searchPlaceholder: string;
  values: string[];
  options: string[];
  onChange: (values: string[]) => void;
  inline?: boolean;
}) {
  const choices = useMemo(
    () =>
      [...new Set([...options, ...values])].sort((a, b) =>
        a.localeCompare(b, "fa")
      ),
    [options, values]
  );
  return (
    <MultiSelect
      value={values}
      onValueChange={(next) => onChange([...next].sort())}
      labels={facetLabels}
      disabled={choices.length === 0}
      className="min-w-0"
    >
      <MultiSelectTrigger className="min-w-0 bg-card focus-within:ring-1 focus-within:ring-ring/50">
        <MultiSelectValue placeholder={null} />
        <MultiSelectInput
          aria-label={label}
          placeholder={searchPlaceholder}
          className="min-h-0 border-0 px-0 py-0"
        />
      </MultiSelectTrigger>
      <MultiSelectContent
        inline={inline}
        className={inline ? "mt-1" : "bg-card shadow-lg"}
      >
        <MultiSelectList ariaLabel={label} className="max-h-56">
          {choices.map((option) => (
            <MultiSelectItem key={option} value={option}>
              {option}
            </MultiSelectItem>
          ))}
          <MultiSelectEmpty />
        </MultiSelectList>
      </MultiSelectContent>
    </MultiSelect>
  );
}

export function DealFilterControls({
  filters,
  feeds,
  minDiscount,
  onMinDiscount,
}: {
  filters: ReturnType<typeof useDealFilters>;
  feeds: DealFeed[];
  minDiscount: number;
  onMinDiscount: (value: number) => void;
}) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const countId = useId();
  const stores = feeds.flatMap(({ ledger }) => ledger.facets?.stores ?? []);
  const categories = feeds.flatMap(
    ({ ledger }) => ledger.facets?.categories ?? []
  );
  const discount = {
    value: minDiscount,
    onChange: onMinDiscount,
  };
  const facets = (inline = false) => (
    <>
      <FacetPicker
        inline={inline}
        label="فروشگاه‌ها"
        searchPlaceholder="جست‌وجوی فروشگاه"
        values={filters.stores}
        options={stores}
        onChange={filters.setStores}
      />
      <FacetPicker
        inline={inline}
        label="دسته‌بندی‌ها"
        searchPlaceholder="جست‌وجوی دسته‌بندی"
        values={filters.categories}
        options={categories}
        onChange={filters.setCategories}
      />
    </>
  );
  const count =
    Number(minDiscount !== 40) +
    filters.stores.length +
    filters.categories.length;
  return (
    <>
      <div className="hidden min-[769px]:[display:contents]">
        <SortPicker filters={filters} />
        <div className="discount-control">
          <DiscountSelect {...discount} />
        </div>
        <div className="col-span-full grid grid-cols-2 gap-3">{facets()}</div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="results-filter-trigger min-[769px]:hidden"
        aria-label="فیلتر و مرتب‌سازی"
        aria-describedby={count > 0 ? countId : undefined}
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
      >
        <SlidersHorizontal aria-hidden="true" />
        {count > 0 && (
          <>
            <span
              key={count}
              className="results-filter-count"
              aria-hidden="true"
            >
              {faNumber.format(count)}
            </span>
            <span id={countId} className="sr-only">
              {faNumber.format(count)} فیلتر فعال
            </span>
          </>
        )}
      </Button>
      <BottomSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="فیلتر و مرتب‌سازی"
        snapPoints={[0.85]}
        labels={{ close: "بستن فیلترها" }}
      >
        <div className="grid gap-4 pt-2">
          <SortPicker filters={filters} />
          <DiscountFields {...discount} />
          {facets(true)}
          <Button type="button" onClick={() => setSheetOpen(false)}>
            نمایش نتایج
          </Button>
        </div>
      </BottomSheet>
    </>
  );
}
