import { mountHelper } from './panel.mjs';
import { createDemoAdapter } from './adapters/demo.mjs';
import { createSchwabAdapter } from './adapters/schwab.mjs';

if (location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname) && location.pathname.startsWith('/demo/')) {
  mountHelper(createDemoAdapter());
}
if (location.protocol === 'https:' && location.hostname === 'client.schwab.com' && location.pathname === '/app/accounts/positions/') {
  mountHelper(createSchwabAdapter(), { phase: '3', selectByDefault: false,
    guidance: 'Load all positions to scroll through the selected account, then choose securities and Collect lots. Coverage stays partial until verified against the account export. Close stops collection; reopen from the extension icon to review or retry. Files stay local.' });
}
