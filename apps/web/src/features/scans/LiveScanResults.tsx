import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { productPageSchema, type ScanRecord } from "@better-buy/shared";
import { api, RequestFailure } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { faNumber, money } from "../dashboard/format";
import { ProductDestination } from "../deals/ProductDestination";

export function LiveScanResults({ scan }: { scan: ScanRecord }) {
  const client = useQueryClient();
  const results = useInfiniteQuery({
    queryKey: ["live-scan-results", scan.id],
    initialPageParam: null as string | null,
    enabled: scan.source === "okala" && scan.status === "running",
    refetchInterval: (query: { state: { error: Error | null } }) =>
      query.state.error instanceof RequestFailure &&
      query.state.error.code === "SCAN_NOT_PUBLISHED"
        ? false
        : 5000,
    retry: (count, error) =>
      !(
        error instanceof RequestFailure && error.code === "SCAN_NOT_PUBLISHED"
      ) && count < 2,
    staleTime: 0,
    queryFn: ({ signal, pageParam }) => {
      const params = new URLSearchParams({
        minDiscount: String(scan.threshold),
        sort: "discount",
      });
      if (pageParam) params.set("cursor", pageParam);
      return api(
        `/api/scans/${scan.id}/preview?${params}`,
        { signal },
        productPageSchema.parse
      ).catch((error: unknown) => {
        if (
          error instanceof RequestFailure &&
          error.code === "SCAN_NOT_PUBLISHED"
        ) {
          void client.invalidateQueries({ queryKey: ["scan", scan.id] });
          void client.invalidateQueries({ queryKey: ["scans"] });
        }
        throw error;
      });
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = [
    ...new Map(
      (results.data?.pages ?? [])
        .flatMap((page) => page.items)
        .map((item) => [item.key, item])
    ).values(),
  ];
  return (
    <section className="live-scan-results" aria-label="نتایج زنده اسکن">
      <header>
        <h2>تخفیف‌های واجد شرایط تا این لحظه</h2>
        <p>اسکن ادامه دارد؛ پیشنهادها تا پایان بررسی به‌روز می‌شوند.</p>
      </header>
      {results.data?.pages[0] && (
        <p role="status">
          {faNumber.format(results.data.pages[0].totalCount ?? 0)} کالای واجد
          شرایط
        </p>
      )}
      {scan.execution && (
        <p role="status">
          {faNumber.format(scan.execution.observedRows)} کالا از فهرست
          فروشگاه‌ها بررسی شده
        </p>
      )}
      {results.error && (
        <p role="status">تازه‌سازی پیشنهادها انجام نشد؛ دوباره تلاش می‌کنیم.</p>
      )}
      <div className="live-scan-items">
        {items.map((item) => (
          <article key={item.key}>
            <div>
              <h3>{item.title}</h3>
              <small>{item.bestCurrentOffer?.vendorTitle}</small>
            </div>
            <strong>{money(item.finalPriceRials, scan.source)}</strong>
            <span>{faNumber.format(item.discountRatio)}٪ تخفیف</span>
            <ProductDestination
              offer={item.bestCurrentOffer}
              source={scan.source}
            />
          </article>
        ))}
      </div>
      {results.hasNextPage && (
        <Button
          variant="outline"
          disabled={results.isFetching}
          onClick={() => void results.fetchNextPage()}
        >
          نمایش پیشنهادهای بیشتر
        </Button>
      )}
    </section>
  );
}
