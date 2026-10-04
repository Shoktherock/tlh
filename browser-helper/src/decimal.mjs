// Keep brokerage quantities and dollars out of floating-point arithmetic.
export function parseDecimal(value, { allowUnknown = false } = {}) {
  const input = String(value).trim();
  if (allowUnknown && /^(?:|--|N\/A|Unknown)$/i.test(input)) return null;
  if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(input)) {
    throw new Error('Invalid nonnegative decimal');
  }
  return input.replace(/[$,]/g, '').replace(/^0+(?=\d)/, '');
}

export function sumDecimals(values) {
  if (values.some((value) => value === null)) return null;
  const scale = Math.max(0, ...values.map((value) => (value.split('.')[1] ?? '').length));
  const sum = values.reduce((total, value) => {
    const [whole, fraction = ''] = value.split('.');
    return total + BigInt(whole + fraction.padEnd(scale, '0'));
  }, 0n);
  const digits = sum.toString().padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}

export function equalDecimals(a, b) {
  if (a === null || b === null) return false;
  const trim = (v) => v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
  return trim(a) === trim(b);
}
