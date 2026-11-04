/** Delete unpublished artifacts only after the scan is terminal, in its state batch. */
export function terminalScanArtifactStatements(
  db: D1Database,
  scanId: string,
  userId?: string
): D1PreparedStatement[] {
  const terminal = `EXISTS(SELECT 1 FROM scans WHERE id=? AND status IN ('failed','cancelled')${userId === undefined ? "" : " AND user_id=?"})`;
  const guard = userId === undefined ? [scanId] : [scanId, userId];
  return [
    ...[
      "deals",
      "scan_chunks",
      "scan_pages",
      "scan_observations",
      "scan_discovery",
      "scan_attempts",
      "scan_campaign_contributions",
      "scan_units",
    ].map((table) =>
      db
        .prepare(`DELETE FROM ${table} WHERE scan_id=? AND ${terminal}`)
        .bind(scanId, ...guard)
    ),
    ...[
      "saved_product_offers",
      "saved_products",
      "product_projection_scans",
    ].map((table) =>
      db
        .prepare(
          `DELETE FROM ${table} WHERE user_id=${userId === undefined ? "(SELECT user_id FROM scans WHERE id=?)" : "?"} AND scan_id=? AND ${terminal}`
        )
        .bind(userId ?? scanId, scanId, ...guard)
    ),
  ];
}
