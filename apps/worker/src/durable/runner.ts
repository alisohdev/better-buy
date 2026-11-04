import { DurableRepository } from "./repository";
import { collectPage, planUnits } from "./adapters";
import { providerReader } from "./provider";
import { CollectorError } from "../domain/failures";
import {
  DurableError,
  ScanEngineControl,
  type Steps,
  type WorkflowParams,
} from "./types";

export async function runDurableScan(
  params: WorkflowParams,
  options: {
    repository: DurableRepository;
    steps: Steps;
    fetcher?: typeof fetch;
    sharedOkalaOffersEnabled?: boolean;
    materialize: (userId: string, scanId: string) => Promise<void>;
  }
) {
  const { repository: repo, steps } = options;
  if (
    !params ||
    params.contractVersion !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      params.scanId
    ) ||
    Object.keys(params).some((k) => k !== "scanId" && k !== "contractVersion")
  )
    throw new DurableError(
      "INVALID_WORKFLOW_PAYLOAD",
      "Invalid workflow payload",
      400
    );
  const id = params.scanId;
  const initial = await repo.load(id);
  if (!initial)
    throw new DurableError("NOT_FOUND", "Update is unavailable", 404);
  if (
    initial.runtime.execution_kind !== "workflow" ||
    initial.runtime.contract_version !== params.contractVersion
  )
    throw new DurableError(
      "INVALID_WORKFLOW_PAYLOAD",
      "Unsupported workflow contract",
      400
    );
  if (initial.scan.status !== "queued" && initial.scan.status !== "running")
    return { scanId: id };
  try {
    await steps.do("scan-start", async () => {
      await repo.started(id);
      return { scanId: id };
    });
    const read = providerReader(
      repo,
      id,
      steps,
      options.fetcher,
      options.sharedOkalaOffersEnabled === true
    );
    const units = await planUnits(repo, await repo.check(id), read);
    for (const unit of units) {
      let previous = await repo.pages(id, unit.id);
      if (previous.at(-1)?.terminal) {
        await steps.do(`promote:${unit.id}`, async () => ({
          promoted: await repo.promoteCampaignContributions(id, unit),
        }));
        continue;
      }
      for (let page = previous.length; ; page++) {
        const old = await repo.checkpoint(id, unit.id, page);
        if (old) {
          previous.push(old);
          if (old.terminal) break;
          continue;
        }
        const data = await collectPage(
          await repo.check(id),
          unit,
          page,
          previous,
          read
        );
        if (
          data.rowCount > 0 &&
          previous.some((p) => p.fingerprint === data.fingerprint)
        )
          throw new DurableError(
            "INCOMPLETE_PAGINATION",
            "Repeated nonempty identity page"
          );
        const stageStarted = Date.now();
        await steps.do(`stage:${unit.id}:${page}`, async () => {
          const committed = await repo.checkpoint(id, unit.id, page);
          if (!committed) await repo.stage(id, unit, page, data);
          const checkpoint = await repo.checkpoint(id, unit.id, page);
          if (!checkpoint)
            throw new DurableError(
              "PERSISTENCE_ERROR",
              "Page checkpoint missing"
            );
          return {
            page,
            terminal: checkpoint.terminal,
            observedRows: checkpoint.rowCount,
          };
        });
        console.info("Durable page staged", {
          scanId: id,
          unitId: unit.id,
          adapter: unit.kind,
          page,
          observedRows: data.rowCount,
          eligibleOffers: data.offers.length,
          terminal: data.terminal,
          stagingMs: Date.now() - stageStarted,
        });
        previous = await repo.pages(id, unit.id);
        if (data.terminal) break;
      }
      await steps.do(`promote:${unit.id}`, async () => ({
        promoted: await repo.promoteCampaignContributions(id, unit),
      }));
    }
    await steps.do("materialize-products", async () => {
      const job = await repo.check(id);
      await repo.heartbeat(id, "publishing");
      await options.materialize(job.runtime.user_id, id);
      return { scanId: id };
    });
    await steps.do("publish", async () => {
      const current = await repo.load(id);
      if (current?.scan.status !== "succeeded") await repo.publish(id);
      return { scanId: id };
    });
    console.info("Durable scan completed", {
      scanId: id,
      contractVersion: 1,
      unitCount: units.length,
      coverage: (await repo.load(id))?.context.coverage,
    });
  } catch (error) {
    if (error instanceof ScanEngineControl) throw error;
    // Engine pause/termination and unexpected defects belong to the Workflow
    // engine. Reconciliation handles terminal errors; never fail a paused job.
    if (
      !(error instanceof DurableError) &&
      !(error instanceof CollectorError) &&
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
      )
    )
      throw error;
    const code =
      error instanceof DurableError || error instanceof CollectorError
        ? error.code
        : typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
          ? error.code
          : "PERSISTENCE_ERROR";
    const failureMessage = error instanceof Error ? error.message : undefined;
    let diagnostic: string | undefined;
    if (initial.scan.source === "snappmarket" && failureMessage) {
      for (const [prefix, category] of [
        ["Snapp campaign contract changed: ", "campaign_contract"],
        ["Snapp campaign coverage incomplete: ", "campaign_coverage"],
      ] as const) {
        if (!failureMessage.startsWith(prefix)) continue;
        const check = failureMessage.slice(prefix.length);
        if (check.startsWith("product: ")) {
          const allowedProductFields = new Set([
            "id",
            "vendor_id",
            "document_id",
            "title",
            "price",
            "discount",
            "discountRatio",
            "stock",
            "no_stock",
            "is_out_of_stock",
            "menu_category_title",
            "images",
            "images.main",
          ]);
          const fields = check
            .slice("product: ".length)
            .split(",")
            .map((field) =>
              field
                .split(".")
                .filter((part) => !/^\d+$/.test(part))
                .join(".")
            )
            .filter((field) => allowedProductFields.has(field))
            .slice(0, 5);
          diagnostic = fields.length
            ? `${category}.product_schema.${fields.join("_")}`
            : `${category}.product_check`;
        } else {
          const normalized = check.replaceAll("[]", " list");
          diagnostic = /^[A-Za-z0-9 _.\/()]{1,120}$/.test(normalized)
            ? `${category}.${normalized}`
            : `${category}.unclassified_check`;
        }
        break;
      }
      if (!diagnostic && code === "UPSTREAM_CHANGED") {
        diagnostic =
          failureMessage ===
          "Market Party vendor_id is not a positive numeric identity"
            ? "market_party.vendor_id_identity"
            : failureMessage ===
                "Market Party product.vendorId conflicts with vendor_id"
              ? "market_party.product_vendor_mismatch"
              : failureMessage.startsWith("ساختار پاسخ")
                ? "response.schema"
                : failureMessage.startsWith("پاسخ ") &&
                    failureMessage.includes(" JSON معتبر نبود")
                  ? "response.invalid_json"
                  : "upstream_changed.unclassified";
      }
      if (!diagnostic && code === "INCOMPLETE_PAGINATION")
        diagnostic = "pagination.incomplete_unclassified";
    }
    await steps.do("record-failure", async () => {
      await repo.fail(id, code);
      return { scanId: id, code };
    });
    console.info("[SCAN-FAILURE-DIAG]", {
      scanId: id,
      contractVersion: 1,
      source: initial.scan.source,
      code,
      ...(diagnostic ? { diagnostic } : {}),
      coverage: "incomplete",
    });
  }
  return { scanId: id };
}
