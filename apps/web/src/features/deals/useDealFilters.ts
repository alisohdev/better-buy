import { useState } from "react";
export type ProductFilters = {
  stores?: string[];
  categories?: string[];
};

export function appendProductFilters(
  params: URLSearchParams,
  filters: ProductFilters
) {
  for (const store of filters.stores ?? []) params.append("store", store);
  for (const category of filters.categories ?? [])
    params.append("category", category);
}

export function useDealFilters() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("wishlist");
  const [stores, setStores] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  return {
    stores,
    setStores,
    categories,
    setCategories,
    query,
    setQuery,
    sort,
    setSort,
    reset: () => setQuery(""),
  };
}
