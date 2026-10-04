# TLH

Source-only development export. No production readiness claim.

Run `npm ci`, `npm run test:tlh`, `npm test`, `npm run build:tlh`, and `npm run build:imports`. Local integration tests require Docker and Supabase CLI. Configure local credentials with `npm run supabase:configure`; never commit generated environment files.

Financial exports, credentials, databases, runtime artifacts, private notes, and the original Git history are excluded. Test fixtures are synthetic source-code literals. Never add real brokerage files to this repository.
