const text = { type: 'string', minLength: 1 };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' };
const object = (properties, optional = []) => ({
  type: 'object', properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
});
const array = (items) => ({ type: 'array', items });
const time = { type: 'string', format: 'date-time' };
const date = { type: 'string', format: 'date' };
const security = object({ symbol: text, broker_security_id: text, exchange: text }, ['broker_security_id', 'exchange']);
const timing = { observed_at: time, effective_at: nullable(time), effective_date: nullable(date) };
const currency = nullable({ type: 'string', pattern: '^[A-Z]{3}$' });
const issue = object({ code: text, severity: { enum: ['info', 'warning', 'error'] }, message: text, source_ref: text });
const position = object({ security, quantity: decimal, total_basis: nullable(decimal), currency, ...timing, source_ref: text });
const lot = object({
  row_ref: text, broker_lot_id: nullable(text), acquisition_date: nullable(date), quantity: decimal,
  total_basis: nullable(decimal), cost_per_share: nullable(decimal), broker_holding_period: nullable(text), currency,
  raw_acquisition_date: text,
}, ['raw_acquisition_date']);
const scope = object({
  security, status: { enum: ['complete', 'partial', 'failed', 'skipped'] }, ...timing,
  source_ref: text,
  completeness_evidence: object({
    traversal: text, displayed_row_count: { type: 'integer', minimum: 0 },
    pages_visited: { type: 'integer', minimum: 0 }, zero_position_confirmed: { type: 'boolean' },
  }, ['displayed_row_count', 'pages_visited', 'zero_position_confirmed']),
  reported_totals: object({ quantity: nullable(decimal), total_basis: nullable(decimal) }),
  lots: array(lot), issues: array(issue),
});
export const snapshotSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:tlh:brokerage-snapshot:1.0',
  title: 'Brokerage snapshot 1.0',
  ...object({
    schema_version: { const: '1.0' }, snapshot_id: text,
    producer: object({ name: text, version: text }), broker: text,
    capture_started_at: time, capture_completed_at: time,
    accounts: { ...array(object({
      account_ref: text, display_label: text, masked_identifier: nullable(text),
      account_type: { enum: ['taxable', 'traditional_ira', 'roth_ira', 'other', 'unknown'] },
      positions_coverage: { enum: ['complete', 'partial'] },
      positions: array(position), lot_scopes: array(scope), issues: array(issue),
    })), minItems: 1 },
  }),
};
