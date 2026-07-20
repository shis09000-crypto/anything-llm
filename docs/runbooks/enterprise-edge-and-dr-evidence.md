# Enterprise edge and disaster-recovery evidence

Athena deliberately does not infer cloud controls from application code. A production release with `ATHENA_ENTERPRISE_RELEASE_GATE=true` must provide two Ed25519-signed evidence files:

- Edge: WAF, DDoS protection, DNSSEC, origin mTLS, bot management and hidden origin are verified within 30 days.
- Disaster recovery: cross-account immutable backup, cross-region copy, restore test and key-recovery test are verified within 90 days, with observed RPO/RTO.

Run `yarn security:evidence` in the release environment. Failure blocks startup/release; it never silently downgrades. Evidence signers must be independent of the application deployment role. Run `APP_ENV=development yarn security:drill --execute` for the local SQLite recovery rehearsal; that result does not replace cloud evidence.
