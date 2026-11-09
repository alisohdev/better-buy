"use client";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  isWithinTehranBoundary,
  type CartSource,
  type ScanRecord,
} from "@better-buy/shared";
import { AppHeader } from "./AppHeader";
import { AppIcon, ProviderMark } from "./AppIcon";
import { ReadNotice } from "./Primitives";
import { faNumber, sourceLabel } from "./format";
import { useDashboardData } from "./useDashboardData";
import {
  ScanControls,
  digikalaSupermarketEnabled,
} from "../scans/ScanControls";
import { HistoryPanel } from "../scans/HistoryPanel";
import { useScanLedger } from "../scans/useScanLedger";
import { useScanPolling, isActiveScan } from "../scans/useScanPolling";
import { useStartScan } from "../scans/useStartScan";
import { LocationManager } from "../locations/LocationManager";
import { DealShelf, type DealFeed } from "../deals/DealShelf";
import { useDealFilters } from "../deals/useDealFilters";
import type { DealSource } from "./types";
import { ScanFeedback } from "../scans/ScanFeedback";
import { ProviderCart, CartWriteNotice } from "../carts/ProviderCart";
import { useProviderCart } from "../carts/useProviderCart";
import { WishlistPanel } from "../alerts/WishlistPanel";
import { useWishlistQuery } from "../alerts/useAlerts";
import { AdminDashboard } from "../admin/AdminDashboard";
import { useAdminAccess } from "../admin/useAdminAnalytics";
import { useSearchAnalytics } from "../admin/useAnalytics";

