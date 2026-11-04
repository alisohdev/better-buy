import {
  PLANNING_AUDIT_KEY,
  type CampaignPlanningAudit,
  type PageCheckpoint,
  type Unit,
} from "./types";

/** Private audit facts. Never used to choose a campaign or mutate the feed. */
export async function readDurableComparison(
  db: D1Database,
  userId: string,
  scanId: string
) {
  const owned = await db
    .prepare(
      "SELECT e.manifest_frozen,s.status,json_extract(s.context_json,'$.coverage') AS coverage FROM scan_execution e JOIN scans s ON s.id=e.scan_id WHERE e.scan_id=? AND s.user_id=? AND e.execution_kind='workflow'"
    )
    .bind(scanId, userId)
    .first<{ manifest_frozen: number; status: string; coverage: string }>();
  if (!owned) return null;
  const auditRow = await db
    .prepare(
      "SELECT body_json FROM scan_discovery WHERE scan_id=? AND request_key=?"
    )
    .bind(scanId, PLANNING_AUDIT_KEY)
    .first<{ body_json: string }>();
  const planning = auditRow
    ? (JSON.parse(auditRow.body_json) as CampaignPlanningAudit)
    : null;
  const conflicts = await db
    .prepare(
      "SELECT deal_key FROM deals WHERE scan_id=? AND json_extract(facts_json,'$.conflictingPriceTuple')=1 ORDER BY deal_key LIMIT 100"
    )
    .bind(scanId)
    .all<{ deal_key: string }>();
  const conflictCount = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM deals WHERE scan_id=? AND json_extract(facts_json,'$.conflictingPriceTuple')=1"
    )
    .bind(scanId)
    .first<{ count: number }>();
  const units = await db
    .prepare(
      "SELECT unit_id,descriptor_json,terminal FROM scan_units WHERE scan_id=? ORDER BY unit_id"
    )
    .bind(scanId)
    .all<{ unit_id: string; descriptor_json: string; terminal: number }>();
  const pages = await db
    .prepare(
      "SELECT unit_id,metadata_json FROM scan_pages WHERE scan_id=? AND complete=1 ORDER BY unit_id,page"
    )
    .bind(scanId)
    .all<{ unit_id: string; metadata_json: string }>();
  const facts = new Map<
    string,
    Map<string, { eligible: boolean; excludedReason: string | null }>
  >();
  const rows = new Map<string, number>();
  const partialUnits = new Set<string>();
  for (const page of pages.results) {
    const checkpoint = JSON.parse(page.metadata_json) as PageCheckpoint;
    if (
      checkpoint.terminalEvidence === "bounded_partial_scope" ||
      checkpoint.terminalEvidence === "conflicting_campaign_rows"
    )
      partialUnits.add(page.unit_id);
    const identities = facts.get(page.unit_id) ?? new Map();
    for (const [identity, fact] of Object.entries(checkpoint.eligibility ?? {}))
      identities.set(identity, fact);
    facts.set(page.unit_id, identities);
    rows.set(page.unit_id, (rows.get(page.unit_id) ?? 0) + checkpoint.rowCount);
  }
  const baseline = new Set<string>();
  for (const row of units.results) {
    const unit = JSON.parse(row.descriptor_json) as Unit;
    if (unit.kind === "market_party")
      for (const [id, fact] of facts.get(row.unit_id) ?? [])
        if (fact.eligible) baseline.add(id);
  }
  const supplementary = new Set<string>();
  const accumulated = new Set(baseline);
  const campaigns = units.results.flatMap((row) => {
    const unit = JSON.parse(row.descriptor_json) as Unit;
    if (unit.kind !== "store_campaign") return [];
    const identities = facts.get(row.unit_id) ?? new Map();
    const eligible = [...identities]
      .filter(([, f]) => f.eligible)
      .map(([id]) => id)
      .sort();
    const excluded: Record<string, number> = {};
    for (const fact of identities.values())
      if (!fact.eligible && fact.excludedReason)
        excluded[fact.excludedReason] =
          (excluded[fact.excludedReason] ?? 0) + 1;
    eligible.forEach((id) => supplementary.add(id));
    const overlap = eligible.filter((id) => baseline.has(id)).length;
    const additional = eligible.filter((id) => !accumulated.has(id)).length;
    eligible.forEach((id) => accumulated.add(id));
    return [
      {
        unitId: unit.id,
        vendorId: unit.vendorId,
        collectionId: unit.collectionId,
        source: unit.source ?? "store_campaign",
        terminal: row.terminal === 1 && !partialUnits.has(row.unit_id),
        coverage:
          partialUnits.has(row.unit_id) || row.terminal !== 1
            ? "incomplete"
            : "complete",
        rawCount: rows.get(row.unit_id) ?? 0,
        uniqueCount: identities.size,
        qualifying: eligible.length,
        eligibleIdentities: eligible,
        overlap,
        additional,
        excluded,
        outcome:
          row.terminal !== 1 || partialUnits.has(row.unit_id)
            ? "incomplete"
            : eligible.length === 0
              ? "zero_eligible"
              : additional === 0
                ? "all_duplicates"
                : "net_new",
      },
    ];
  });
  const union = new Set([...baseline, ...supplementary]);
  return {
    scanId,
    frozen: owned.manifest_frozen === 1,
    complete:
      owned.status === "succeeded" &&
      owned.coverage === "complete" &&
      units.results.length > 0 &&
      units.results.every((u) => u.terminal === 1),
    baselineEligibleIdentities: [...baseline].sort(),
    baseline: baseline.size,
    supplementary: supplementary.size,
    overlap: [...supplementary].filter((id) => baseline.has(id)).length,
    union: union.size,
    additional: union.size - baseline.size,
    campaigns,
    planning,
    omitted: planning?.omitted ?? null,
    conflictingOfferCount: conflictCount?.count ?? 0,
    conflictingOfferIdentities: conflicts.results.map((r) => r.deal_key),
  };
}
