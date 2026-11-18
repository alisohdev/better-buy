"use client";
import "../scans/scan-feedback.css";
import { StickyScanProgress } from "../scans/StickyScanProgress";
import { useVisitor } from "../guest/VisitorProvider";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import {
  isWithinTehranBoundary,
  type CartSource,
  type ScanRecord,
} from "@better-buy/shared";
import "./shopping-workspace.css";
import { TutorialProvider, TutorialHint, useTutorial } from "./Tutorial";
import { initialWorkspace } from "./initialWorkspace";
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
import { useScanProgress as calculateScanProgress } from "../scans/progress";
import { scanFailureMessage } from "../scans/scanFailureMessage";
import { ScanFeedback } from "../scans/ScanFeedback";
import { ProviderCart, CartWriteNotice } from "../carts/ProviderCart";
import { useProviderCart } from "../carts/useProviderCart";
import { WishlistPanel } from "../alerts/WishlistPanel";
import { useWishlistQuery } from "../alerts/useAlerts";
import { AdminDashboard } from "../admin/AdminDashboard";
import { useAdminAccess } from "../admin/useAdminAnalytics";
import { useSearchAnalytics } from "../admin/useAnalytics";

export function Dashboard() {
  return (
    <TutorialProvider>
      <DashboardContent />
    </TutorialProvider>
  );
}

