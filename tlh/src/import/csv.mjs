import {ReviewError} from '../review-error.mjs';
// Strict RFC-style CSV parsing shared by the TLH source adapters.
export function csvRows(text) {
  const result = []; let row = []; let field = ''; let quoted = false; let closed = false;
  const input = text.replace(/^\uFEFF/, '');
  const endField = () => { row.push(field); field = ''; closed = false; };
  const endRow = () => { endField(); if (row.some((cell) => cell.trim())) result.push(row); row = []; };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += ch;
    } else if (ch === ',') endField();
    else if (ch === '\n' || ch === '\r') { endRow(); if (ch === '\r' && input[i + 1] === '\n') i++; }
    else if (ch === '"') { if (field || closed) throw new ReviewError('Malformed CSV quote.'); quoted = true; }
    else { if (closed) throw new ReviewError('Text after a closing CSV quote.'); field += ch; }
  }
  if (quoted) throw new ReviewError('Unterminated CSV field.');
  if (row.length || field || closed) endRow();
  return result;
}
