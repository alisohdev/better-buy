import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
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
  const ledger = useInfiniteQuery({
    queryKey: baseKey,
    initialPageParam: null as string | null,
    gcTime: 600_000,
    staleTime: 600_000,
    enabled: !busy && requestedScan?.status === "succeeded",
    queryFn: ({ signal, pageParam }) =>
      loadDealLedger(
        requestedScan!.id,
        signal,
        query,
        sort,
        pageParam,
        minDiscount
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const cachedPages = (id: string) =>
    client.getQueryData<InfiniteData<ProductPage>>([
      ...baseKey.slice(0, 4),
      id,
      ...baseKey.slice(5),
    ])?.pages ?? [];
  const currentPages = ledger.data?.pages ?? [];
  const prior =
    !currentPages.length && !selectedRunId
      ? contextual.find(
          (run) =>
            run.status === "succeeded" &&
            run.id !== requestedScan?.id &&
            cachedPages(run.id).length > 0
        )
      : undefined;
  const pages = currentPages.length
    ? currentPages
    : prior
      ? cachedPages(prior.id)
      : [];
  const groups = new Map(
    pages.flatMap((page) => page.items).map((group) => [group.key, group])
  );
  return {
    scan: prior ?? requestedScan,
    requestedScan,
    dealGroups: [...groups.values()],
    totalCount: pages[0]?.totalCount ?? null,
    results: ledger,
    hasResults: pages.length > 0,
    nextCursor: ledger.hasNextPage ? (pages.at(-1)?.nextCursor ?? null) : null,
    loadMore: () => {
      if (!busy && ledger.hasNextPage && !ledger.isFetching && !ledger.error)
        void ledger.fetchNextPage();
    },
  };
}
