import { parseDecimal } from './decimal.mjs';

export function schwabDate(raw) {
  const value = String(raw ?? '').trim();
  if (/^(?:|--|N\/A|Unknown)$/i.test(value)) return { value: null, unknown: true };
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return { value: null, unknown: false };
  const [, month, day, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return { value: null, unknown: false };
  return { value: iso, unknown: false };
}

export function schwabDecimal(raw, allowUnknown = false) {
  return parseDecimal(raw, { allowUnknown });
}
