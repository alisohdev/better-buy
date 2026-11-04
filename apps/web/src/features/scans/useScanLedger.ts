import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  productPageSchema,
  type ProductPage,
  type ScanRecord,
} from "@better-buy/shared";
import type { DealSource } from "../dashboard/types";
import { api, RequestFailure } from "../../lib/api";
export async function loadDealLedger(
  scanId: string,
  signal?: AbortSignal,
  query = "",
  sort = "discount",
  cursor: string | null = null,
  minDiscount = 15
) {
  const params = new URLSearchParams({
    page: "1",
    q: query,
    sort,
    minDiscount: String(minDiscount),
  });
  if (cursor) params.set("cursor", cursor);
  const page = await api(
    `/api/scans/${scanId}/products?${params}`,
    { signal },
    productPageSchema.parse
  );
  if (
    page.items.some(
      (group) => group.state !== "no_longer_present" && group.scanId !== scanId
    )
  )
    throw new RequestFailure(
      "invalid-response",
      "پاسخ نتیجه با اسکن انتخاب‌شده مطابقت ندارد."
    );
  return page;
}
export function useScanLedger({
  busy,
  selected,
  scans,
  source,
  selectedRunId,
  coordinateRevision,
  query = "",
  sort = "discount",
  wishlistRevision = 0,
  cartRevision = "",
  minDiscount = 15,
}: {
  busy: boolean;
  selected: string;
  scans: ScanRecord[];
  source: DealSource;
  selectedRunId: string | null;
  coordinateRevision: number;
  query?: string;
  sort?: string;
  wishlistRevision?: number;
  cartRevision?: string;
  minDiscount?: number;
}) {
  const client = useQueryClient();
  const contextual = scans
    .filter(
      (run) =>
        run.locationId === selected &&
        run.source === source &&
        (run.id === selectedRunId ||
          run.context?.location.revision === coordinateRevision ||
          (!run.context && coordinateRevision === 1))
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const requestedScan =
    (selectedRunId
      ? contextual.find((run) => run.id === selectedRunId)
      : null) ??
    contextual.find((run) => run.status === "succeeded") ??
    null;
  const baseKey = [
    "ledger",
    selected,
    coordinateRevision,
    source,
    requestedScan?.id ?? null,
    query,
    sort,
    wishlistRevision,
    cartRevision,
    minDiscount,
  ];
  const contextKey = JSON.stringify(baseKey);
  const [paging, setPaging] = useState<{
    context: string;
    cursors: (string | null)[];
  }>({ context: "", cursors: [null] });
  const cursors = paging.context === contextKey ? paging.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const ledger = useQuery<ProductPage>({
    queryKey: [...baseKey, cursor],
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey;
      return key &&
        [0, 1, 2, 3, 4, 5, 6, 9].every((index) => key[index] === baseKey[index])
        ? previous
        : undefined;
    },
    gcTime: 600_000,
    staleTime: 600_000,
    enabled: !busy && requestedScan?.status === "succeeded",
    queryFn: async ({ signal }) => {
      const page = await loadDealLedger(
        requestedScan!.id,
        signal,
        query,
        sort,
        cursor,
        minDiscount
      );
      // Retain the loaded window until the next read succeeds. A failed read
      // must not discard any visible rows merely to make room for its page.
      if (cursors.length > 20)
        client.removeQueries({
          queryKey: [...baseKey, cursors[0]],
          exact: true,
        });
      return page;
    },
  });
  const pages = cursors
    .map((value) =>
      value === cursor
        ? ledger.data
        : client.getQueryData<ProductPage>([...baseKey, value])
    )
    .filter((page): page is ProductPage => !!page);
  // Preserve the previous matching cached snapshot with its own label if a new
  // successful scan has an independent result-read failure. No foreign context.
  const cachedPages = (id: string) => {
    const readKey = [
      "ledger",
      selected,
      coordinateRevision,
      source,
      id,
      query,
      sort,
    ];
    const cached = client
      .getQueriesData<ProductPage>({ queryKey: readKey })
      .filter(
        ([key, page]) =>
          !!page &&
          key.length === baseKey.length + 1 &&
          key[baseKey.length - 1] === minDiscount
      )
      .sort(
        ([a], [b]) =>
          (client.getQueryState(b)?.dataUpdatedAt ?? 0) -
          (client.getQueryState(a)?.dataUpdatedAt ?? 0)
      );
    const newestKey = cached[0]?.[0].slice(0, -1);
    if (!newestKey) return [];
    return cached
      .filter(([key]) =>
        newestKey.every((value, index) => key[index] === value)
      )
      .map(([, page]) => page)
      .filter((page): page is ProductPage => !!page);
  };
  const currentPages = pages.length
    ? pages
    : requestedScan
      ? cachedPages(requestedScan.id)
      : [];
  const prior =
    !currentPages.length && !selectedRunId
      ? contextual.find(
          (run) =>
            run.status === "succeeded" &&
            run.id !== requestedScan?.id &&
            cachedPages(run.id).length > 0
        )
      : undefined;
  const fallback = prior ? cachedPages(prior.id) : [];
  const visiblePages = currentPages.length ? currentPages : fallback;
  const groups = new Map(
    visiblePages
      .flatMap((page) => page.items)
      .map((group) => [group.key, group])
  );
  const nextCursor = ledger.data?.nextCursor ?? null;
  return {
    scan: prior ?? requestedScan,
    requestedScan,
    dealGroups: [...groups.values()],
    results: ledger,
    hasResults: visiblePages.length > 0,
    nextCursor,
    hasPreviousPages: cursors.length > 20,
    loadMore: () => {
      if (!nextCursor || ledger.isFetching || cursors.includes(nextCursor))
        return;
      setPaging({
        context: contextKey,
        cursors: [...cursors.slice(-20), nextCursor],
      });
    },
    firstPage: () => setPaging({ context: contextKey, cursors: [null] }),
  };
}