function DashboardContent() {
  const tutorial = useTutorial();
  const visitor = useVisitor();
  const data = useDashboardData();
  const wishlist = useWishlistQuery();
  const adminAccess = useAdminAccess();
  const [view, setView] = useState<"deals" | "history" | "admin">("deals");
  const [dismissedScanIds, setDismissedScanIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("better-buy:dismissed-scan-banners") ?? "[]"
      );
      return Array.isArray(saved)
        ? saved.filter((id): id is string => typeof id === "string").slice(-100)
        : [];
    } catch {
      return [];
    }
  });
  const revealedLiveScans = useRef(new Set<string>());
  const [workspaceSection, setWorkspaceSection] = useState<"offers" | "scan">(
    "scan"
  );
  const [cartOpen, setCartOpen] = useState(false);

  const [wishlistOpen, setWishlistOpen] = useState(false);
  const overlayReturnFocus = useRef<HTMLElement | null>(null);
  const mobileCartTrigger = useRef<HTMLButtonElement | null>(null);
  const openOverlay = (kind: "wishlist" | "inbox") => {
    if (
      !visitor.requireAccount(
        kind === "wishlist" ? "علاقه‌مندی‌ها" : "اعلان‌ها"
      )
    )
      return;
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
    ...(digikalaSupermarketEnabled ? ["digikalajet" as const] : []),
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
    setWorkspaceSection("offers");
  }, [data.scans, data.scansQuery.isSuccess, data.setSelected]);
  useEffect(() => {
    if (tutorial.step === "location") {
      setView("deals");
      setCartOpen(false);
      setWishlistOpen(false);
    }
  }, [tutorial.step]);
  useEffect(() => {
    const target = tutorial.navigation?.step;
    if (!target) return;
    setView("deals");
    if (target === "map" || target === "details") setLocationDialog("create");
    else {
      setLocationDialog(null);
      setWorkspaceSection(
        target === "location" || target === "done" ? "offers" : "scan"
      );
    }
  }, [tutorial.navigation]);
  const selectedLocation = data.locations.find(
    (location) => location.id === data.selected
  );
  const entryHandled = useRef(false);
  useEffect(() => {
    if (
      entryHandled.current ||
      !data.locationsQuery.isSuccess ||
      !data.scansQuery.isSuccess
    )
      return;
    entryHandled.current = true;
    if (new URLSearchParams(window.location.search).has("scan")) return;
    setWorkspaceSection(initialWorkspace(data.scans, selectedLocation));
  }, [
    data.locationsQuery.isSuccess,
    data.scansQuery.isSuccess,
    data.scans,
    selectedLocation,
  ]);
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
    setScanAttemptBaseIds(null);
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
    tutorial.send("scan-started");
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
  useEffect(() => {
    if (tutorial.step !== "waiting") return;
    if (scanPageStage === "complete") tutorial.send("scan-succeeded");
    else if (
      !active &&
      !submitting &&
      !unresolved &&
      scanAttemptBaseIds &&
      (data.scans.some(
        (run) =>
          !scanAttemptBaseIds.has(run.id) &&
          (run.status === "failed" || run.status === "cancelled")
      ) ||
        snappStart.error ||
        okalaStart.error ||
        digikalaStart.error)
    )
      tutorial.send("scan-failed");
  }, [
    tutorial,
    scanPageStage,
    active,
    submitting,
    unresolved,
    scanAttemptBaseIds,
    data.scans,
    snappStart.error,
    okalaStart.error,
    digikalaStart.error,
  ]);
  const completedProductCount = freshSuccessfulRuns.reduce(
    (total, run) => total + run.productCount,
    0
  );
  const activeRuns = [activeSnapp, activeOkala, activeDigikala].filter(
    (run): run is ScanRecord => run !== null
  );
  const completedBannerRuns = providers.flatMap((source) => {
    const latest = data.scans
      .filter(
        (run) =>
          run.source === source &&
          run.locationId === data.selected &&
          (!run.context || run.context.location.revision === coordinateRevision)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest?.status === "succeeded" &&
      !dismissedScanIds.includes(latest.id)
      ? [latest]
      : [];
  });
  const dismissCompletedBanner = () => {
    const next = [
      ...new Set([
        ...dismissedScanIds,
        ...completedBannerRuns.map((run) => run.id),
      ]),
    ].slice(-100);
    setDismissedScanIds(next);
    try {
      localStorage.setItem(
        "better-buy:dismissed-scan-banners",
        JSON.stringify(next)
      );
    } catch {
      /* Dismissal still works for this page. */
    }
  };
  const progressCompleted = activeRuns.reduce(
    (total, run) => total + (run.execution?.completedUnits ?? 0),
    0
  );
  const progressTotal = activeRuns.reduce(
    (total, run) => total + (run.execution?.totalUnits ?? 0),
    0
  );
  const requestAttempts = activeRuns.reduce(
    (total, run) => total + (run.execution?.attemptCount ?? 0),
    0
  );
  const observedRows = activeRuns.reduce(
    (total, run) => total + (run.execution?.observedRows ?? 0),
    0
  );
  const scanProgressPercent = calculateScanProgress(
    workspaceSection === "scan" ? activeRuns : [],
    data.scans
  );
  useEffect(() => {
    for (const feed of feeds) {
      const run = feed.ledger.scan;
      if (
        run?.status === "running" &&
        feed.ledger.dealGroups.length &&
        !revealedLiveScans.current.has(run.id)
      ) {
        revealedLiveScans.current.add(run.id);
        setWorkspaceSection("offers");
      }
    }
  }, [feeds]);

  useEffect(() => {
    if (
      scanAttemptBaseIds &&
      freshSuccessfulRuns.length > 0 &&
      activeRuns.length > 0
    )
      setWorkspaceSection("offers");
  }, [scanAttemptBaseIds, freshSuccessfulRuns.length, activeRuns.length]);
  const openCart = (_source: CartSource) => {
    if (!visitor.requireAccount("نگهداری سبد خرید")) return;
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
        onLocations={() =>
          setLocationDialog(tutorial.step === "location" ? "create" : "list")
        }
        onHistory={() => setView("history")}
        onHome={goHome}
        onScan={() => {
          setView("deals");
          setSelection({ source: null, runId: null });
          setWorkspaceSection("scan");
        }}
        scanDisabled={active || submitting}
        scanning={view === "deals" && workspaceSection === "scan"}
        wishlistOpen={wishlistOpen}
        cartOpen={cartOpen}
        locationsOpen={!!locationDialog}
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
                if (open && !visitor.requireAccount("نگهداری سبد خرید")) return;
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
      {data.scansQuery.error && (
        <div className="scan-history-recovery">
          <ReadNotice
            title="تاریخچه اسکن دریافت نشد"
            retry={() => void data.scansQuery.refetch()}
            busy={data.scansQuery.isFetching}
          >
            <span>{data.scansQuery.error.message}</span>
            <span>
              {" "}
              برای جلوگیری از اسکن هم‌زمان، ابتدا وضعیت اسکن‌های حساب را دریافت
              می‌کنیم.
            </span>
          </ReadNotice>
        </div>
      )}
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
        {!active && !submitting && completedBannerRuns.length > 0 && (
          <StickyScanProgress
            runs={[]}
            history={data.scans}
            completedRuns={completedBannerRuns}
            onDismiss={dismissCompletedBanner}
          />
        )}
        {view === "admin" && adminAccess.data?.allowed ? (
          <AdminDashboard onClose={goHome} />
        ) : (
          <>
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
                <TutorialHint at="location" />
                <Button
                  data-tutorial-target={tutorial.step === "location"}
                  onClick={() => setLocationDialog("create")}
                >
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
                {tutorial.step === "location" && (
                  <div>
                    <TutorialHint at="location" />
                    <Button
                      data-tutorial-target
                      onClick={() => setLocationDialog("create")}
                    >
                      افزودن موقعیت تحویل
                    </Button>
                  </div>
                )}
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
                {scanPageStage !== "running" && (
                  <ScanControls
                    locations={data.locations}
                    selected={data.selected}
                    selectedProviders={providers}
                    blocked={blocked}
                    submitting={submitting}
                    hasSnapshot={feeds.some((feed) => !!feed.ledger.scan)}
                    historical={historical}
                    onLocation={changeLocation}
                    onAddLocation={() => setLocationDialog("create")}
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
                    onStart={newScan}
                    onLive={goHome}
                  />
                )}
                <TutorialHint at="waiting" />
                <TutorialHint at="results" />
                {scanPageStage === "running" && (
                  <section
                    className="scan-stage scan-stage-running"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="scan-activity-mark" aria-hidden="true">
                      <AppIcon name="scan" />
                    </div>
                    <h2>در حال اسکن فروشگاه‌ها…</h2>
                    <p>
                      بررسی تخفیف‌ها برای{" "}
                      {selectedLocation?.name ?? "موقعیت انتخاب‌شده"}
                    </p>
                    <div className="scan-stage-progress">
                      <strong>
                        {scanProgressPercent === null
                          ? "در حال بررسی…"
                          : `${faNumber.format(scanProgressPercent)}٪`}
                      </strong>
                      <span>پیشرفت تقریبی اسکن</span>
                    </div>
                    <div
                      className="scan-progress-track scan-stage-track"
                      data-indeterminate={scanProgressPercent === null}
                      role="progressbar"
                      aria-label="پیشرفت تقریبی اسکن"
                      aria-valuemin={0}
                      aria-valuemax={
                        scanProgressPercent === null ? undefined : 100
                      }
                      aria-valuenow={scanProgressPercent ?? undefined}
                    >
                      <span
                        style={{
                          transform: `scaleX(${(scanProgressPercent ?? 0) / 100})`,
                        }}
                      />
                    </div>
                    <p className="scan-observation-count">
                      {progressTotal > 0
                        ? scanProgressPercent === null
                          ? `${faNumber.format(progressCompleted)} بخش بررسی شده · بررسی ادامه دارد`
                          : `${faNumber.format(progressCompleted)} از ${faNumber.format(progressTotal)} بخش بررسی شده`
                        : requestAttempts > 0
                          ? `${faNumber.format(requestAttempts)} تلاش برای دریافت اطلاعات فروشگاه‌ها`
                          : "در انتظار دریافت اطلاعات فروشگاه‌ها"}
                    </p>
                    {progressTotal > 0 && requestAttempts > 0 && (
                      <p className="scan-observation-count">
                        {faNumber.format(requestAttempts)} تلاش برای دریافت
                        اطلاعات فروشگاه‌ها
                      </p>
                    )}
                    {observedRows > 0 && (
                      <p className="scan-observation-count">
                        {faNumber.format(observedRows)} رکورد کالا بررسی شده
                      </p>
                    )}
                  </section>
                )}
              </section>
            ) : !valid && !data.busy && !data.locationsQuery.error ? (
              <ReadNotice title="موقعیت خارج از محدوده خدمات است">
                فعلاً موقعیت‌های داخل تهران پشتیبانی می‌شوند. موقعیت را از منوی
                برنامه ویرایش کنید.
              </ReadNotice>
            ) : (
              <>
                <StickyScanProgress
                  history={data.scans}
                  runs={activeRuns.filter(
                    (run) => run.locationId === data.selected
                  )}
                />
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
                      {attempt.status === "cancelled" && attempt.dealCount > 0
                        ? "اسکن متوقف شد؛ پیشنهادهای دریافت‌شده از همین اسکن نمایش داده می‌شوند."
                        : scanFailureMessage(attempt)}
                      {feed.ledger.scan?.status === "succeeded" &&
                        " نتیجه موفق قبلی همچنان نمایش داده می‌شود."}
                    </ReadNotice>
                  ) : null;
                })}
                <TutorialHint at="location" />
                {tutorial.step === "scan" && (
                  <div>
                    <TutorialHint at="scan" />
                    <Button onClick={() => setWorkspaceSection("scan")}>
                      رفتن به تنظیمات اسکن
                    </Button>
                  </div>
                )}
                <header className="shopping-page-heading">
                  <div>
                    <h1>پیشنهادهای امروز</h1>
                    <button
                      type="button"
                      className="shopping-location"
                      data-tutorial-target={tutorial.step === "location"}
                      onClick={() =>
                        setLocationDialog(
                          tutorial.step === "location" ? "create" : "list"
                        )
                      }
                    >
                      <AppIcon name="location" />
                      <span>
                        {selectedLocation?.name ?? "انتخاب موقعیت تحویل"}
                      </span>
                      <svg
                        className="shopping-location-chevron"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="m7 10 5 5 5-5"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                  <Button
                    className="shopping-scan-action"
                    disabled={active || submitting}
                    onClick={() => setWorkspaceSection("scan")}
                  >
                    <AppIcon name="scan" />
                    اسکن تخفیف‌ها
                  </Button>
                </header>
                <DealShelf
                  filters={filters}
                  feeds={feeds}
                  minDiscount={minDiscount}
                  onMinDiscount={setMinDiscount}
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
          onClick={() => {
            if (visitor.requireAccount("نگهداری سبد خرید")) setCartOpen(true);
          }}
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
          onClose={() => {
            tutorial.send("location-closed");
            setLocationDialog(null);
          }}
          onSaved={(saved) => {
            if (saved) changeLocation(saved.id);
            if (saved && tutorial.step === "details") {
              tutorial.send("location-saved");
              setLocationDialog(null);
              setView("deals");
              setWorkspaceSection("scan");
            }
            if (saved && data.locations.length === 0) {
              setSelection({ source: null, runId: null });
              setView("deals");
              setWorkspaceSection("scan");
            }
            void data.load();
          }}
        />
      )}
    </main>
  );
}
