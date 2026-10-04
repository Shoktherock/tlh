const timestamp = '2026-09-08T15:00:00Z';
const position = (symbol, quantity, total_basis) => ({ security: { symbol }, quantity, total_basis, currency: null,
  observed_at: timestamp, effective_at: null, effective_date: null, source_ref: `positions/${symbol}` });
const lot = (row_ref, quantity, total_basis) => ({ row_ref, broker_lot_id: null, acquisition_date: '2025-01-10', quantity, total_basis,
  cost_per_share: '100.00', broker_holding_period: 'Long Term', currency: null });
const positions = [position('EXAMPLE', '2', '200.00'), position('FUND', '0.5', '50.00')];
export const sampleSnapshot = {
  schema_version: '1.0', snapshot_id: 'synthetic-sample', producer: { name: 'synthetic-fixture', version: '1' }, broker: 'schwab',
  capture_started_at: timestamp, capture_completed_at: timestamp,
  accounts: [{ account_ref: 'synthetic-account', display_label: 'Sample account · synthetic', masked_identifier: '...123', account_type: 'unknown',
    positions_coverage: 'partial', positions, lot_scopes: positions.map((p, i) => ({ security: p.security, status: 'complete', observed_at: timestamp,
      effective_at: null, effective_date: null, source_ref: `lots/${p.security.symbol}`, completeness_evidence: { traversal: 'Synthetic full table', displayed_row_count: 2 },
      reported_totals: { quantity: p.quantity, total_basis: p.total_basis },
      lots: i ? [lot('row-1', '0.25', '25.00'), lot('row-2', '0.25', '25.00')] : [lot('row-1', '1', '100.00'), lot('row-2', '1', '100.00')],
      issues: [{ code: 'MISSING_LOT_FIELDS', severity: 'warning', message: 'Currency is unknown.', source_ref: 'lots' }] })), issues: [] }],
};
export const samplePositions = `"Positions for account Synthetic ...123 as of 05:51 PM ET, 2026/09/08"

"Symbol","Description","Qty (Quantity)","Cost Basis","Mkt Val (Market Value)","Asset Type",
"EXAMPLE","Example security","2","$200.00","$210.00","Equity",
"FUND","Example fund","0.5","$50.00","$45.00","ETF",
"000CVR000","Synthetic contingent right","3","$0.00","N/A","Equity",
"Cash & Cash Investments","--","--","--","$12.34","Cash and Money Market",
"Positions Total","","--","$250.00","$267.34","--",
`;
export const sampleFiles = () => [{ name: 'sample-helper.json', text: JSON.stringify(sampleSnapshot) }, { name: 'sample-positions.csv', text: samplePositions }];
