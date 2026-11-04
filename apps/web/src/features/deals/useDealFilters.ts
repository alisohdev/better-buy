import { useState } from "react";
export function useDealFilters() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("wishlist");
  return { query, setQuery, sort, setSort, reset: () => setQuery("") };
}
