import { readFile } from 'node:fs/promises';
import { validateSnapshot } from '../src/contract.mjs';
import { parseSchwabLotReference, compareSchwabReference } from '../src/verify-schwab-csv.mjs';

const [snapshotPath, referencePath, accountRef] = process.argv.slice(2);
if (!snapshotPath || !referencePath || !accountRef || process.argv.length !== 5) {
  console.error('Usage: npm run verify:schwab -- <snapshot.json> <Lot-Details.csv> <account_ref>');
  process.exitCode = 2;
} else {
  try {
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const validation = validateSnapshot(snapshot);
    if (!validation.valid) throw new Error('Snapshot failed contract validation. Review it in the helper before comparing.');
    const reference = parseSchwabLotReference(await readFile(referencePath, 'utf8'));
    const account = snapshot.accounts.find((entry) => entry.account_ref === accountRef);
    if (!account) throw new Error('Selected account reference is not in the snapshot.');
    const scopes = account.lot_scopes.filter((scope) => scope.security.symbol === reference.symbol);
    if (scopes.length !== 1) throw new Error('Reference security is absent or ambiguous in the selected account.');
    const result = compareSchwabReference(scopes[0], reference);
    // Diagnostics intentionally contain counts/codes only, never account IDs, holdings, or basis values.
    console.log(JSON.stringify(result, null, 2));
    console.log('Row comparison only. You must select matching accounts and compatible observation dates; this does not verify tax treatment.');
    process.exitCode = result.matches ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
