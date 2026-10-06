# Data deletion and recovery operations

The Accounts & sign-in page includes Data privacy & recovery. Deletion currently covers the user's entire financial workspace, not an individual brokerage account. It preserves sign-in and nonfinancial quota counters. The action requires a fresh password sign-in, preview token, acknowledgment, and exact confirmation phrase. The server derives ownership from the authenticated user.

Deletion blocks financial writes, disables scheduled alerts, removes private storage objects, verifies their metadata is gone, and atomically removes financial database rows. Failure leaves a retryable frozen workspace. Completed workspaces stay frozen until the user explicitly starts an empty workspace. Close old app tabs first. User-downloaded files, browser memory in other tabs, provider logs, and provider backup copies are outside this live-data deletion operation. Do not promise immediate removal from provider backups.

## Backup procedure

Before deletion or a production upgrade, download each relevant backup from Data privacy & recovery: holdings (includes accepted source text), activity, analysis, planning, and realized reports. Save them in encrypted off-site storage. Save staged source files separately: they are not part of accepted-history backups. These exports contain financial information and must never enter GitHub, CI artifacts, email, or public file sharing.

Restore to an empty synthetic destination first, using the matching existing Recovery, Transactions, Analysis inputs, Planning recovery, and Realized reports flows. Review mappings before acceptance. Confirm holdings, cash, historical timestamps, and original-file checksums. Never reset or restore the production database as a test.

Supabase-managed database backups exclude Storage object bytes. For disaster recovery, an operator must retain BOTH database backups and private storage objects, with encryption and a defined retention period. Free projects need an external backup process; paid backup features must be verified in the provider dashboard. No paid backup feature, off-site destination, or automated schedule is configured by this code change. Reapply deletion requests before exposing data from an older provider backup.

## Log review

Application handlers do not log request bodies, auth tokens, uploaded originals, or database exception text. Do not enable CLI debug output, HTTP body capture, or verbose SDK logging on production. Validate provider logs using a unique synthetic canary, checking Edge Function, API gateway, auth and database logs for its absence. Log status, duration and coarse error category only. Restrict log access and configure retention in each provider. Source checks cannot prove the provider's current log retention or redaction settings; confirm them in the dashboard before approving real-data usage.