export function Dashboard() {
  const data = useDashboardData();
  const wishlist = useWishlistQuery();
  const adminAccess = useAdminAccess();
  const [view, setView] = useState<"deals" | "history" | "admin">("deals");
  const [workspaceSection, setWorkspaceSection] = useState<"offers" | "scan">(
    "offers"
  );
  const [cartOpen, setCartOpen] = useState(false);

  const [wishlistOpen, setWishlistOpen] = useState(false);
  const overlayReturnFocus = useRef<HTMLElement | null>(null);
  const mobileCartTrigger = useRef<HTMLButtonElement | null>(null);
  const openOverlay = (kind: "wishlist" | "inbox") => {
    overlayReturnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (kind === "wishlist") setWishlistOpen(true);
    else window.location.assign("/?page=notifications");
  };
  const restoreOverlayFocus = () =>
    requestAnimationFrame(() => overlayReturnFocus.current?.focus());
  const [providers, setProviders] = useState<DealSource[]>([
    "snappmarket",
    "okala",
  ]);
  const [minDiscount, setMinDiscount] = useState(40);
  const [scanAttemptBaseIds, setScanAttemptBaseIds] =
    useState<Set<string> | null>(null);
  const scanLinkHandled = useRef(false);
  const [scanLinkError, setScanLinkError] = useState(false);
  const [selection, setSelection] = useState<{
    source: DealSource | null;
    runId: string | null;
  }>({ source: null, runId: null });
  const [locationDialog, setLocationDialog] = useState<
    "list" | "create" | null
  >(null);
  useEffect(() => {
    if (scanLinkHandled.current || !data.scansQuery.isSuccess) return;
    scanLinkHandled.current = true;
    const scanId = new URLSearchParams(window.location.search).get("scan");
    if (!scanId) return;
    const run = data.scans.find((record) => record.id === scanId);
    if (!run) {
      setScanLinkError(true);
      return;
    }
    data.setSelected(run.locationId);
    setSelection({ source: run.source, runId: run.id });
    setView("deals");
  }, [data.scans, data.scansQuery.isSuccess, data.setSelected]);
  const selectedLocation = data.locations.find(
    (location) => location.id === data.selected
  );
  const coordinateRevision = selectedLocation?.coordinateRevision ?? 1;
  const latestCompatible = (source: DealSource) =>
    data.scans
      .filter(
        (run) =>
          run.locationId === data.selected &&
          run.source === source &&
          run.status === "succeeded" &&
          !!selectedLocation &&
          run.context?.location.revision === coordinateRevision &&
          run.context.location.latitude === selectedLocation.latitude &&
          run.context.location.longitude === selectedLocation.longitude
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const latestSnapp = latestCompatible("snappmarket");
  const latestOkala = latestCompatible("okala");
  const snappCart = useProviderCart({
    source: "snappmarket",
    locationId: data.selected,
    scanId: latestSnapp?.id ?? null,
    coordinateRevision,
  });
  const okalaCart = useProviderCart({
    source: "okala",
    locationId: data.selected,
    scanId: latestOkala?.id ?? null,
    coordinateRevision,
  });
  const digikalaCart = useProviderCart({
    source: "digikalajet",
    locationId: data.selected,
    scanId: latestCompatible("digikalajet")?.id ?? null,
    coordinateRevision,
  });
  const activeSnappRecord =
    data.scans.find(
      (run) => run.source === "snappmarket" && isActiveScan(run)
    ) ?? null;
  const activeOkalaRecord =
    data.scans.find((run) => run.source === "okala" && isActiveScan(run)) ??
    null;
  const snappPolling = useScanPolling(activeSnappRecord);
  const okalaPolling = useScanPolling(activeOkalaRecord);
  const activeSnapp = isActiveScan(snappPolling.data)
    ? snappPolling.data
    : activeSnappRecord;
  const activeOkala = isActiveScan(okalaPolling.data)
    ? okalaPolling.data
    : activeOkalaRecord;
  const activeDigikalaRecord = digikalaSupermarketEnabled
    ? (data.scans.find(
        (run) => run.source === "digikalajet" && isActiveScan(run)
      ) ?? null)
    : null;
  const digikalaPolling = useScanPolling(activeDigikalaRecord);
  const activeDigikala = isActiveScan(digikalaPolling.data)
    ? digikalaPolling.data
    : activeDigikalaRecord;
  const snappStart = useStartScan({
    locationId: data.selected,
    source: "snappmarket",
    threshold: 15,
    mode: "partial",
  });
  const okalaStart = useStartScan({
    locationId: data.selected,
    source: "okala",
    threshold: 15,
    mode: "partial",
  });
  const digikalaStart = useStartScan({
    locationId: data.selected,
    source: "digikalajet",
    threshold: 15,
    mode: "partial",
  });
  const filters = useDealFilters();
  const historical = !!selection.runId;
  useSearchAnalytics({
    query: filters.query,
    source:
      historical && selection.source
        ? selection.source
        : providers.length === 1
          ? (providers[0] ?? "all")
          : "all",
  });
  const ledgerOptions = {
    wishlistRevision: wishlist.dataUpdatedAt,
    cartRevision: [
      ...(snappCart.cart.data?.lines ?? []).map(
        (line) => `snappmarket:${line.key}:${line.quantity}`
      ),
      ...(okalaCart.cart.data?.lines ?? []).map(
        (line) => `okala:${line.key}:${line.quantity}`
      ),
      ...(digikalaCart.cart.data?.lines ?? []).map(
        (line) => `digikalajet:${line.key}:${line.quantity}`
      ),
    ]
      .sort()
      .join("|"),
    selected: data.selected,
    scans: data.scans,
    query: filters.query,
    sort: filters.sort,
    coordinateRevision,
    minDiscount,
  };
  const snappLedger = useScanLedger({
    ...ledgerOptions,
    source: "snappmarket",
    selectedRunId: selection.source === "snappmarket" ? selection.runId : null,
    busy:
      data.busy ||
      (historical
        ? selection.source !== "snappmarket"
        : !providers.includes("snappmarket")),
  });
  const okalaLedger = useScanLedger({
    ...ledgerOptions,
    source: "okala",
    selectedRunId: selection.source === "okala" ? selection.runId : null,
    busy:
      data.busy ||
      (historical
        ? selection.source !== "okala"
        : !providers.includes("okala")),
  });
  const jetLedger = useScanLedger({
    ...ledgerOptions,
    source: "digikalajet",
    selectedRunId: selection.source === "digikalajet" ? selection.runId : null,
    busy:
      data.busy ||
      (historical
        ? selection.source !== "digikalajet"
        : !digikalaSupermarketEnabled || !providers.includes("digikalajet")),
  });
  const allFeeds: DealFeed[] = [
    {
      source: "snappmarket",
      ledger: snappLedger,
      cart: snappCart,
      latestAvailableScan: latestSnapp,
    },
    {
      source: "okala",
      ledger: okalaLedger,
      cart: okalaCart,
      latestAvailableScan: latestOkala,
    },
    {
      source: "digikalajet",
      ledger: jetLedger,
      cart: digikalaCart,
      latestAvailableScan: latestCompatible("digikalajet"),
    },
  ];
  const feeds = allFeeds.filter((feed) =>
    historical
      ? feed.source === selection.source
      : (feed.source !== "digikalajet" || digikalaSupermarketEnabled) &&
        providers.includes(feed.source)
  );
  const valid =
    !!selectedLocation &&
    isWithinTehranBoundary(
      selectedLocation.latitude,
      selectedLocation.longitude
    );
  const submitting =
    snappStart.submitting || okalaStart.submitting || digikalaStart.submitting;
  const unresolved =
    snappStart.unresolved || okalaStart.unresolved || digikalaStart.unresolved;
  const active = !!activeSnapp || !!activeOkala || !!activeDigikala;
  const blocked =
    submitting ||
    unresolved ||
    active ||
    !valid ||
    data.busy ||
    !data.locationsQuery.data ||
    !data.scansQuery.data;
  const changeLocation = (id: string) => {
    data.setSelected(id);
    setSelection({ source: null, runId: null });
  };
  const goHome = () => {
    setView("deals");
    setWorkspaceSection("offers");
    setSelection({ source: null, runId: null });
  };
  const openRun = (run: ScanRecord) => {
    data.setSelected(run.locationId);
    setSelection({ source: run.source, runId: run.id });
    setView("deals");
    setWorkspaceSection("offers");
  };
  const newScan = () => {
    if (blocked) return;
    setScanAttemptBaseIds(new Set(data.scans.map((run) => run.id)));
    setSelection({ source: null, runId: null });
    setWorkspaceSection("scan");
    for (const provider of providers)
      (provider === "okala"
        ? okalaStart
        : provider === "digikalajet"
          ? digikalaStart
          : snappStart
      ).start();
  };
  const latestSuccessfulRuns = providers.flatMap((provider) => {
    const run =
      provider === "okala"
        ? latestOkala
        : provider === "digikalajet"
          ? latestCompatible("digikalajet")
          : latestSnapp;
    return run ? [run] : [];
  });
  const freshSuccessfulRuns = scanAttemptBaseIds
    ? latestSuccessfulRuns.filter((run) => !scanAttemptBaseIds.has(run.id))
    : [];
  const scanPageStage =
    active || submitting
      ? "running"
      : scanAttemptBaseIds && freshSuccessfulRuns.length > 0
        ? "complete"
        : "ready";
  const completedProductCount = freshSuccessfulRuns.reduce(
    (total, run) => total + run.productCount,
    0
  );
  const activeRuns = [activeSnapp, activeOkala, activeDigikala].filter(
    (run): run is ScanRecord => run !== null
  );
  const progressCompleted = activeRuns.reduce(
    (total, run) => total + (run.execution?.completedUnits ?? 0),
    0
  );
  const progressTotal = activeRuns.reduce(
    (total, run) => total + (run.execution?.totalUnits ?? 0),
    0
  );
  const scanProgressPercent = progressTotal
    ? Math.min(100, Math.round((progressCompleted / progressTotal) * 100))
    : null;
  const openCart = (_source: CartSource) => {
    setCartOpen(true);
  };
  return (
    <main className="app-shell">
      {scanLinkError && (
        <ReadNotice title="اسکن این پیوند در حساب شما در دسترس نیست">
          از تاریخچه اسکن یا صندوق اعلان‌ها، نتیجه دیگری را انتخاب کنید.
        </ReadNotice>
      )}
      <AppHeader
        onLocations={() => setLocationDialog("list")}
        onHistory={() => setView("history")}
        onHome={goHome}
        onWishlist={() => openOverlay("wishlist")}
        onNotifications={() => openOverlay("inbox")}
        onAdmin={adminAccess.data?.allowed ? () => setView("admin") : undefined}
        view={view}
        actions={
          <>
            <ProviderCart
              locationId={data.selected}
              locationName={selectedLocation?.name ?? "موقعیت انتخاب‌شده"}
              carts={[
                { source: "snappmarket", controller: snappCart },
                { source: "okala", controller: okalaCart },
                { source: "digikalajet", controller: digikalaCart },
              ]}
              open={cartOpen}
              onOpenChange={(open) => {
                setCartOpen(open);
                if (!open && window.matchMedia("(max-width: 768px)").matches)
                  requestAnimationFrame(() =>
                    mobileCartTrigger.current?.focus()
                  );
              }}
            />
          </>
        }
        feedback={
          <>
            <CartWriteNotice controller={snappCart} visible={!cartOpen} />
            <CartWriteNotice controller={okalaCart} visible={!cartOpen} />
          </>
        }
      />
      <WishlistPanel
        locations={data.locations}
        locationsReady={data.locationsQuery.isSuccess}
        open={wishlistOpen}
        onOpenChange={(open) => {
          setWishlistOpen(open);
          if (!open) restoreOverlayFocus();
        }}
        trigger={<button type="button" hidden aria-label="علاقه‌مندی‌ها" />}
      />
      <div
        className={`workspace ${view === "deals" && workspaceSection === "scan" ? "workspace-scan" : ""}`}
      >
        {view === "admin" && adminAccess.data?.allowed ? (
          <AdminDashboard onClose={goHome} />
        ) : (
          <>
            {view === "deals" && (
              <nav className="workspace-switcher" aria-label="بخش‌های خرید">
                <button
                  type="button"
                  aria-current={
                    workspaceSection === "offers" ? "page" : undefined
                  }
                  onClick={() => setWorkspaceSection("offers")}
                >
                  <AppIcon name="home" />
                  پیشنهادها
                </button>
                <button
                  type="button"
                  aria-current={
                    workspaceSection === "scan" ? "page" : undefined
                  }
                  onClick={() => {
                    if (historical) setSelection({ source: null, runId: null });
                    setWorkspaceSection("scan");
                  }}
                >
                  <AppIcon name="scan" />
                  اسکن تخفیف‌ها
                  {active && (
                    <span
                      className="scan-active-dot"
                      aria-label="در حال اسکن"
                    />
                  )}
                </button>
              </nav>
            )}
            {view === "history" ? (
              <>
                <Button
                  variant="outline"
                  className="back-button"
                  onClick={goHome}
                >
                  بازگشت به پیشنهادها
                </Button>
                <HistoryPanel
                  scans={data.scans}
                  onOpen={openRun}
                  blocked={blocked}
                  onRetry={(run) => {
                    if (blocked) return;
                    setScanAttemptBaseIds(
                      new Set(data.scans.map((item) => item.id))
                    );
                    data.setSelected(run.locationId);
                    setSelection({ source: null, runId: null });
                    setProviders([run.source]);
                    setView("deals");
                    setWorkspaceSection("scan");
                    (run.source === "okala"
                      ? okalaStart
                      : run.source === "digikalajet"
                        ? digikalaStart
                        : snappStart
                    ).start({
                      locationId: run.locationId,
                      source: run.source,
                      threshold: 15,
                      mode: run.mode,
                    });
                  }}
                />
              </>
            ) : data.needsLocation ? (
              <section className="empty onboarding">
                <h1>موقعیت تحویل را اضافه کنید</h1>
                <p>
                  روی نقشه نشانی تحویل را پیدا کنید تا پیشنهادهای نزدیک شما را
                  بررسی کنیم.
                </p>
                <Button onClick={() => setLocationDialog("create")}>
                  افزودن موقعیت تحویل
                </Button>
                <p className="muted">
                  اسنپ‌مارکت و اکالا بدون ورود به فروشگاه بررسی می‌شوند.
                </p>
              </section>
            ) : workspaceSection === "scan" ? (
              <section
                className="scan-page"
                data-stage={scanPageStage}
                aria-labelledby="scan-page-title"
              >
                <header className="scan-flow-header">
                  <Button
                    variant="ghost"
                    className="scan-back-button"
                    aria-label="بازگشت به پیشنهادها"
                    onClick={goHome}
                  >
                    <AppIcon name="back" />
                  </Button>
                  <div className="scan-flow-title">
                    <h1 id="scan-page-title">اسکن تخفیف‌ها</h1>
                    <p>پیشنهادهای فروشگاه‌های انتخاب‌شده را پیدا کنید.</p>
                  </div>
                  <span className="scan-header-icon" aria-hidden="true">
                    <AppIcon name="scan" />
                  </span>
                </header>
                {scanPageStage === "ready" && (
                  <ScanControls
                    locations={data.locations}
                    selected={data.selected}
                    selectedProviders={providers}
                    minDiscount={minDiscount}
                    blocked={blocked}
                    submitting={submitting}
                    hasSnapshot={feeds.some((feed) => !!feed.ledger.scan)}
                    historical={historical}
                    onLocation={changeLocation}
                    onToggleProvider={(provider) => {
                      setSelection({ source: null, runId: null });
                      setProviders((previous) =>
                        previous.includes(provider)
                          ? previous.length > 1
                            ? previous.filter((item) => item !== provider)
                            : previous
                          : [...previous, provider]
                      );
                    }}
                    onMinDiscount={setMinDiscount}
                    onStart={newScan}
                    onLive={goHome}
                  />
                )}
                {scanPageStage === "running" && (
                  <section
                    className="scan-stage scan-stage-running"
                    role="status"
                    aria-live="polite"
                  >
                    <div
                      className="scan-progress-orbit"
                      style={
                        {
                          "--scan-progress": `${scanProgressPercent ?? 14}%`,
                        } as CSSProperties
                      }
                      data-indeterminate={scanProgressPercent === null}
                      aria-hidden="true"
                    >
                      <span className="scan-progress-orbit-inner">
                        <AppIcon name="basket" />
                      </span>
                    </div>
                    <h2>در حال اسکن فروشگاه‌ها…</h2>
                    <p>
                      بررسی تخفیف‌ها برای{" "}
                      {selectedLocation?.name ?? "موقعیت انتخاب‌شده"}
                    </p>
                    <div className="scan-stage-progress">
                      <strong>
                        {scanProgressPercent === null
                          ? "…"
                          : `${faNumber.format(scanProgressPercent)}٪`}
                      </strong>
                      <span>پیشرفت اسکن</span>
                    </div>
                    <div
                      className="scan-progress-track scan-stage-track"
                      role="progressbar"
                      aria-label="پیشرفت اسکن"
                      aria-valuemin={0}
                      aria-valuemax={progressTotal || undefined}
                      aria-valuenow={
                        progressTotal ? progressCompleted : undefined
                      }
                    >
                      <span
                        style={{
                          width: `${scanProgressPercent ?? 12}%`,
                        }}
                      />
                    </div>
                  </section>
                )}
                {scanPageStage === "complete" && (
                  <section
                    className="scan-stage scan-stage-complete"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="scan-success-burst" aria-hidden="true">
                      <span className="scan-success-mark">
                        <AppIcon name="check" />
                      </span>
                    </div>
                    <h2>اسکن با موفقیت انجام شد</h2>
                    <p>
                      {faNumber.format(completedProductCount)} کالا بررسی شد.
                    </p>
                    <div className="scan-complete-providers">
                      {freshSuccessfulRuns.map((run) => (
                        <span className="scan-complete-provider" key={run.id}>
                          <ProviderMark source={run.source} />
                          <span>{sourceLabel(run.source)}</span>
                          <strong>{faNumber.format(run.productCount)}</strong>
                        </span>
                      ))}
                    </div>
                    <div className="scan-stage-actions">
                      <Button
                        className="primary"
                        onClick={() => setWorkspaceSection("offers")}
                      >
                        <AppIcon name="list" />
                        مشاهده نتایج
                      </Button>
                      <Button variant="outline" onClick={newScan}>
                        <AppIcon name="scan" />
                        اسکن دوباره
                      </Button>
                    </div>
                  </section>
                )}
                {data.locationsQuery.error && (
                  <ReadNotice
                    title="موقعیت‌ها دریافت نشدند"
                    retry={() => void data.locationsQuery.refetch()}
                    busy={data.locationsQuery.isFetching}
                  >
                    {data.locationsQuery.data
                      ? "موقعیت‌های ذخیره‌شده نمایش داده می‌شوند؛ تازه‌سازی انجام نشد."
                      : "برای انتخاب موقعیت، دریافت دوباره را امتحان کنید."}
                  </ReadNotice>
                )}
                {data.scansQuery.error && (
                  <ReadNotice
                    title="تاریخچه اسکن دریافت نشد"
                    retry={() => void data.scansQuery.refetch()}
                    busy={data.scansQuery.isFetching}
                  >
                    وضعیت اسکن‌های حساب را دوباره بررسی کنید.
                  </ReadNotice>
                )}
                {!valid && !data.busy && !data.locationsQuery.error && (
                  <ReadNotice title="موقعیت خارج از محدوده خدمات است">
                    فعلاً اسکن برای موقعیت‌های داخل تهران در دسترس است. موقعیت
                    دیگری را از فهرست بالا انتخاب کنید.
                  </ReadNotice>
                )}
                <div className="scan-feedback-list">
                  <ScanFeedback
                    active={activeSnapp ?? null}
                    polling={snappPolling}
                    start={snappStart}
                    locations={data.locations}
                    onOpenContext={(run) => {
                      data.setSelected(run.locationId);
                      setSelection({ source: null, runId: null });
                      setView("deals");
                      setWorkspaceSection("offers");
                    }}
                  />
                  <ScanFeedback
                    active={activeOkala ?? null}
                    polling={okalaPolling}
                    start={okalaStart}
                    locations={data.locations}
                    onOpenContext={(run) => {
                      data.setSelected(run.locationId);
                      setSelection({ source: null, runId: null });
                      setView("deals");
                      setWorkspaceSection("offers");
                    }}
                  />
                  {digikalaSupermarketEnabled && (
                    <ScanFeedback
                      active={activeDigikala ?? null}
                      polling={digikalaPolling}
                      start={digikalaStart}
                      locations={data.locations}
                      onOpenContext={(run) => {
                        data.setSelected(run.locationId);
                        setSelection({ source: null, runId: null });
                        setView("deals");
                        setWorkspaceSection("offers");
                      }}
                    />
                  )}
                </div>
              </section>
            ) : !valid && !data.busy && !data.locationsQuery.error ? (
              <ReadNotice title="موقعیت خارج از محدوده خدمات است">
                فعلاً موقعیت‌های داخل تهران پشتیبانی می‌شوند. موقعیت را از منوی
                برنامه ویرایش کنید.
              </ReadNotice>
            ) : (
              <>
                {feeds.map((feed) => {
                  const attempt = data.scans
                    .filter(
                      (run) =>
                        run.locationId === data.selected &&
                        run.source === feed.source
                    )
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
                  return !historical &&
                    (attempt?.status === "failed" ||
                      attempt?.status === "cancelled") ? (
                    <ReadNotice
                      key={feed.source}
                      title={`${sourceLabel(feed.source)} · ${attempt.status === "failed" ? "اسکن ناموفق بود" : "به‌روزرسانی لغو شد"}`}
                    >
                      {attempt.errorMessage ??
                        "نتیجه‌ای از این به‌روزرسانی منتشر نشده است."}
                      {feed.ledger.scan &&
                        " نتیجه موفق قبلی همچنان نمایش داده می‌شود."}
                    </ReadNotice>
                  ) : null;
                })}
                <section
                  className="results-discount-filter"
                  aria-label="فیلتر نتیجه‌ها بر اساس تخفیف"
                >
                  <div>
                    <strong>حداقل تخفیف نتیجه‌ها</strong>
                    <p>نتایج ذخیره‌شده فیلتر می‌شوند؛ اسکن دوباره لازم نیست.</p>
                  </div>
                  <label htmlFor="results-discount-filter">
                    <output htmlFor="results-discount-filter">
                      {faNumber.format(minDiscount)}٪
                    </output>
                    <input
                      id="results-discount-filter"
                      type="range"
                      min={15}
                      max={80}
                      step={1}
                      value={minDiscount}
                      aria-label="حداقل تخفیف نتیجه‌ها"
                      aria-valuetext={`${faNumber.format(minDiscount)} درصد و بیشتر`}
                      onChange={(event) =>
                        setMinDiscount(Number(event.target.value))
                      }
                    />
                  </label>
                </section>
                <DealShelf
                  filters={filters}
                  feeds={feeds}
                  minDiscount={minDiscount}
                  busy={data.busy}
                  historical={historical}
                  onOpenCart={openCart}
                />
              </>
            )}
          </>
        )}
      </div>
      <nav className="mobile-bottom-nav" aria-label="دسترسی سریع">
        <button
          ref={mobileCartTrigger}
          type="button"
          aria-label="سبد خرید"
          onClick={() => setCartOpen(true)}
        >
          <AppIcon name="cart" />
          <small>سبد خرید</small>
        </button>
        <button type="button" onClick={() => openOverlay("wishlist")}>
          <AppIcon name="heart" />
          <small>علاقه‌مندی‌ها</small>
        </button>
        <button type="button" onClick={() => openOverlay("inbox")}>
          <AppIcon name="bell" />
          <small>اعلان‌ها</small>
        </button>
        <button
          type="button"
          aria-current={view === "history" ? "page" : undefined}
          onClick={() => setView("history")}
        >
          <AppIcon name="history" />
          <small>تاریخچه</small>
        </button>
      </nav>
      {locationDialog && (
        <LocationManager
          locations={data.locations}
          initialView={locationDialog}
          onClose={() => setLocationDialog(null)}
          onSaved={(saved) => {
            if (saved) changeLocation(saved.id);
            const firstCollection =
              saved && data.locations.length === 0 && !active && !unresolved;
            void data.load().then(() => {
              if (firstCollection && saved) {
                setSelection({ source: null, runId: null });
                setView("deals");
                setWorkspaceSection("scan");
                for (const provider of providers)
                  (provider === "okala"
                    ? okalaStart
                    : provider === "digikalajet"
                      ? digikalaStart
                      : snappStart
                  ).start({
                    locationId: saved.id,
                    threshold: 15,
                  });
              }
            });
          }}
        />
      )}
    </main>
  );
}
